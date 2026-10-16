"""The storage quota and the per-IP rate limits (docs/server-api.md → "Limits")."""

import os

import psycopg

from notedown_server.app import LIMIT_IDENTITIES, LIMIT_RELAY, MAX_STORAGE_BYTES
from notedown_server.protocol import b64u

from conftest import DATABASE_URL, Identity, Keys, token
from test_api import upload

# --- storage quota ---


def test_storage_quota_counts_all_files_of_the_identity(people):
    # One file per member set: the private file and one shared with a contact.
    alice, bob = people(), people()
    alice.befriend(bob)
    h = alice.h
    keys = {alice.phone.id: b64u(b"k")}
    shared = dict(keys={**keys, bob.phone.id: b64u(b"k")}, file_id=b64u(os.urandom(16)), members=sorted([alice.id, bob.id]))
    assert upload(alice.client, h, 0, b"a" * MAX_STORAGE_BYTES, keys=keys).status_code == 200
    full = upload(alice.client, h, 0, b"b", **shared)
    assert full.status_code == 413 and full.json() == {"detail": "storage quota exceeded", "members": [alice.id]}
    # Replacing a file doesn't count its old size, but a bigger one doesn't fit.
    assert upload(alice.client, h, 1, b"a" * (MAX_STORAGE_BYTES - 10)).status_code == 200
    assert upload(alice.client, h, 0, b"b" * 10, **shared).status_code == 200
    assert upload(alice.client, h, 2, b"a" * (MAX_STORAGE_BYTES - 9)).status_code == 413


def test_file_list_reports_sizes_and_the_quota(people):
    alice, bob = people(), people()
    alice.befriend(bob)
    h = alice.h
    keys = {alice.phone.id: b64u(b"k")}
    assert alice.client.get("/v1/files", headers=h).json() == {"files": [], "quota": MAX_STORAGE_BYTES, "epoch": None,
                                                                                  "news": None, "deleted": []}
    upload(alice.client, h, 0, b"a" * 1000, keys=keys)
    upload(alice.client, h, 0, b"b" * 234, keys={**keys, bob.phone.id: b64u(b"k")}, file_id=b64u(os.urandom(16)), members=sorted([alice.id, bob.id]))
    listed = alice.client.get("/v1/files", headers=h).json()
    assert sorted(f["size"] for f in listed["files"]) == [234, 1000]
    assert listed["quota"] == MAX_STORAGE_BYTES


def test_a_file_over_the_quota_is_refused_early(client, setup):
    identity, phone, _ = setup
    h = token(client, identity, phone)
    r = upload(client, h, 0, b"a" * (MAX_STORAGE_BYTES + 1), keys={phone.id: b64u(b"k")})
    assert r.status_code == 413 and r.json() == {"detail": "storage quota exceeded", "members": [identity.id]}


def test_quota_is_per_identity(client, setup):
    identity, phone, _ = setup
    upload(client, token(client, identity, phone), 0, b"a" * MAX_STORAGE_BYTES, keys={phone.id: b64u(b"k")})
    other, other_phone = Identity(), Keys()
    other.entry("add", other_phone.device())
    other.entry("add", Keys("recovery").device())
    client.post("/v1/identities", json={"identity_key": b64u(other.key.sign), "entries": other.entries})
    r = upload(client, token(client, other, other_phone), 0, b"a" * MAX_STORAGE_BYTES,
               keys={other_phone.id: b64u(b"k")}, file_id=b64u(os.urandom(16)))
    assert r.status_code == 200


# --- rate limits ---


def new_identity_body() -> dict:
    identity = Identity()
    identity.entry("add", Keys().device())
    identity.entry("add", Keys("recovery").device())
    return {"identity_key": b64u(identity.key.sign), "entries": identity.entries}


def forwarded(ip: str) -> dict:
    return {"X-Forwarded-For": ip}


def test_identity_creation_is_limited_per_ip(limited_client):
    c, (maximum, window) = limited_client, LIMIT_IDENTITIES
    for _ in range(maximum):
        assert c.post("/v1/identities", json=new_identity_body(), headers=forwarded("198.51.100.1")).status_code == 201
    r = c.post("/v1/identities", json=new_identity_body(), headers=forwarded("198.51.100.1"))
    assert r.status_code == 429 and "detail" in r.json()
    assert 0 < int(r.headers["Retry-After"]) <= window
    # Another address has its own count.
    assert c.post("/v1/identities", json=new_identity_body(), headers=forwarded("198.51.100.2")).status_code == 201


def test_relay_is_limited_per_ip_with_its_own_window(limited_client):
    c, (maximum, window) = limited_client, LIMIT_RELAY
    for _ in range(maximum):
        assert c.post("/v1/relay", headers=forwarded("198.51.100.1")).status_code == 201
    r = c.post("/v1/relay", headers=forwarded("198.51.100.1"))
    assert r.status_code == 429 and 0 < int(r.headers["Retry-After"]) <= window
    # The identities limit of the same address is untouched, and reading a slot stays unlimited.
    assert c.post("/v1/identities", json=new_identity_body(), headers=forwarded("198.51.100.1")).status_code == 201
    assert c.get("/v1/relay/unknown", headers=forwarded("198.51.100.1")).status_code == 404


def test_ipv6_counts_per_64_prefix(limited_client):
    c = limited_client
    for i in range(LIMIT_RELAY[0]):
        assert c.post("/v1/relay", headers=forwarded(f"2001:db8:1:2:{i:x}::{i:x}")).status_code == 201
    assert c.post("/v1/relay", headers=forwarded("2001:db8:1:2:ffff::1")).status_code == 429
    assert c.post("/v1/relay", headers=forwarded("2001:db8:1:3::1")).status_code == 201


def test_the_last_forwarded_address_counts(limited_client):
    c = limited_client
    for i in range(LIMIT_RELAY[0]):
        # A forged first entry doesn't buy a fresh count.
        assert c.post("/v1/relay", headers=forwarded(f"203.0.113.{i}, 198.51.100.9")).status_code == 201
    assert c.post("/v1/relay", headers=forwarded("203.0.113.99, 198.51.100.9")).status_code == 429


def test_without_the_header_the_socket_peer_counts(limited_client):
    c = limited_client
    for _ in range(LIMIT_RELAY[0]):
        assert c.post("/v1/relay").status_code == 201
    assert c.post("/v1/relay").status_code == 429


def test_rate_limit_windows_expire_and_are_cleaned_up(limited_client):
    c = limited_client
    assert c.post("/v1/relay", headers=forwarded("198.51.100.1")).status_code == 201
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute("UPDATE rate_limits SET expires = now() - interval '1 second'")
        assert c.post("/v1/relay", headers=forwarded("198.51.100.2")).status_code == 201
        assert [r[0] for r in conn.execute("SELECT bucket FROM rate_limits")] == ["relay:198.51.100.2"]


def test_other_endpoints_are_not_limited(limited_client):
    for _ in range(LIMIT_RELAY[0] + 1):
        assert limited_client.get("/v1/auth/challenge").status_code == 200
