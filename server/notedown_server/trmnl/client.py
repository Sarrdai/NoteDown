"""The TRMNL plugin's NoteDown client (backlog #49): an identity with one device that reads the files shared with
it, speaking the same API as the app (docs/server-api.md) and checking what it gets the same way. It never writes a
file. Everything it holds comes from one 16-byte secret, which the plugin keeps only sealed
(docs/sync-and-sharing.md → "TRMNL"); `app/js/core/crypto.js` is the app's side of the same formats."""

import hashlib
import json
import os
import zlib
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlencode

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.mlkem import MLKEM768PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .. import auth
from ..protocol import (b64u, canonical, entry_hash, file_binding, from_b64u, invitation_message, key_id, verify_chain,
                        verify_signature)

SECRET_BYTES = 16
NAME = "TRMNL"            # the name the invitation suggests for the contact
KEM_CT_BYTES = 1088       # ML-KEM-768 ciphertext
HYBRID_HEAD = 1 + 32 + KEM_CT_BYTES
SIGNED_HEAD = 1 + 4 + 16 + 64


class ClientError(Exception):
    """The server answered something the client can't use: an error status or data that doesn't check out."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def hkdf(ikm: bytes, salt: bytes | None, info: bytes, length: int = 32) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def raw(public_key) -> bytes:
    return public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)


class DeviceKeys:
    """A device's Ed25519, X25519 and ML-KEM-768 key pairs from their seeds (32, 32 and 64 bytes)."""

    def __init__(self, kind: str, sign_seed: bytes, enc_seed: bytes, kem_seed: bytes):
        self.kind = kind
        self.sign_key = Ed25519PrivateKey.from_private_bytes(sign_seed)
        self.enc_key = X25519PrivateKey.from_private_bytes(enc_seed)
        self.kem_key = MLKEM768PrivateKey.from_seed_bytes(kem_seed)
        self.sign, self.enc, self.kem = raw(self.sign_key.public_key()), raw(self.enc_key.public_key()), \
            raw(self.kem_key.public_key())
        self.id = key_id(self.sign)

    def record(self) -> dict:
        return {"id": self.id, "kind": self.kind, "sign": b64u(self.sign), "enc": b64u(self.enc), "kem": b64u(self.kem)}


class Keys:
    """Everything of the plugin's identity, derived from its secret: the identity key and the recovery device as
    from a recovery key (docs/server-api.md → "Keys"), so the secret is one, and the one device it reads with."""

    def __init__(self, secret: bytes):
        if len(secret) != SECRET_BYTES:
            raise ValueError("the secret has 16 bytes")
        self.secret = secret
        derive = lambda info, length=32: hkdf(secret, b"NoteDown", info, length)   # noqa: E731
        self.identity_key = Ed25519PrivateKey.from_private_bytes(derive(b"identity-sign"))
        self.identity_public = raw(self.identity_key.public_key())
        self.identity = key_id(self.identity_public)
        self.recovery = DeviceKeys("recovery", derive(b"recovery-sign"), derive(b"recovery-enc"),
                                   derive(b"recovery-kem", 64))
        self.device = DeviceKeys("device", derive(b"trmnl-device-sign"), derive(b"trmnl-device-enc"),
                                 derive(b"trmnl-device-kem", 64))

    @classmethod
    def new(cls) -> "Keys":
        return cls(os.urandom(SECRET_BYTES))

    def genesis(self) -> list[dict]:
        """The first entries of the device list: the device, then the recovery device, both signed by the identity."""
        entries: list[dict] = []
        for device in (self.device, self.recovery):
            body = {"identity": self.identity, "seq": len(entries), "prev": entry_hash(entries[-1]) if entries else "",
                    "op": "add", "device": device.record(), "signer": "identity"}
            entries.append({**body, "sig": b64u(self.identity_key.sign(canonical(body)))})
        return entries

    def invitation_secret(self, number: int) -> bytes:
        """The secret of the plugin's `number`th invitation: derived, so the plugin needn't store it."""
        return hkdf(self.secret, b"NoteDown", f"trmnl-invite-{number}".encode(), SECRET_BYTES)


def invitation_id(secret: bytes) -> str:
    return b64u(hashlib.sha256(secret).digest()[:16])


def invitation_link(web: str, identity: str, secret: bytes, server: str) -> str:
    """The invitation link the app opens (docs/server-api.md → "Contacts and invitations"); `kind=display` tells the
    app this contact is a display that shows what is shared with it unencrypted."""
    query = urlencode({"v": "1", "id": identity, "s": b64u(secret), "name": NAME, "srv": server, "kind": "display"})
    return f"{web.rstrip('/')}/invite/#{query}"


# --- the formats the app writes --------------------------------------------------------------------------------------

def open_sealed(label: bytes, text: str, device: DeviceKeys) -> bytes:
    """Opens a hybrid seal (X25519 + ML-KEM-768) made for `device`: a wrapped file key or a contact card."""
    data = from_b64u(text)
    if len(data) < HYBRID_HEAD + 12 + 16 or data[0] != 0x01:
        raise ClientError("not a hybrid seal")
    ephemeral, kem_ct = data[1:33], data[33:HYBRID_HEAD]
    shared_x = device.enc_key.exchange(X25519PublicKey.from_public_bytes(ephemeral))
    shared_kem = device.kem_key.decapsulate(kem_ct)
    transcript = hashlib.sha256(ephemeral + device.enc + kem_ct + device.kem).digest()
    key = hkdf(shared_x + shared_kem, None, label + b"-pq" + transcript)
    nonce = data[HYBRID_HEAD:HYBRID_HEAD + 12]
    return AESGCM(key).decrypt(nonce, data[HYBRID_HEAD + 12:], None)


@dataclass
class SignedWrap:
    gen: int
    signer: str
    sig: bytes
    wrap: str

    @classmethod
    def read(cls, text: str) -> "SignedWrap":
        data = from_b64u(text)
        if len(data) <= SIGNED_HEAD or data[0] != 0x02:
            raise ClientError("the wrapped key isn't signed")
        return cls(int.from_bytes(data[1:5], "big"), b64u(data[5:21]), data[21:SIGNED_HEAD], b64u(data[SIGNED_HEAD:]))

    def statement(self, file_id: str, to: str) -> bytes:
        return canonical({"label": "notedown-wrap-sig", "file": file_id, "to": to, "gen": self.gen,
                          "signer": self.signer, "wrap": self.wrap})


def decrypt_file(file_key: bytes, ciphertext: str, file_id: str, version: int) -> str:
    """A file's text: AES-GCM bound to the file and its version (a file uploaded before that opens without; the
    plugin only shows it), then the padding stripped and the DEFLATE stream inflated (docs/server-api.md → "Keys")."""
    data = from_b64u(ciphertext)
    try:
        body = AESGCM(file_key).decrypt(data[:12], data[12:], file_binding(file_id, version))
    except InvalidTag:
        body = AESGCM(file_key).decrypt(data[:12], data[12:], None)
    body = body.rstrip(b"\x00")
    if body.endswith(b"\x80"):
        body = body[:-1]
    if body[:1] == b"\x01":
        body = zlib.decompress(body[1:], -15)
    return body.decode("utf-8")


# --- talking to the server -----------------------------------------------------------------------------------------

# send(method, path, json body or None, headers) → (status, parsed JSON or None)
Send = Callable[[str, str, Any, dict], tuple[int, Any]]


class Client:
    """The plugin's identity talking to the sync server through `send`; `host` is the server's host as `send`
    reaches it, which every sign-in names (docs/server-api.md → "Authentication")."""

    def __init__(self, send: Send, keys: Keys, host: str):
        self.send, self.keys, self.host = send, keys, host
        self.token: str | None = None

    def call(self, method: str, path: str, body: Any = None, ok: tuple[int, ...] = (200,)) -> Any:
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        status, data = self.send(method, path, body, headers)
        if status not in ok:
            detail = data.get("detail") if isinstance(data, dict) else None
            raise ClientError(f"{method} {path}: {status} {detail or ''}".strip(), status)
        return data

    def register(self) -> None:
        self.call("POST", "/v1/identities", {"identity_key": b64u(self.keys.identity_public),
                                             "entries": self.keys.genesis()}, ok=(201,))

    def sign_in(self) -> None:
        challenge = self.call("GET", "/v1/auth/challenge")["challenge"]
        message = auth.auth_message(self.host, self.keys.identity, self.keys.device.id, challenge)
        sig = b64u(self.keys.device.sign_key.sign(message))
        self.token = self.call("POST", "/v1/auth/token", {"identity": self.keys.identity, "device": self.keys.device.id,
                                                          "challenge": challenge, "sig": sig})["token"]

    def invite(self, number: int) -> str:
        """Creates the `number`th link invitation (open 7 days); returns its ID."""
        iid = invitation_id(self.keys.invitation_secret(number))
        sig = b64u(self.keys.device.sign_key.sign(invitation_message(iid)))
        self.call("POST", "/v1/invitations", {"id": iid, "kind": "link", "sig": sig}, ok=(201, 409))
        return iid

    def invitations(self) -> list[dict]:
        return self.call("GET", "/v1/invitations")["invitations"]

    def answer_requests(self, accept: str | None) -> str | None:
        """Confirms the request on invitation `accept` when its card checks out (as the app does: our device signed
        the invitation, the card opens, names the requester and holds the invitation's secret) and declines every
        other request. Returns the identity confirmed, or None."""
        confirmed = None
        for inv in self.invitations():
            request = inv.get("request")
            if not request:
                continue
            if inv["id"] == accept and request.get("card") and self.card_matches(inv, request):
                confirmed = self.call("POST", "/v1/contacts", {"invitation": inv["id"]}, ok=(201,))["identity"]
            else:
                self.call("DELETE", f"/v1/invitations/{inv['id']}", ok=(204,))
        return confirmed

    def card_matches(self, inv: dict, request: dict) -> bool:
        if inv["device"] != self.keys.device.id or not verify_signature(
                self.keys.device.sign, from_b64u(inv["sig"], 64), invitation_message(inv["id"])):
            return False
        try:
            card = json.loads(open_sealed(b"notedown-contact", request["card"], self.keys.device))
        except Exception:
            return False
        return (isinstance(card, dict) and card.get("v") == 1 and card.get("identity") == request["identity"]
                and isinstance(card.get("secret"), str) and invitation_id(from_b64u(card["secret"], 16)) == inv["id"])

    def contacts(self) -> list[str]:
        return self.call("GET", "/v1/contacts")["contacts"]

    def files(self) -> list[dict]:
        """The files shared with the plugin: `{"id", "version", "updated", "members"}`."""
        return self.call("GET", "/v1/files")["files"]

    def read_file(self, file_id: str, members: list[str]) -> str:
        """A file's text, after checking that its key was signed by an active device of one of its members."""
        data = self.call("GET", f"/v1/files/{file_id}")
        if not data.get("key"):
            raise ClientError("no key for this device yet")
        signed = SignedWrap.read(data["key"])
        if not any(self.signed_by(m, signed, file_id) for m in members):
            raise ClientError("the file key isn't signed by a member's device")
        file_key = open_sealed(b"notedown-wrap", signed.wrap, self.keys.device)
        return decrypt_file(file_key, data["ciphertext"], file_id, data["version"])

    def signed_by(self, member: str, signed: SignedWrap, file_id: str) -> bool:
        listed = self.call("GET", f"/v1/identities/{member}")
        identity_key = from_b64u(listed["identity_key"], 32)
        if key_id(identity_key) != member:
            return False
        device = verify_chain(identity_key, listed["entries"]).get(signed.signer)
        return bool(device and device.active and verify_signature(
            device.sign, signed.sig, signed.statement(file_id, self.keys.device.id)))

    def delete(self) -> None:
        """Deletes the identity with its identity key (docs/server-api.md → "Blocked and deleted identities")."""
        challenge = self.call("GET", "/v1/auth/challenge")["challenge"]
        sig = b64u(self.keys.identity_key.sign(auth.delete_message(self.host, self.keys.identity, challenge)))
        self.call("POST", f"/v1/identities/{self.keys.identity}/delete", {"challenge": challenge, "sig": sig},
                  ok=(204, 404))
