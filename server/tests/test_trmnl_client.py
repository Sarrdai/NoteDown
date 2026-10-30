"""The TRMNL plugin's client reads what the app writes (tests/fixtures/crypto-vectors.json pins both)."""

import json
import os
import tracemalloc
import zlib
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from notedown_server.protocol import MAX_TEXT_BYTES, b64u, file_binding, verify_chain
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


# --- a file's text is at most 16 MiB (security review M4) ---------------------------------------------------------

FILE_ID = "A" * 22


def deflate(data: bytes) -> bytes:
    """A raw DEFLATE stream, as the app's CompressionStream("deflate-raw") makes it."""
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    return compressor.compress(data) + compressor.flush()


def seal(key: bytes, body: bytes, bound: bool = True) -> str:
    """The ciphertext of a plaintext `body` as the app makes it: padded, AES-GCM, bound to file FILE_ID, version 1."""
    padded = body + b"\x80"
    padded += b"\x00" * (-len(padded) % 4096)
    nonce = os.urandom(12)
    return b64u(nonce + AESGCM(key).encrypt(nonce, padded, file_binding(FILE_ID, 1) if bound else None))


def test_a_text_of_exactly_16_mib_opens_and_one_byte_more_is_refused():
    key = os.urandom(32)
    text = "a" * MAX_TEXT_BYTES
    assert MAX_TEXT_BYTES == 16 * 1024 * 1024
    assert decrypt_file(key, seal(key, b"\x01" + deflate(text.encode())), FILE_ID, 1) == text
    with pytest.raises(ValueError, match="a file's text is larger than 16 MiB"):
        decrypt_file(key, seal(key, b"\x01" + deflate((text + "a").encode())), FILE_ID, 1)
    # the limit is in bytes of UTF-8: "é" is two
    wide = "é" * (MAX_TEXT_BYTES // 2)
    assert decrypt_file(key, seal(key, b"\x01" + deflate(wide.encode())), FILE_ID, 1) == wide
    with pytest.raises(ValueError, match="larger than 16 MiB"):
        decrypt_file(key, seal(key, b"\x01" + deflate((wide + "é").encode())), FILE_ID, 1)


def test_a_deflate_bomb_is_refused_without_being_inflated():
    key = os.urandom(32)
    bomb = b"\x01" + deflate(bytes(8 * MAX_TEXT_BYTES))   # 128 MiB of zeros in about 130 KB
    assert len(bomb) < 200_000
    ciphertext = seal(key, bomb)
    tracemalloc.start()
    try:
        with pytest.raises(ValueError, match="larger than 16 MiB"):
            decrypt_file(key, ciphertext, FILE_ID, 1)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 4 * MAX_TEXT_BYTES, f"{peak} bytes were allocated"   # the output buffer grows to the limit, not to 128 MiB


def test_an_uncompressed_body_over_the_limit_is_refused_too():
    key = os.urandom(32)
    assert decrypt_file(key, seal(key, b"# Notes\n"), FILE_ID, 1) == "# Notes\n"
    for bound in (True, False):   # a file from before the binding goes through the same check
        with pytest.raises(ValueError, match="larger than 16 MiB"):
            decrypt_file(key, seal(key, b"a" * (MAX_TEXT_BYTES + 1), bound), FILE_ID, 1)
    assert len(decrypt_file(key, seal(key, b"a" * MAX_TEXT_BYTES), FILE_ID, 1)) == MAX_TEXT_BYTES


def test_a_damaged_or_cut_off_stream_is_a_value_error_like_the_size():
    key = os.urandom(32)
    text = os.urandom(2000).hex()
    stream = deflate(text.encode())
    assert decrypt_file(key, seal(key, b"\x01" + stream), FILE_ID, 1) == text
    with pytest.raises(ValueError, match="cut off"):
        decrypt_file(key, seal(key, b"\x01" + stream[:-4]), FILE_ID, 1)
    with pytest.raises(ValueError, match="damaged"):
        decrypt_file(key, seal(key, b"\x01\x07not a deflate stream at all"), FILE_ID, 1)
    with pytest.raises(ValueError, match="cut off"):
        decrypt_file(key, seal(key, b"\x01"), FILE_ID, 1)   # nothing after the marker
    # not UTF-8 is a ValueError as before
    with pytest.raises(ValueError):
        decrypt_file(key, seal(key, b"\x01" + deflate(b"\xff\xfe")), FILE_ID, 1)


def test_signed_wrap_reads_its_parts():
    unsigned = VECTORS["hybrid_wrap"]["sealed"]
    with pytest.raises(ClientError):
        SignedWrap.read(unsigned)
