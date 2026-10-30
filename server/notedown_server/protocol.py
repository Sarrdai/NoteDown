"""Encodings and device-list rules of docs/server-api.md, without I/O."""

import base64
import hashlib
import json
import re
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.mlkem import MLKEM768PublicKey

MAX_DEVICES = 20
# Members per file (docs/server-api.md → "Limits"): the admin sets the limit for everyone and per identity between
# MIN_MEMBERS and MAX_MEMBERS; DEFAULT_MEMBERS until they do. MAX_MEMBERS is the hard cap of any request.
DEFAULT_MEMBERS = 20
MIN_MEMBERS = 2
MAX_MEMBERS = 50
# News posts (docs/server-api.md → "News"): body size in UTF-8 bytes, published posts, posts in total.
MAX_NEWS_BODY = 16 * 1024
MAX_NEWS_PUBLISHED = 20
MAX_NEWS = 200
# The oldest app the server serves (docs/server-api.md → "App versions", backlog #51): every app sends its
# compatibility level in the NoteDown-Client header (none = 0); raised together with the app's CLIENT_LEVEL when
# a change ships that older apps can't read or would break.
MIN_CLIENT = 3
KEM_PUBLIC_BYTES = 1184   # ML-KEM-768 encapsulation key
_B64U = re.compile(r"^[A-Za-z0-9_-]*$")
_ID = re.compile(r"^[A-Za-z0-9_-]{22}$")


def client_level(header: str | None) -> int:
    """The compatibility level an app sent in its NoteDown-Client header; 0 when missing or not a number."""
    value = (header or "").strip()
    return int(value) if value.isdigit() and len(value) <= 6 else 0


class ProtocolError(ValueError):
    """A request that breaks the protocol (answered with 400)."""


class LimitError(Exception):
    """A file limit that a member of the file would exceed (answered with 413 and the members)."""

    def __init__(self, detail: str, members: list[str]):
        super().__init__(detail)
        self.detail, self.members = detail, members


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def from_b64u(text: str, length: int | None = None) -> bytes:
    if not isinstance(text, str) or not _B64U.match(text) or len(text) % 4 == 1:
        raise ProtocolError("invalid base64url")
    data = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    if b64u(data) != text:
        raise ProtocolError("non-canonical base64url")
    if length is not None and len(data) != length:
        raise ProtocolError(f"expected {length} bytes")
    return data


def is_id(text: object) -> bool:
    return isinstance(text, str) and bool(_ID.match(text))


def check_news_body(body: object) -> str:
    """A news post's Markdown: a string of 1 byte to 16 KiB (UTF-8) that is not only whitespace."""
    if not isinstance(body, str) or not body.strip():
        raise ProtocolError("body must be a non-empty string")
    try:
        size = len(body.encode("utf-8"))   # a lone surrogate is not UTF-8
    except UnicodeEncodeError:
        raise ProtocolError("body is not valid text")
    if size > MAX_NEWS_BODY:
        raise ProtocolError(f"body is longer than {MAX_NEWS_BODY} bytes")
    if "\x00" in body:   # Postgres text can't hold it
        raise ProtocolError("body must not contain NUL")
    return body


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def key_id(public_key: bytes) -> str:
    """Identity and device IDs: the first 16 bytes of SHA-256 of the signing key."""
    return b64u(hashlib.sha256(public_key).digest()[:16])


def entry_hash(entry: dict) -> str:
    return b64u(hashlib.sha256(canonical(entry)).digest())


def member_key(members: list[str]) -> str:
    """The unique key of a member set: the sorted identity IDs joined by "+" (not in the b64u alphabet)."""
    return "+".join(sorted(members))


def check_members(members: object, caller: str) -> list[str]:
    """A file's requested member set, sorted: valid IDs, no duplicates, the caller included, at most MAX_MEMBERS."""
    if not isinstance(members, list) or not all(is_id(m) for m in members):
        raise ProtocolError("invalid members")
    if len(set(members)) != len(members):
        raise ProtocolError("duplicate members")
    if caller not in members:
        raise ProtocolError("members must include the caller")
    if len(members) > MAX_MEMBERS:
        raise ProtocolError("too many members")
    return sorted(members)


def file_binding(file_id: str, version: int) -> bytes:
    """The associated data of a file's ciphertext: the file and the version it was uploaded as (security review H2)."""
    return canonical({"label": "notedown-file", "file": file_id, "version": version})


def invitation_message(invitation: str) -> bytes:
    """What the inviting device signs when it creates an invitation."""
    return f"notedown-invite-v1:{invitation}".encode()


def verify_signature(public_key: bytes, signature: bytes, message: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
        return True
    except (InvalidSignature, ValueError):
        return False


@dataclass
class Device:
    id: str
    kind: str
    sign: bytes
    active: bool = True
    kem: bool = False   # has an ML-KEM-768 key (post-quantum wrapping)


_ENTRY_KEYS = {"identity", "seq", "prev", "op", "device", "signer", "sig"}


def verify_chain(identity_key: bytes, entries: list) -> dict[str, Device]:
    """Check a whole device list; returns every device ever added, by ID."""
    identity = key_id(identity_key)
    devices: dict[str, Device] = {}
    for seq, entry in enumerate(entries):
        if not isinstance(entry, dict) or set(entry) != _ENTRY_KEYS or type(entry["seq"]) is not int \
                or not all(isinstance(entry[k], str) for k in ("identity", "prev", "op", "signer", "sig")):
            raise ProtocolError(f"entry {seq}: malformed")
        if entry["identity"] != identity or entry["seq"] != seq:
            raise ProtocolError(f"entry {seq}: wrong identity or seq")
        if entry["prev"] != (entry_hash(entries[seq - 1]) if seq else ""):
            raise ProtocolError(f"entry {seq}: prev does not match")

        signer = entry["signer"]
        if signer == "identity":
            signer_key = identity_key
        elif signer in devices and devices[signer].active:
            signer_key = devices[signer].sign
        else:
            raise ProtocolError(f"entry {seq}: signer is not on the list")
        unsigned = {k: v for k, v in entry.items() if k != "sig"}
        if not verify_signature(signer_key, from_b64u(entry["sig"], 64), canonical(unsigned)):
            raise ProtocolError(f"entry {seq}: bad signature")

        device = entry["device"]
        if entry["op"] == "add":
            _apply_add(seq, device, devices)
        elif entry["op"] == "kem":
            _apply_kem(seq, device, signer, devices)
        elif entry["op"] == "remove":
            if not isinstance(device, dict) or set(device) != {"id"} or not is_id(device["id"]):
                raise ProtocolError(f"entry {seq}: malformed remove")
            target = devices.get(device["id"])
            if target is None or not target.active or target.kind == "recovery":
                raise ProtocolError(f"entry {seq}: device can't be removed")
            target.active = False
        else:
            raise ProtocolError(f"entry {seq}: unknown op")
    return devices


def check_kem(text: object) -> None:
    """An ML-KEM-768 encapsulation key (b64u): 1184 bytes that pass FIPS 203's modulus check."""
    if not isinstance(text, str):
        raise ProtocolError("invalid kem key")
    try:
        MLKEM768PublicKey.from_public_bytes(from_b64u(text, KEM_PUBLIC_BYTES))
    except ValueError:
        raise ProtocolError("invalid kem key")


def _check_kem(seq: int, text: str) -> None:
    try:
        check_kem(text)
    except ProtocolError:
        raise ProtocolError(f"entry {seq}: invalid kem key")


def _apply_add(seq: int, device: object, devices: dict[str, Device]) -> None:
    if not isinstance(device, dict) or set(device) - {"kem"} != {"id", "kind", "sign", "enc"} \
            or not all(isinstance(v, str) for v in device.values()):
        raise ProtocolError(f"entry {seq}: malformed device")
    sign = from_b64u(device["sign"], 32)
    from_b64u(device["enc"], 32)
    if "kem" in device:
        _check_kem(seq, device["kem"])
    if device["id"] != key_id(sign) or device["id"] in devices:
        raise ProtocolError(f"entry {seq}: wrong or reused device id")
    if device["kind"] not in ("device", "recovery"):
        raise ProtocolError(f"entry {seq}: unknown kind")
    if device["kind"] == "recovery" and any(d.kind == "recovery" for d in devices.values()):
        raise ProtocolError(f"entry {seq}: second recovery device")
    if sum(d.active for d in devices.values()) >= MAX_DEVICES:
        raise ProtocolError(f"entry {seq}: too many devices")
    devices[device["id"]] = Device(device["id"], device["kind"], sign, kem="kem" in device)


def _apply_kem(seq: int, device: object, signer: str, devices: dict[str, Device]) -> None:
    """A device added without an ML-KEM key gets one, signed by itself or by the identity (the recovery device)."""
    if not isinstance(device, dict) or set(device) != {"id", "kem"} or not is_id(device["id"]) \
            or not isinstance(device["kem"], str):
        raise ProtocolError(f"entry {seq}: malformed kem")
    target = devices.get(device["id"])
    if target is None or not target.active or target.kem:
        raise ProtocolError(f"entry {seq}: device can't get a kem key")
    if signer not in (device["id"], "identity"):
        raise ProtocolError(f"entry {seq}: kem must be signed by the device itself")
    _check_kem(seq, device["kem"])
    target.kem = True
