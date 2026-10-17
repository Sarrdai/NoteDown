#!/usr/bin/env python3
"""Writes tests/fixtures/crypto-vectors.json: test vectors of docs/server-api.md.

Everything is derived from fixed inputs (seeds, nonces, an ephemeral key), so a
rerun gives the same file. The server (server/tests/test_crypto_vectors.py) and
the client (tests/crypto.test.mjs) both check against it, which pins them to the
same bytes. Needs the `cryptography` package and, for deterministic ML-KEM
encapsulation, `kyber-py` (server/requirements-dev.txt; every ML-KEM result is
checked against `cryptography` too); run from anywhere:

    python3 scripts/crypto-vectors.py
"""

import base64
import hashlib
import json
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from cryptography.hazmat.primitives import hashes  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.mlkem import MLKEM768PrivateKey  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402
from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: E402
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat  # noqa: E402
from kyber_py.ml_kem import ML_KEM_768  # noqa: E402

from notedown_server.auth import auth_message  # noqa: E402
from notedown_server.protocol import b64u, canonical, entry_hash, invitation_message, key_id, verify_chain  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "crypto-vectors.json"

RECOVERY_KEY = bytes.fromhex("0f1e2d3c4b5a69788796a5b4c3d2e1f0")


def seed(label: str) -> bytes:
    """A fixed 32-byte value per label."""
    return hashlib.sha256(b"notedown-test-vector:" + label.encode()).digest()


def seed64(label: str) -> bytes:
    """A fixed 64-byte value per label (ML-KEM seeds)."""
    return seed(label + "/1") + seed(label + "/2")


def raw(public_key) -> bytes:
    return public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)


def hkdf(ikm: bytes, salt: bytes | None, info: bytes, length: int = 32) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def recovery_key_text(key: bytes) -> str:
    chars = base64.b32encode(key).decode().rstrip("=")
    return "-".join(chars[i:i + 4] for i in range(0, len(chars), 4))


def sign_pair(seed_bytes: bytes) -> tuple[Ed25519PrivateKey, bytes]:
    key = Ed25519PrivateKey.from_private_bytes(seed_bytes)
    return key, raw(key.public_key())


def enc_pair(seed_bytes: bytes) -> tuple[X25519PrivateKey, bytes]:
    key = X25519PrivateKey.from_private_bytes(seed_bytes)
    return key, raw(key.public_key())


def kem_pair(seed_bytes: bytes) -> tuple[MLKEM768PrivateKey, bytes]:
    key = MLKEM768PrivateKey.from_seed_bytes(seed_bytes)
    public = raw(key.public_key())
    assert ML_KEM_768.key_derive(seed_bytes)[0] == public
    return key, public


class Device:
    """A device (or the recovery device) with fixed seeds."""

    def __init__(self, kind: str, sign_seed: bytes, enc_seed: bytes, kem_seed: bytes):
        self.kind = kind
        self.sign_seed, self.enc_seed, self.kem_seed = sign_seed, enc_seed, kem_seed
        self.sign_key, self.sign = sign_pair(sign_seed)
        self.enc_key, self.enc = enc_pair(enc_seed)
        self.kem_key, self.kem = kem_pair(kem_seed)
        self.id = key_id(self.sign)

    def record(self, with_kem: bool = True) -> dict:
        record = {"id": self.id, "kind": self.kind, "sign": b64u(self.sign), "enc": b64u(self.enc)}
        return {**record, "kem": b64u(self.kem)} if with_kem else record

    def dump(self) -> dict:
        return {"sign_seed": self.sign_seed.hex(), "enc_seed": self.enc_seed.hex(), "kem_seed": self.kem_seed.hex(),
                "id": self.id, "sign": b64u(self.sign), "enc": b64u(self.enc), "kem": b64u(self.kem)}


def hybrid_seal(label: bytes, recipient: Device, plain: bytes, name: str) -> dict:
    """Sealed for a device's X25519 + ML-KEM-768 keys (docs/server-api.md → "Keys"), from fixed randomness."""
    eph_key, eph_pub = enc_pair(seed(name + "-ephemeral"))
    shared_x = eph_key.exchange(X25519PublicKey.from_public_bytes(recipient.enc))
    shared_kem, kem_ct = ML_KEM_768._encaps_internal(recipient.kem, seed(name + "-kem"))
    assert recipient.kem_key.decapsulate(kem_ct) == shared_kem
    transcript = hashlib.sha256(eph_pub + recipient.enc + kem_ct + recipient.kem).digest()
    key = hkdf(shared_x + shared_kem, None, label + b"-pq" + transcript)
    nonce = seed(name + "-nonce")[:12]
    return {"recipient": recipient.id, "kem_shared": shared_kem.hex(),
            "sealed": b64u(b"\x01" + eph_pub + kem_ct + nonce + AESGCM(key).encrypt(nonce, plain, None))}


def signed(body: dict, signer: str, key: Ed25519PrivateKey) -> dict:
    unsigned = {**body, "signer": signer}
    return {**unsigned, "sig": b64u(key.sign(canonical(unsigned)))}


def build_chain(identity_key, identity_id, phone, recovery, tablet) -> list[dict]:
    entries: list[dict] = []

    def add(op: str, device: dict, signer: str, key) -> None:
        prev = entry_hash(entries[-1]) if entries else ""
        body = {"identity": identity_id, "seq": len(entries), "prev": prev, "op": op, "device": device}
        entries.append(signed(body, signer, key))

    add("add", phone.record(), "identity", identity_key)
    add("add", recovery.record(), "identity", identity_key)
    # The tablet as added before post-quantum keys: without kem, which it adds itself afterwards.
    add("add", tablet.record(with_kem=False), phone.id, phone.sign_key)
    add("kem", {"id": tablet.id, "kem": b64u(tablet.kem)}, tablet.id, tablet.sign_key)
    add("remove", {"id": tablet.id}, tablet.id, tablet.sign_key)
    return entries


CANONICAL_CASES = [
    {"a": "x", "b": 1},
    {"b": 2, "a": {"d": 4, "c": {}, "e": {"z": "", "y": 0}}},
    {"name": "Zoë Müller — \U0001f600", "seq": 7},
    {"quote": "say \"hi\"", "backslash": "a\\b", "slash": "a/b"},
    {"control": "tab\t newline\n cr\r bell\x07 nul\x00 unit\x1f del\x7f", "line": "a b"},
    {"": "private use", "\U0001f600": "emoji", "a": "ascii", "ä": "umlaut", "B": "upper"},
    {"neg": -5, "zero": 0, "big": 9007199254740991},
    {"flags": True, "nothing": None, "list": [1, "two", {"three": 3}]},
]


def build() -> dict:
    # Recovery key and what is derived from it.
    identity_key, identity_pub = sign_pair(hkdf(RECOVERY_KEY, b"NoteDown", b"identity-sign"))
    identity_id = key_id(identity_pub)
    recovery = Device("recovery", hkdf(RECOVERY_KEY, b"NoteDown", b"recovery-sign"),
                      hkdf(RECOVERY_KEY, b"NoteDown", b"recovery-enc"), hkdf(RECOVERY_KEY, b"NoteDown", b"recovery-kem", 64))

    phone = Device("device", seed("phone-sign"), seed("phone-enc"), seed64("phone-kem"))
    tablet = Device("device", seed("tablet-sign"), seed("tablet-enc"), seed64("tablet-kem"))
    chain = build_chain(identity_key, identity_id, phone, recovery, tablet)
    devices = verify_chain(identity_pub, chain)
    assert [d.active for d in devices.values()] == [True, True, False]
    assert all(d.kem for d in devices.values())

    # Authentication: the phone signs a fixed challenge.
    challenge = b64u(seed("challenge") + seed("challenge-mac")[:8])
    auth_signature = phone.sign_key.sign(auth_message(challenge))

    # A file key wrapped for the phone, with a fixed ephemeral key and nonce.
    file_key = seed("file-key")
    eph_seed, wrap_nonce = seed("wrap-ephemeral"), seed("wrap-nonce")[:12]
    eph_key, eph_pub = enc_pair(eph_seed)
    shared = eph_key.exchange(X25519PublicKey.from_public_bytes(phone.enc))
    wrap_key = hkdf(shared, None, b"notedown-wrap" + eph_pub + phone.enc)
    wrapped = b64u(eph_pub + wrap_nonce + AESGCM(wrap_key).encrypt(wrap_nonce, file_key, None))

    # A file encrypted with a fixed key and nonce: the text padded (0x80, then 0x00 up to a multiple
    # of 4096 bytes), and the same kind of file as an older client uploaded it, unpadded.
    file_text = "# Crypto test vector\n\nÄöü — \U0001f600 fixed text for tests/fixtures/crypto-vectors.json\n"
    plain = file_text.encode()
    padded = plain + b"\x80" + b"\x00" * (-(len(plain) + 1) % 4096)
    file_nonce = seed("file-nonce-padded")[:12]
    ciphertext = b64u(file_nonce + AESGCM(file_key).encrypt(file_nonce, padded, None))
    legacy_nonce = seed("file-nonce")[:12]
    legacy_ciphertext = b64u(legacy_nonce + AESGCM(file_key).encrypt(legacy_nonce, plain, None))

    # The current format: 0x01, then the raw DEFLATE stream of the text, padded like above. The file key
    # renewed: the old key sealed with the new one (associated data notedown-previous-key).
    long_text = file_text * 40
    deflate = zlib.compressobj(9, zlib.DEFLATED, -15)
    packed = b"\x01" + deflate.compress(long_text.encode()) + deflate.flush()
    compressed_nonce = seed("file-nonce-compressed")[:12]
    compressed_ciphertext = b64u(compressed_nonce + AESGCM(file_key).encrypt(
        compressed_nonce, packed + b"\x80" + b"\x00" * (-(len(packed) + 1) % 4096), None))
    new_key, previous_nonce = seed("file-key-renewed"), seed("previous-key-nonce")[:12]
    previous_key = b64u(previous_nonce + AESGCM(new_key).encrypt(previous_nonce, file_key, b"notedown-previous-key"))

    # An invitation: secret -> ID -> signature of the inviting device (the phone).
    invite_secret = seed("invite-secret")[:16]
    invite_id = b64u(hashlib.sha256(invite_secret).digest()[:16])
    invite_signature = phone.sign_key.sign(invitation_message(invite_id))

    # A contact card sealed for the phone: like the wrapped key, with the label notedown-contact.
    card = {"v": 1, "identity": identity_id, "name": "Zoë", "secret": b64u(invite_secret)}
    card_plain = json.dumps(card, ensure_ascii=False, separators=(",", ":")).encode()
    card_eph_key, card_eph_pub = enc_pair(seed("card-ephemeral"))
    card_nonce = seed("card-nonce")[:12]
    card_shared = card_eph_key.exchange(X25519PublicKey.from_public_bytes(phone.enc))
    card_key = hkdf(card_shared, None, b"notedown-contact" + card_eph_pub + phone.enc)
    card_sealed = b64u(card_eph_pub + card_nonce + AESGCM(card_key).encrypt(card_nonce, card_plain, None))

    # Hybrid (post-quantum) seals for the phone: a file key, a contact card, a relay message.
    relay = {"v": 1, "identity": identity_id, "name": "Zoë"}
    relay_plain = json.dumps(relay, ensure_ascii=False, separators=(",", ":")).encode()

    return {
        "_comment": "Generated by scripts/crypto-vectors.py from fixed inputs; do not edit by hand.",
        "recovery": {
            "bytes": RECOVERY_KEY.hex(),
            "text": recovery_key_text(RECOVERY_KEY),
            "identity_sign": b64u(identity_pub),
            "identity_id": identity_id,
            "device": recovery.dump(),
        },
        "phone": phone.dump(),
        "tablet": tablet.dump(),
        "chain": chain,
        "chain_hashes": [entry_hash(e) for e in chain],
        "canonical": [{"value": v, "bytes": canonical(v).hex()} for v in CANONICAL_CASES],
        "auth": {"challenge": challenge, "message": auth_message(challenge).decode(),
                 "signature": b64u(auth_signature)},
        "wrap": {"file_key": file_key.hex(), "recipient_enc": b64u(phone.enc), "wrapped": wrapped},
        "hybrid_wrap": {"file_key": file_key.hex(), **hybrid_seal(b"notedown-wrap", phone, file_key, "hybrid-wrap")},
        "hybrid_contact_card": {"card": card, **hybrid_seal(b"notedown-contact", phone, card_plain, "hybrid-card")},
        "hybrid_relay": {"message": relay, **hybrid_seal(b"notedown-relay", phone, relay_plain, "hybrid-relay")},
        "invite": {"secret": b64u(invite_secret), "id": invite_id, "message": invitation_message(invite_id).decode(),
                   "signature": b64u(invite_signature)},
        "contact_card": {"recipient_enc": b64u(phone.enc), "card": card, "sealed": card_sealed},
        "file": {"key": file_key.hex(), "text": file_text, "ciphertext": ciphertext},
        "legacy_file": {"key": file_key.hex(), "text": file_text, "ciphertext": legacy_ciphertext},
        "compressed_file": {"key": file_key.hex(), "text": long_text, "ciphertext": compressed_ciphertext},
        "previous_key": {"new_key": new_key.hex(), "old_key": file_key.hex(), "sealed": previous_key},
    }


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build(), indent=2) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
