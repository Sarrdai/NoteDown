"""Pins protocol.py to tests/fixtures/crypto-vectors.json, which the client's
tests/crypto.test.mjs reproduces too (scripts/crypto-vectors.py writes it)."""

import hashlib
import importlib.util
import json
import zlib
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from notedown_server import auth
from notedown_server.app import MAX_WRAPPED_KEY
from notedown_server.protocol import (
    ProtocolError, b64u, canonical, entry_hash, from_b64u, invitation_message, key_id, verify_chain, verify_signature,
)

ROOT = Path(__file__).resolve().parents[2]
VECTORS = json.loads((ROOT / "tests" / "fixtures" / "crypto-vectors.json").read_text())


def test_fixture_is_what_the_script_generates():
    spec = importlib.util.spec_from_file_location("crypto_vectors", ROOT / "scripts" / "crypto-vectors.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    assert json.loads(json.dumps(script.build())) == VECTORS


def test_ids_derive_from_the_signing_keys():
    assert key_id(from_b64u(VECTORS["recovery"]["identity_sign"], 32)) == VECTORS["recovery"]["identity_id"]
    for name in ("phone", "tablet"):
        assert key_id(from_b64u(VECTORS[name]["sign"], 32)) == VECTORS[name]["id"]
    assert key_id(from_b64u(VECTORS["recovery"]["device"]["sign"], 32)) == VECTORS["recovery"]["device"]["id"]


def test_server_accepts_the_chain():
    devices = verify_chain(from_b64u(VECTORS["recovery"]["identity_sign"], 32), VECTORS["chain"])
    assert [d.id for d in devices.values()] == [VECTORS["phone"]["id"], VECTORS["recovery"]["device"]["id"],
                                                VECTORS["tablet"]["id"]]
    assert [d.active for d in devices.values()] == [True, True, False]


def test_entry_hashes_match():
    assert [entry_hash(e) for e in VECTORS["chain"]] == VECTORS["chain_hashes"]


@pytest.mark.parametrize("case", VECTORS["canonical"])
def test_canonical_bytes_match(case):
    assert canonical(case["value"]).hex() == case["bytes"]


def test_auth_signature_verifies_for_the_phone():
    auth_vector = VECTORS["auth"]
    assert auth.auth_message(auth_vector["challenge"]).decode() == auth_vector["message"]
    assert verify_signature(from_b64u(VECTORS["phone"]["sign"], 32), from_b64u(auth_vector["signature"], 64),
                            auth.auth_message(auth_vector["challenge"]))


def test_invitation_id_and_signature_match():
    invite = VECTORS["invite"]
    assert b64u(hashlib.sha256(from_b64u(invite["secret"], 16)).digest()[:16]) == invite["id"]
    assert invitation_message(invite["id"]).decode() == invite["message"]
    assert verify_signature(from_b64u(VECTORS["phone"]["sign"], 32), from_b64u(invite["signature"], 64),
                            invitation_message(invite["id"]))


def test_sealed_contact_card_fits_the_limit_and_holds_the_secret():
    card = VECTORS["contact_card"]
    raw = from_b64u(card["sealed"])
    assert len(card["sealed"]) <= 512
    assert raw[:32] != from_b64u(card["recipient_enc"], 32)   # an ephemeral key first
    assert card["card"]["secret"] == VECTORS["invite"]["secret"]


def test_wrapped_key_fits_the_limit():
    assert len(VECTORS["wrap"]["wrapped"]) <= 512
    assert len(from_b64u(VECTORS["wrap"]["wrapped"])) == 32 + 12 + 32 + 16


@pytest.mark.parametrize("name", ["hybrid_wrap", "hybrid_contact_card", "hybrid_relay"])
def test_hybrid_seals_fit_the_limit_and_their_ml_kem_part_decapsulates(name):
    from cryptography.hazmat.primitives.asymmetric.mlkem import MLKEM768PrivateKey
    vector = VECTORS[name]
    raw = from_b64u(vector["sealed"])
    assert raw[0] == 1 and len(vector["sealed"]) <= MAX_WRAPPED_KEY
    phone = MLKEM768PrivateKey.from_seed_bytes(bytes.fromhex(VECTORS["phone"]["kem_seed"]))
    assert phone.decapsulate(raw[33:33 + 1088]).hex() == vector["kem_shared"]


def test_file_ciphertext_is_padded_to_4096_bytes_and_legacy_files_are_not():
    padded, legacy = VECTORS["file"], VECTORS["legacy_file"]
    key = bytes.fromhex(padded["key"])

    def plaintext(ciphertext: str) -> bytes:
        raw = from_b64u(ciphertext)
        return AESGCM(key).decrypt(raw[:12], raw[12:], None)

    text = padded["text"].encode()
    assert plaintext(padded["ciphertext"]) == text + b"\x80" + b"\x00" * (4096 - len(text) - 1)
    assert plaintext(legacy["ciphertext"]) == legacy["text"].encode() == text


def test_compressed_file_is_0x01_then_raw_deflate_padded_and_the_previous_key_is_sealed_with_the_new():
    vector = VECTORS["compressed_file"]
    key = bytes.fromhex(vector["key"])
    raw = from_b64u(vector["ciphertext"])
    plain = AESGCM(key).decrypt(raw[:12], raw[12:], None)
    assert len(plain) % 4096 == 0 and plain[0] == 1
    body = plain.rstrip(b"\x00")
    assert body[-1] == 0x80
    assert zlib.decompress(body[1:-1], -15).decode() == vector["text"]
    sealed = from_b64u(VECTORS["previous_key"]["sealed"])
    old = AESGCM(bytes.fromhex(VECTORS["previous_key"]["new_key"])).decrypt(sealed[:12], sealed[12:],
                                                                          b"notedown-previous-key")
    assert old.hex() == VECTORS["previous_key"]["old_key"]
    assert len(VECTORS["previous_key"]["sealed"]) <= 512


def test_tampered_fixture_chain_is_rejected():
    key = from_b64u(VECTORS["recovery"]["identity_sign"], 32)
    chain = json.loads(json.dumps(VECTORS["chain"]))
    chain[2]["device"]["kind"] = "recovery"
    with pytest.raises(ProtocolError, match="entry 2: bad signature"):
        verify_chain(key, chain)
