import os

from notedown_server.protocol import b64u

from conftest import Identity, Keys, token

FILE = b64u(os.urandom(16))


def upload(client, headers, base, data=b"cipher", keys=None, file_id=FILE):
    body = {"base_version": base, "ciphertext": b64u(data)}
    if keys is not None:
        body["keys"] = keys
    return client.put(f"/v1/files/{file_id}", json=body, headers=headers)


def test_health(client):
    assert client.get("/health").json() == {"ok": True}


def test_identity_is_created_once_and_readable(client, setup):
    identity, _, _ = setup
    got = client.get(f"/v1/identities/{identity.id}").json()
    assert got["entries"] == identity.entries
    again = client.post("/v1/identities", json={"identity_key": got["identity_key"], "entries": identity.entries})
    assert again.status_code == 409


def test_genesis_needs_a_recovery_device(client):
    identity = Identity()
    identity.entry("add", Keys().device())
    r = client.post("/v1/identities", json={"identity_key": b64u(identity.key.sign), "entries": identity.entries})
    assert r.status_code == 400


def test_requests_without_valid_token_are_refused(client, setup):
    assert client.get("/v1/files").status_code == 401
    assert client.get("/v1/files", headers={"Authorization": "Bearer x.y"}).status_code == 401


def test_token_needs_the_device_signature(client, setup):
    identity, phone, _ = setup
    challenge = client.get("/v1/auth/challenge").json()["challenge"]
    wrong = b64u(Keys().sign_key.sign(challenge.encode()))
    r = client.post("/v1/auth/token", json={
        "identity": identity.id, "device": phone.id, "challenge": challenge, "sig": wrong})
    assert r.status_code == 401


def test_file_upload_versions_and_conflicts(client, setup):
    identity, phone, recovery = setup
    h = token(client, identity, phone)
    assert upload(client, h, 0).status_code == 400  # a new file needs keys
    keys = {phone.id: b64u(b"k-phone"), recovery.id: b64u(b"k-rec")}
    assert upload(client, h, 0, keys=keys).json() == {"version": 1}
    assert upload(client, h, 1, b"v2").json() == {"version": 2}
    stale = upload(client, h, 1, b"v2b")
    assert stale.status_code == 409 and stale.json()["version"] == 2
    got = client.get(f"/v1/files/{FILE}", headers=h).json()
    assert got == {"id": FILE, "version": 2, "ciphertext": b64u(b"v2"), "key": b64u(b"k-phone")}
    assert client.get("/v1/files", headers=h).json()["files"][0]["version"] == 2


def test_keys_only_for_devices_on_the_list(client, setup):
    identity, phone, _ = setup
    h = token(client, identity, phone)
    assert upload(client, h, 0, keys={Keys().id: b64u(b"k")}).status_code == 400


def test_other_identities_cannot_see_a_file(client, setup):
    identity, phone, _ = setup
    upload(client, token(client, identity, phone), 0, keys={phone.id: b64u(b"k")})
    other, other_phone = Identity(), Keys()
    other.entry("add", other_phone.device())
    other.entry("add", Keys("recovery").device())
    client.post("/v1/identities", json={"identity_key": b64u(other.key.sign), "entries": other.entries})
    h = token(client, other, other_phone)
    assert client.get(f"/v1/files/{FILE}", headers=h).status_code == 404
    assert upload(client, h, 1, keys={other_phone.id: b64u(b"k")}).status_code == 404


def test_linking_and_removing_a_device(client, setup):
    identity, phone, recovery = setup
    h = token(client, identity, phone)
    upload(client, h, 0, keys={phone.id: b64u(b"k-phone"), recovery.id: b64u(b"k-rec")})

    # The new laptop opens a relay slot; the phone adds it and answers in the slot.
    laptop = Keys()
    slot = client.post("/v1/relay").json()["slot"]
    assert client.get(f"/v1/relay/{slot}").status_code == 204
    entry = identity.entry("add", laptop.device(), signer=phone)
    assert client.post(f"/v1/identities/{identity.id}/entries", json={"entry": entry}, headers=h).status_code == 201
    assert client.post(f"/v1/files/{FILE}/keys", json={"keys": {laptop.id: b64u(b"k-laptop")}},
                       headers=h).status_code == 204
    assert client.put(f"/v1/relay/{slot}", json={"payload": "sealed"}, headers=h).status_code == 204
    assert client.put(f"/v1/relay/{slot}", json={"payload": "again"}, headers=h).status_code == 409
    assert client.get(f"/v1/relay/{slot}").json() == {"payload": "sealed"}
    assert client.get(f"/v1/relay/{slot}").status_code == 404

    hl = token(client, identity, laptop)
    assert client.get(f"/v1/files/{FILE}", headers=hl).json()["key"] == b64u(b"k-laptop")

    # The laptop removes the phone: its token stops working and its key is gone.
    stale = identity.entry("remove", {"id": phone.id}, signer=laptop)
    assert client.post(f"/v1/identities/{identity.id}/entries", json={"entry": stale}, headers=hl).status_code == 201
    assert client.get("/v1/files", headers=h).status_code == 401
    rekey = upload(client, hl, 1, b"rekeyed", keys={laptop.id: b64u(b"k2"), recovery.id: b64u(b"r2")})
    assert rekey.json() == {"version": 2}
    assert client.post(f"/v1/files/{FILE}/keys", json={"keys": {phone.id: b64u(b"k")}}, headers=hl).status_code == 400


def test_appending_to_an_outdated_list_conflicts(client, setup):
    identity, phone, _ = setup
    h = token(client, identity, phone)
    first = identity.entry("add", Keys().device(), signer=phone)
    identity.entries.pop()
    second = identity.entry("add", Keys().device(), signer=phone)
    assert client.post(f"/v1/identities/{identity.id}/entries", json={"entry": first}, headers=h).status_code == 201
    r = client.post(f"/v1/identities/{identity.id}/entries", json={"entry": second}, headers=h)
    assert r.status_code == 409 and r.json()["seq"] == 3


def test_restoring_with_the_recovery_device(client, setup):
    identity, _, recovery = setup
    h = token(client, identity, recovery)
    entry = identity.entry("add", Keys().device(), signer=recovery)
    assert client.post(f"/v1/identities/{identity.id}/entries", json={"entry": entry}, headers=h).status_code == 201


def test_cors_allows_the_app_origin(client):
    r = client.options("/v1/files", headers={
        "Origin": "https://localhost", "Access-Control-Request-Method": "GET"})
    assert r.headers["access-control-allow-origin"] == "https://localhost"
