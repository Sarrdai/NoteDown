"""The admin endpoints (docs/server-api.md → "Admin"): access, overview, identities, the quota override,
backup and restore with its epoch."""

import copy
import os

import psycopg
import pytest

from notedown_server import auth
from notedown_server.admin import MAX_QUOTA_OVERRIDE
from notedown_server.app import MAX_STORAGE_BYTES, Settings
from notedown_server.protocol import b64u

from conftest import DATABASE_URL, Identity, Keys, token
from test_api import upload

NOT_FOUND = {"detail": "not found"}


@pytest.fixture
def admin(client, people):
    """The owner: a registered identity listed in ADMIN_IDENTITIES."""
    owner = people()
    client.settings.admin_identities = [owner.id]
    return owner


def put_private(person, data=b"cipher", base=0, file_id=None):
    file_id = file_id or b64u(os.urandom(16))
    r = upload(person.client, person.h, base, data, keys={person.phone.id: b64u(b"k")}, file_id=file_id)
    assert r.status_code == 200, r.text
    return file_id


def share(a, b, data=b"shared"):
    file_id = b64u(os.urandom(16))
    keys = {a.phone.id: b64u(b"k"), b.phone.id: b64u(b"k")}
    r = upload(a.client, a.h, 0, data, keys=keys, file_id=file_id, members=sorted([a.id, b.id]))
    assert r.status_code == 200, r.text
    return file_id


# --- access ---

ENDPOINTS = [
    ("GET", "/v1/admin/overview", None),
    ("GET", "/v1/admin/identities", None),
    ("GET", "/v1/admin/identities/{id}", None),
    ("PUT", "/v1/admin/identities/{id}/quota", {"quota": 1000}),
    ("GET", "/v1/admin/backup", None),
    ("POST", "/v1/admin/restore", {}),
]


def test_everybody_but_the_admin_gets_404(client, people, admin):
    other = people()
    for method, path, body in ENDPOINTS:
        path = path.format(id=other.id)
        for headers in (other.h, {}, {"Authorization": "Bearer nonsense"}):
            r = client.request(method, path, json=body, headers=headers)
            assert r.status_code == 404 and r.json() == NOT_FOUND, (method, path, r.text)
    assert client.get("/v1/admin/overview", headers=admin.h).status_code == 200


def test_a_bad_body_does_not_give_the_endpoints_away(client, people, admin):
    other = people()
    r = client.post("/v1/admin/restore", content=b"not json", headers=other.h)
    assert r.status_code == 404 and r.json() == NOT_FOUND


def test_nobody_is_admin_by_default(client, people):
    person = people()
    assert client.settings.admin_identities == []
    assert client.get("/v1/admin/overview", headers=person.h).status_code == 404


def test_admin_identities_come_from_the_environment(monkeypatch):
    ids = [b64u(os.urandom(16)), b64u(os.urandom(16))]
    monkeypatch.setenv("DATABASE_URL", "x")
    monkeypatch.setenv("SERVER_SECRET", "x")
    monkeypatch.setenv("ADMIN_IDENTITIES", f" {ids[0]},{ids[1]}\n*, typo ")
    # Exact IDs only: a wildcard or a typo is dropped, never matched.
    assert Settings.from_env().admin_identities == ids
    monkeypatch.setenv("ADMIN_IDENTITIES", "")
    assert Settings.from_env().admin_identities == []
    monkeypatch.delenv("ADMIN_IDENTITIES")
    assert Settings.from_env().admin_identities == []


# --- overview and identities ---


def test_overview_counts(client, people, admin):
    alice, bob = people(), people()
    alice.befriend(bob)
    alice.invite()
    put_private(alice, b"a" * 100)
    share(alice, bob, b"b" * 50)
    alice.add_device()
    got = client.get("/v1/admin/overview", headers=admin.h).json()
    assert got["identity"] == admin.id
    assert got["counts"] == {"identities": 3, "devices": 4, "files": 2, "shared_files": 1, "contacts": 1,
                             "invitations": 1}
    assert got["storage"]["files"] == 150
    assert 0 < got["storage"]["database"] < got["storage"]["database_limit"] == 512 * 1024 * 1024
    assert got["quota"] == MAX_STORAGE_BYTES


def test_identities_list(client, people, admin):
    alice, bob = people(), people()
    alice.befriend(bob)
    put_private(alice, b"a" * 100)
    share(alice, bob, b"b" * 50)
    client.put(f"/v1/admin/identities/{bob.id}/quota", json={"quota": 5000}, headers=admin.h)
    rows = {r["id"]: r for r in client.get("/v1/admin/identities", headers=admin.h).json()["identities"]}
    assert set(rows) == {admin.id, alice.id, bob.id}
    assert rows[alice.id] | {"created": None, "updated": None} == {
        "id": alice.id, "created": None, "devices": 1, "files": 2, "used": 150, "quota": MAX_STORAGE_BYTES,
        "quota_override": None, "updated": None, "contacts": 1}
    assert rows[alice.id]["updated"] and rows[alice.id]["created"]
    assert rows[bob.id]["used"] == 50 and rows[bob.id]["files"] == 1
    assert rows[bob.id]["quota"] == 5000 == rows[bob.id]["quota_override"]
    assert rows[admin.id]["updated"] is None and rows[admin.id]["files"] == 0
    # Newest first.
    order = [r["id"] for r in client.get("/v1/admin/identities", headers=admin.h).json()["identities"]]
    assert order == [bob.id, alice.id, admin.id]


def test_identity_detail(client, people, admin):
    alice, bob = people(), people()
    alice.befriend(bob)
    laptop = alice.add_device()
    private = put_private(alice, b"a" * 100)
    shared = share(alice, bob, b"b" * 50)
    alice.invite()
    got = client.get(f"/v1/admin/identities/{alice.id}", headers=admin.h).json()
    assert got["id"] == alice.id and got["created"]
    assert got["used"] == 150 and got["quota"] == MAX_STORAGE_BYTES and got["quota_override"] is None
    assert [(d["id"], d["kind"], d["active"]) for d in got["devices"]] == [
        (alice.phone.id, "device", True), (alice.recovery.id, "recovery", True), (laptop.id, "device", True)]
    assert {f["id"]: (f["version"], f["size"], f["members"]) for f in got["files"]} == {
        private: (1, 100, [alice.id]), shared: (1, 50, sorted([alice.id, bob.id]))}
    assert all(f["updated"] for f in got["files"])
    assert got["contacts"] == [bob.id] and got["invitations"] == 1
    assert client.get("/v1/admin/identities/" + b64u(os.urandom(16)), headers=admin.h).status_code == 404


# --- quota override ---


def test_quota_override_is_enforced_and_reset(client, people, admin):
    alice = people()
    file_id = put_private(alice, b"a" * 10)
    assert client.put(f"/v1/admin/identities/{alice.id}/quota", json={"quota": 100}, headers=admin.h).status_code == 204
    assert client.get("/v1/files", headers=alice.h).json()["quota"] == 100
    refused = upload(client, alice.h, 1, b"a" * 101, file_id=file_id)
    assert refused.status_code == 413 and refused.json() == {"detail": "storage quota exceeded", "members": [alice.id]}
    assert upload(client, alice.h, 1, b"a" * 100, file_id=file_id).status_code == 200
    # Raising it above the default lets a bigger file in.
    big = MAX_STORAGE_BYTES + 1000
    client.put(f"/v1/admin/identities/{alice.id}/quota", json={"quota": big}, headers=admin.h)
    assert client.get("/v1/files", headers=alice.h).json()["quota"] == big
    assert upload(client, alice.h, 2, b"a" * (MAX_STORAGE_BYTES + 500), file_id=file_id).status_code == 200
    # null goes back to the default.
    assert client.put(f"/v1/admin/identities/{alice.id}/quota", json={"quota": None}, headers=admin.h).status_code == 204
    assert client.get("/v1/files", headers=alice.h).json()["quota"] == MAX_STORAGE_BYTES
    assert upload(client, alice.h, 3, b"a" * (MAX_STORAGE_BYTES + 1), file_id=file_id).status_code == 413
    assert client.get(f"/v1/admin/identities/{alice.id}", headers=admin.h).json()["quota_override"] is None


def test_quota_override_applies_to_a_shared_file_member(client, people, admin):
    alice, bob = people(), people()
    alice.befriend(bob)
    shared = share(alice, bob, b"x" * 10)
    client.put(f"/v1/admin/identities/{bob.id}/quota", json={"quota": 100}, headers=admin.h)
    r = upload(client, alice.h, 1, b"x" * 101, file_id=shared)
    assert r.status_code == 413 and r.json() == {"detail": "storage quota exceeded", "members": [bob.id]}
    assert upload(client, alice.h, 1, b"x" * 100, file_id=shared).status_code == 200


@pytest.mark.parametrize("quota", [0, -1, MAX_QUOTA_OVERRIDE + 1, 1.5, "100", True, [1]])
def test_quota_bounds(client, people, admin, quota):
    alice = people()
    r = client.put(f"/v1/admin/identities/{alice.id}/quota", json={"quota": quota}, headers=admin.h)
    assert r.status_code == 400, r.text


def test_quota_edge_cases(client, people, admin):
    alice = people()
    for quota in (1, MAX_QUOTA_OVERRIDE):
        assert client.put(f"/v1/admin/identities/{alice.id}/quota", json={"quota": quota},
                          headers=admin.h).status_code == 204
    assert client.put(f"/v1/admin/identities/{alice.id}/quota", json={}, headers=admin.h).status_code == 400
    assert client.put(f"/v1/admin/identities/{alice.id}/quota", content=b"x", headers=admin.h).status_code == 400
    assert client.put("/v1/admin/identities/" + b64u(os.urandom(16)) + "/quota", json={"quota": 5},
                      headers=admin.h).status_code == 404


def test_a_huge_upload_is_refused_early_even_with_the_biggest_override(client, people, admin):
    alice = people()
    client.put(f"/v1/admin/identities/{alice.id}/quota", json={"quota": MAX_QUOTA_OVERRIDE}, headers=admin.h)
    r = client.put(f"/v1/files/{b64u(os.urandom(16))}", headers=alice.h, json={
        "base_version": 0, "ciphertext": "A" * (MAX_QUOTA_OVERRIDE * 4 // 3 + 8), "keys": {}})
    assert r.status_code == 413


# --- backup and restore ---


def test_backup_format(client, people, admin):
    alice, bob = people(), people()
    alice.befriend(bob)
    alice.invite()
    private = put_private(alice, b"secret")
    r = client.get("/v1/admin/backup", headers=admin.h)
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith('attachment; filename="notedown-backup-')
    assert r.headers["content-disposition"].endswith('.json"')
    doc = r.json()
    assert doc["format"] == "notedown-backup" and doc["version"] == 1 and doc["created"]
    assert set(doc["tables"]) == {"identities", "device_entries", "files", "file_members", "file_keys", "contacts",
                                  "invitations"}
    assert {r["id"] for r in doc["tables"]["identities"]} == {admin.id, alice.id, bob.id}
    assert set(doc["tables"]["identities"][0]) == {"id", "identity_key", "created", "quota"}
    assert [f["id"] for f in doc["tables"]["files"]] == [private]
    assert doc["tables"]["files"][0]["ciphertext"] == b64u(b"secret")
    assert len(doc["tables"]["device_entries"]) == 6 and len(doc["tables"]["contacts"]) == 2
    assert len(doc["tables"]["invitations"]) == 1


def state_of(client, person):
    """What a client sees of its identity: files with versions and content, contacts."""
    files = client.get("/v1/files", headers=person.h).json()
    return {"files": {f["id"]: (f["version"], client.get(f"/v1/files/{f['id']}", headers=person.h).json()["ciphertext"])
                      for f in files["files"]},
            "contacts": client.get("/v1/contacts", headers=person.h).json()["contacts"]}


def test_backup_mutate_restore_round_trip(client, people, admin):
    alice, bob = people(), people()
    alice.befriend(bob)
    client.put(f"/v1/admin/identities/{bob.id}/quota", json={"quota": 4000}, headers=admin.h)
    private = put_private(alice, b"before")
    shared = share(alice, bob, b"shared before")
    before = state_of(client, alice), state_of(client, bob)
    epoch_before = client.get("/v1/files", headers=alice.h).json()["epoch"]
    assert epoch_before is None
    backup = client.get("/v1/admin/backup", headers=admin.h).json()

    # Mutate: edits, a removed contact, a new device, a new identity, a new quota.
    upload(client, alice.h, 1, b"after", file_id=private)
    upload(client, alice.h, 1, b"shared after", file_id=shared)
    client.delete(f"/v1/contacts/{bob.id}", headers=alice.h)
    late = alice.add_device()
    carol = people()
    client.put(f"/v1/admin/identities/{bob.id}/quota", json={"quota": None}, headers=admin.h)

    r = client.post("/v1/admin/restore", json=backup, headers=admin.h)
    assert r.status_code == 200, r.text
    assert r.json() == {"identities": 3, "files": 2}

    assert (state_of(client, alice), state_of(client, bob)) == before
    # Tokens still work (devices rebuilt), the new device and identity are gone.
    assert client.get("/v1/files", headers=alice.h).status_code == 200
    challenge = client.get("/v1/auth/challenge").json()["challenge"]
    sig = b64u(late.sign_key.sign(auth.auth_message(challenge)))
    assert client.post("/v1/auth/token", json={"identity": alice.id, "device": late.id, "challenge": challenge,
                                               "sig": sig}).status_code == 401
    assert client.get("/v1/files", headers=carol.h).status_code == 401
    # The quota override came back with the backup, and the epoch changed.
    assert client.get("/v1/files", headers=bob.h).json()["quota"] == 4000
    epoch = client.get("/v1/files", headers=alice.h).json()["epoch"]
    assert epoch and epoch != epoch_before
    assert client.get("/v1/files", headers=bob.h).json()["epoch"] == epoch
    # The restored shared file still takes uploads on top of its restored version.
    assert upload(client, alice.h, 1, b"again", file_id=shared).status_code == 200
    # A second restore changes the epoch again.
    assert client.post("/v1/admin/restore", json=backup, headers=admin.h).status_code == 200
    assert client.get("/v1/files", headers=alice.h).json()["epoch"] not in (None, epoch)


def test_restore_clears_relay_and_rate_limit_rows(client, people, admin):
    backup = client.get("/v1/admin/backup", headers=admin.h).json()
    client.post("/v1/relay")
    assert client.post("/v1/admin/restore", json=backup, headers=admin.h).status_code == 200
    with psycopg.connect(DATABASE_URL) as conn:
        assert conn.execute("SELECT count(*) FROM relay").fetchone()[0] == 0


def test_restore_locks_nobody_out(client, people, admin):
    other = people()
    doc = client.get("/v1/admin/backup", headers=admin.h).json()
    # The admin is not in the backup.
    doc["tables"]["identities"] = [r for r in doc["tables"]["identities"] if r["id"] != admin.id]
    doc["tables"]["device_entries"] = [r for r in doc["tables"]["device_entries"] if r["identity_id"] != admin.id]
    r = client.post("/v1/admin/restore", json=doc, headers=admin.h)
    assert r.status_code == 409 and r.json() == {"detail": "the backup would lock you out"}
    # Nothing was touched.
    assert client.get("/v1/files", headers=other.h).json()["epoch"] is None
    assert client.get("/v1/admin/overview", headers=admin.h).json()["counts"]["identities"] == 2


def test_restore_locks_out_a_device_that_was_not_yet_linked(client, people, admin):
    backup = client.get("/v1/admin/backup", headers=admin.h).json()
    late = admin.add_device()
    late_headers = admin.sign_in(late)
    # The backup predates the device: restoring it from that device would lock it out.
    r = client.post("/v1/admin/restore", json=backup, headers=late_headers)
    assert r.status_code == 409
    assert client.get("/v1/admin/overview", headers=late_headers).status_code == 200


def corrupt(doc, edit):
    doc = copy.deepcopy(doc)
    edit(doc["tables"])
    return doc


def test_restore_refuses_bad_backups(client, people, admin):
    alice = people()
    alice.add_device()
    put_private(alice)
    good = client.get("/v1/admin/backup", headers=admin.h).json()
    before = client.get("/v1/admin/overview", headers=admin.h).json()

    def tamper_entry(t):
        e = next(r for r in t["device_entries"] if r["identity_id"] == alice.id and r["seq"] == 1)
        e["entry"]["device"]["kind"] = "recovery" if e["entry"]["device"]["kind"] == "device" else "device"

    def broken_prev(t):
        next(r for r in t["device_entries"] if r["identity_id"] == alice.id and r["seq"] == 2)["entry"]["prev"] = "x"

    def gap(t):
        t["device_entries"] = [r for r in t["device_entries"] if not (r["identity_id"] == alice.id and r["seq"] == 1)]

    cases = {
        "wrong format": lambda d: d.update(format="other"),
        "wrong version": lambda d: d.update(version=2),
        "no tables": lambda d: d.pop("tables"),
        "missing table": lambda d: d["tables"].pop("files"),
        "tampered chain": lambda d: tamper_entry(d["tables"]),
        "broken chain link": lambda d: broken_prev(d["tables"]),
        "gap in a chain": lambda d: gap(d["tables"]),
        "extra column": lambda d: d["tables"]["files"][0].update(evil="1"),
        "missing column": lambda d: d["tables"]["files"][0].pop("version"),
        "bad ciphertext": lambda d: d["tables"]["files"][0].update(ciphertext="!!"),
        "file of a stranger": lambda d: d["tables"]["files"][0].update(owner=b64u(os.urandom(16))),
        "dangling member": lambda d: d["tables"]["file_members"].append(
            {"file_id": d["tables"]["files"][0]["id"], "identity_id": b64u(os.urandom(16))}),
        "duplicate file": lambda d: d["tables"]["files"].append(copy.deepcopy(d["tables"]["files"][0])),
        "wrong member_key": lambda d: d["tables"]["files"][0].update(member_key="x"),
        "key does not match id": lambda d: d["tables"]["identities"][0].update(id=b64u(os.urandom(16))),
        "quota out of range": lambda d: d["tables"]["identities"][0].update(quota=0),
        "row is not an object": lambda d: d["tables"]["contacts"].append("x"),
        "table is not a list": lambda d: d["tables"].update(contacts={}),
        "bad time": lambda d: d["tables"]["files"][0].update(updated="yesterday"),
    }
    for name, edit in cases.items():
        doc = copy.deepcopy(good)
        edit(doc)
        r = client.post("/v1/admin/restore", json=doc, headers=admin.h)
        assert r.status_code == 400, (name, r.status_code, r.text)
    for body in ([], "x", 1, None):
        assert client.post("/v1/admin/restore", json=body, headers=admin.h).status_code == 400
    assert client.post("/v1/admin/restore", content=b"{", headers=admin.h).status_code == 400
    # Nothing changed, and no epoch was written.
    assert client.get("/v1/admin/overview", headers=admin.h).json() == before | {
        "storage": client.get("/v1/admin/overview", headers=admin.h).json()["storage"]}
    assert client.get("/v1/files", headers=alice.h).json()["epoch"] is None


def test_restore_refuses_rows_that_break_a_constraint(client, people, admin):
    alice = people()
    put_private(alice)
    alice.invite()
    doc = client.get("/v1/admin/backup", headers=admin.h).json()
    doc["tables"]["file_keys"].append(copy.deepcopy(doc["tables"]["file_keys"][0]))
    assert client.post("/v1/admin/restore", json=doc, headers=admin.h).status_code == 400
    assert client.get("/v1/admin/overview", headers=admin.h).json()["counts"]["invitations"] == 1
    assert len(client.get("/v1/files", headers=alice.h).json()["files"]) == 1
