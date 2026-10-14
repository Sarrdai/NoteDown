import pytest

from notedown_server import auth
from notedown_server.protocol import ProtocolError, canonical, from_b64u, verify_chain

from conftest import Identity, Keys


def test_canonical_json_sorts_keys_without_whitespace():
    assert canonical({"b": 1, "a": {"d": "ü", "c": 2}}) == '{"a":{"c":2,"d":"ü"},"b":1}'.encode()


def test_base64url_rejects_padding_and_noncanonical_input():
    assert from_b64u("AQI") == b"\x01\x02"
    for bad in ("AQI=", "AQJ", "A", "a+b/"):
        with pytest.raises(ProtocolError):
            from_b64u(bad)


def test_chain_tracks_added_and_removed_devices():
    identity, phone, recovery, laptop = Identity(), Keys(), Keys("recovery"), Keys()
    identity.entry("add", phone.device())
    identity.entry("add", recovery.device())
    identity.entry("add", laptop.device(), signer=phone)
    identity.entry("remove", {"id": phone.id}, signer=laptop)
    devices = verify_chain(identity.key.sign, identity.entries)
    assert {d.id: d.active for d in devices.values()} == {phone.id: False, recovery.id: True, laptop.id: True}


@pytest.mark.parametrize("tamper", [
    lambda e: e.update(seq=5),
    lambda e: e.update(prev="x"),
    lambda e: e["device"].update(kind="tablet"),
    # The first character: all its bits count (the last one carries ignored padding bits).
    lambda e: e.update(sig=("B" if e["sig"][0] == "A" else "A") + e["sig"][1:]),
    lambda e: e.update(seq=1.0),
    lambda e: e.update(signer=["identity"]),
    lambda e: e["device"].update(kind=["device"]),
])
def test_chain_rejects_tampered_entries(tamper):
    identity, phone = Identity(), Keys()
    identity.entry("add", phone.device())
    identity.entry("add", Keys().device(), signer=phone)
    tamper(identity.entries[1])
    with pytest.raises(ProtocolError):
        verify_chain(identity.key.sign, identity.entries)


def test_removed_device_can_no_longer_sign():
    identity, phone, laptop = Identity(), Keys(), Keys()
    identity.entry("add", phone.device())
    identity.entry("add", laptop.device())
    identity.entry("remove", {"id": phone.id}, signer=laptop)
    identity.entry("add", Keys().device(), signer=phone)
    with pytest.raises(ProtocolError, match="signer"):
        verify_chain(identity.key.sign, identity.entries)


def test_recovery_device_is_unique_and_cannot_be_removed():
    identity, phone, recovery = Identity(), Keys(), Keys("recovery")
    identity.entry("add", phone.device())
    identity.entry("add", recovery.device())
    identity.entry("remove", {"id": recovery.id}, signer=phone)
    with pytest.raises(ProtocolError):
        verify_chain(identity.key.sign, identity.entries)
    identity.entries.pop()
    identity.entry("add", Keys("recovery").device())
    with pytest.raises(ProtocolError, match="recovery"):
        verify_chain(identity.key.sign, identity.entries)


def test_challenge_expires_and_token_is_bound_to_secret():
    challenge = auth.new_challenge(b"s", now=1000)
    auth.check_challenge(b"s", challenge, now=1100)
    with pytest.raises(ProtocolError):
        auth.check_challenge(b"s", challenge, now=1200)
    with pytest.raises(ProtocolError):
        auth.check_challenge(b"other", challenge, now=1100)
    value, _ = auth.new_token(b"s", "i", "d", now=1000)
    assert auth.read_token(b"s", value, now=2000) == ("i", "d")
    assert auth.read_token(b"s", value, now=5000) is None
    assert auth.read_token(b"other", value, now=2000) is None
