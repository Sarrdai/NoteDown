"""The TRMNL plugin's client reads what the app writes (tests/fixtures/crypto-vectors.json pins both)."""

import json
from pathlib import Path

import pytest

from notedown_server.protocol import verify_chain
from notedown_server.trmnl.client import (ClientError, DeviceKeys, Keys, SignedWrap, decrypt_file, invitation_link,
                                          open_sealed)

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "tests/fixtures/crypto-vectors.json").read_text())


def phone() -> DeviceKeys:
    p = VECTORS["phone"]
    return DeviceKeys("device", bytes.fromhex(p["sign_seed"]), bytes.fromhex(p["enc_seed"]), bytes.fromhex(p["kem_seed"]))


def test_keys_derive_identity_and_recovery_device_like_a_recovery_key():
    keys = Keys(bytes.fromhex(VECTORS["recovery"]["bytes"]))
    assert keys.identity == VECTORS["recovery"]["identity_id"]
    assert keys.recovery.id == VECTORS["recovery"]["device"]["id"]
    assert keys.recovery.kem.hex() != keys.device.kem.hex()


def test_genesis_is_a_valid_device_list():
    keys = Keys.new()
    devices = verify_chain(keys.identity_public, keys.genesis())
    assert {d.id: d.kind for d in devices.values()} == {keys.device.id: "device", keys.recovery.id: "recovery"}
    assert all(d.kem and d.active for d in devices.values())


def test_invitation_secrets_are_derived_and_distinct():
    keys = Keys.new()
    assert keys.invitation_secret(1) == Keys(keys.secret).invitation_secret(1)
    assert keys.invitation_secret(1) != keys.invitation_secret(2)
    link = invitation_link("https://notes.example/", keys.identity, keys.invitation_secret(1), "https://api.example")
    assert link.startswith("https://notes.example/invite/#v=1&id=")
    assert "name=TRMNL" in link and "kind=display" in link and "srv=https%3A%2F%2Fapi.example" in link


def test_opens_the_apps_hybrid_seals():
    wrap = VECTORS["hybrid_wrap"]
    assert open_sealed(b"notedown-wrap", wrap["sealed"], phone()).hex() == wrap["file_key"]
    card = VECTORS["hybrid_contact_card"]
    assert json.loads(open_sealed(b"notedown-contact", card["sealed"], phone())) == card["card"]
    with pytest.raises(Exception):
        open_sealed(b"notedown-contact", wrap["sealed"], phone())    # another label doesn't open
    with pytest.raises(ClientError):
        open_sealed(b"notedown-wrap", VECTORS["wrap"]["wrapped"], phone())   # X25519 only: refused


@pytest.mark.parametrize("name", ["bound_file", "file", "legacy_file", "compressed_file"])
def test_decrypts_files_in_every_format(name):
    vector, bound = VECTORS[name], VECTORS["bound_file"]
    assert decrypt_file(bytes.fromhex(vector["key"]), vector["ciphertext"], bound["file"], bound["version"]) == vector["text"]


def test_a_bound_file_opens_only_as_its_version():
    v = VECTORS["bound_file"]
    with pytest.raises(Exception):
        decrypt_file(bytes.fromhex(v["key"]), v["ciphertext"], v["file"], v["version"] + 1)


def test_signed_wrap_reads_its_parts():
    unsigned = VECTORS["hybrid_wrap"]["sealed"]
    with pytest.raises(ClientError):
        SignedWrap.read(unsigned)
