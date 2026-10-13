"""Pins protocol.py to tests/fixtures/crypto-vectors.json, which the client's
tests/crypto.test.mjs reproduces too (scripts/crypto-vectors.py writes it)."""

import importlib.util
import json
from pathlib import Path

import pytest

from notedown_server import auth
from notedown_server.protocol import (
    ProtocolError, canonical, entry_hash, from_b64u, key_id, verify_chain, verify_signature,
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


def test_wrapped_key_fits_the_limit():
    assert len(VECTORS["wrap"]["wrapped"]) <= 512
    assert len(from_b64u(VECTORS["wrap"]["wrapped"])) == 32 + 12 + 32 + 16


def test_tampered_fixture_chain_is_rejected():
    key = from_b64u(VECTORS["recovery"]["identity_sign"], 32)
    chain = json.loads(json.dumps(VECTORS["chain"]))
    chain[2]["device"]["kind"] = "recovery"
    with pytest.raises(ProtocolError, match="entry 2: bad signature"):
        verify_chain(key, chain)
