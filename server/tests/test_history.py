"""Version history (docs/server-api.md → "Version history"): the per-identity switch, stored states,
thinning, the key chain, pinning on restore, and backups."""

import psycopg

from notedown_server.protocol import b64u

from conftest import DATABASE_URL
from test_admin import admin, put_private, share  # noqa: F401 (fixture)
from test_api import upload


def switch(client, admin, person, on=True):
    r = client.put(f"/v1/admin/identities/{person.id}/history", json={"history": on}, headers=admin.h)
    assert r.status_code == 204, r.text


def versions(person, file_id):
    r = person.client.get(f"/v1/files/{file_id}/versions", headers=person.h)
    assert r.status_code == 200, r.text
    return r.json()


def sql(statement, params=()):
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        return conn.execute(statement, params)


def test_nothing_is_kept_without_the_switch(client, people, admin):
    alice = people()
    f = put_private(alice, b"one")
    assert upload(client, alice.h, 1, b"two", file_id=f).status_code == 200
    assert versions(alice, f) == {"key_gen": 1, "versions": [], "chain": []}
    assert client.get("/v1/files", headers=alice.h).json()["files"][0]["history"] is False


def test_switched_on_every_upload_keeps_the_state_it_replaces(client, people, admin):
    alice, stranger = people(), people()
    switch(client, admin, alice)
    f = put_private(alice, b"one")
    assert client.get("/v1/files", headers=alice.h).json()["files"][0]["history"] is True
    upload(client, alice.h, 1, b"two", file_id=f)
    upload(client, alice.h, 2, b"three", file_id=f)
    listed = versions(alice, f)
    # Both states fall into the current hour: thinning keeps the first one replaced in it.
    assert [v["version"] for v in listed["versions"]] == [1]
    v = listed["versions"][0]
    assert set(v) == {"version", "updated", "replaced", "size", "key_gen", "pinned", "saved"}
    assert v["size"] == 3 and v["key_gen"] == 1 and v["pinned"] is False
    got = client.get(f"/v1/files/{f}/versions/1", headers=alice.h).json()
    assert got == {"id": f, "version": 1, "ciphertext": b64u(b"one"), "key_gen": 1}
    # Unknown versions, the current one and other people's files are not found.
    for path in (f"/v1/files/{f}/versions/2", f"/v1/files/{f}/versions/3", f"/v1/files/{f}/versions/0",
                 f"/v1/files/{f}/versions/99999999999"):
        assert client.get(path, headers=alice.h).status_code == 404
    assert client.get(f"/v1/files/{f}/versions", headers=stranger.h).status_code == 404
    assert client.get(f"/v1/files/{f}/versions/1", headers=stranger.h).status_code == 404


def test_thinning_keeps_one_state_per_hour_then_per_day(client, people, admin):
    alice = people()
    switch(client, admin, alice)
    f = put_private(alice, b"v1")
    for base in range(1, 9):
        upload(client, alice.h, base, f"v{base + 1}".encode(), file_id=f)
    # Spread the stored states over time (thinning ran for each upload; force the rows back in).
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute("DELETE FROM file_versions WHERE file_id = %s", (f,))
        hour = "date_trunc('hour', now(), 'UTC') - interval '2 hours'"
        day = "date_trunc('day', now(), 'UTC') - interval '3 days'"
        times = {1: f"now() - interval '31 days'",          # too old: goes
                 2: f"{day} + interval '1 hour'",           # first of its day: stays
                 3: f"{day} + interval '5 hours'",          # same day: goes
                 4: f"{hour} + interval '5 minutes'",       # first of its hour: stays
                 5: f"{hour} + interval '10 minutes'",      # same hour: goes
                 6: f"{hour} + interval '15 minutes'",      # same hour but pinned: stays
                 7: f"{hour} + interval '70 minutes'"}      # next hour: stays
        for version, at in times.items():
            conn.execute(f"INSERT INTO file_versions (file_id, version, ciphertext, updated, replaced, key_gen, pinned) "
                         f"VALUES (%s, %s, %s, {at}, {at}, 1, %s)", (f, version, b"x", version == 6))
    upload(client, alice.h, 9, b"v10", file_id=f)   # stores version 9 (replaced now) and thins
    assert [v["version"] for v in versions(alice, f)["versions"]] == [9, 7, 6, 4, 2]


def test_renewing_the_key_needs_the_previous_key_and_extends_the_chain(client, people, admin):
    alice = people()
    switch(client, admin, alice)
    f = put_private(alice, b"one")
    keys = {alice.phone.id: b64u(b"k2")}
    body = {"base_version": 1, "ciphertext": b64u(b"two"), "keys": keys}
    r = client.put(f"/v1/files/{f}", json=body, headers=alice.h)
    assert r.status_code == 400 and "previous_key" in r.json()["detail"]
    assert client.put(f"/v1/files/{f}", json={**body, "previous_key": "x" * 600}, headers=alice.h).status_code == 400
    assert upload(client, alice.h, 1, b"two", keys=keys, file_id=f, previous_key=b64u(b"sealed-1")).status_code == 200
    upload(client, alice.h, 2, b"three", file_id=f)
    listed = versions(alice, f)
    assert listed["key_gen"] == 2
    assert listed["chain"] == [{"gen": 1, "sealed": b64u(b"sealed-1")}]
    assert {v["version"]: v["key_gen"] for v in listed["versions"]} == {1: 1}
    # A new file needs no previous key; adding keys (linking) changes no generation.
    assert client.post(f"/v1/files/{f}/keys", json={"keys": {alice.phone.id: b64u(b"k3")}},
                       headers=alice.h).status_code == 204
    assert versions(alice, f)["key_gen"] == 2


def test_a_restore_pins_the_state_it_replaces(client, people, admin):
    alice = people()
    switch(client, admin, alice)
    f = put_private(alice, b"one")
    upload(client, alice.h, 1, b"two", file_id=f)
    upload(client, alice.h, 2, b"one again", file_id=f, restore=True)
    upload(client, alice.h, 3, b"four", file_id=f)
    listed = versions(alice, f)["versions"]
    assert [(v["version"], v["pinned"]) for v in listed] == [(2, True), (1, False)]


def test_a_shared_file_keeps_history_while_one_member_has_it(client, people, admin):
    alice, bob = people(), people()
    alice.befriend(bob)
    switch(client, admin, bob)
    f = share(alice, bob, b"one")
    upload(client, alice.h, 1, b"two", file_id=f)
    # Every member sees and reads it, the one without the switch too.
    assert [v["version"] for v in versions(alice, f)["versions"]] == [1]
    assert client.get("/v1/files", headers=alice.h).json()["files"][0]["history"] is True
    assert client.get(f"/v1/files/{f}/versions/1", headers=alice.h).status_code == 200
    # Alice's private file keeps none.
    own = put_private(alice, b"mine")
    upload(client, alice.h, 1, b"mine 2", file_id=own)
    assert versions(alice, own)["versions"] == []
    # Switching Alice on and off again leaves Bob's history alone; switching Bob off deletes it.
    switch(client, admin, alice)
    switch(client, admin, alice, False)
    assert len(versions(alice, f)["versions"]) == 1
    switch(client, admin, bob, False)
    assert versions(alice, f)["versions"] == []
    upload(client, alice.h, 2, b"three", file_id=f)
    assert versions(alice, f)["versions"] == []


def test_admin_shows_the_switch_and_the_sizes(client, people, admin):
    alice = people()
    f = put_private(alice, b"12345")
    switch(client, admin, alice)
    upload(client, alice.h, 1, b"678", file_id=f)
    listed = {i["id"]: i for i in client.get("/v1/admin/identities", headers=admin.h).json()["identities"]}
    assert listed[alice.id]["history"] is True and listed[admin.id]["history"] is False
    detail = client.get(f"/v1/admin/identities/{alice.id}", headers=admin.h).json()
    assert detail["history"] is True and detail["history_size"] == 5
    assert client.get("/v1/admin/overview", headers=admin.h).json()["storage"]["history"] == 5
    for bad in ({}, {"history": "yes"}, {"history": None}, {"history": 1}):
        assert client.put(f"/v1/admin/identities/{alice.id}/history", json=bad, headers=admin.h).status_code == 400
    assert client.put("/v1/admin/identities/" + "A" * 22 + "/history", json={"history": True},
                      headers=admin.h).status_code == 404


def test_backup_carries_the_history_and_older_backups_restore_without(client, people, admin):
    alice = people()
    switch(client, admin, alice)
    f = put_private(alice, b"one")
    upload(client, alice.h, 1, b"two", keys={alice.phone.id: b64u(b"k2")}, file_id=f, previous_key=b64u(b"s1"))
    upload(client, alice.h, 2, b"three", file_id=f)
    backup = client.get("/v1/admin/backup", headers=admin.h).json()
    tables = backup["tables"]
    assert [(v["version"], v["key_gen"]) for v in tables["file_versions"]] == [(1, 1)]
    assert tables["file_key_chain"] == [{"file_id": f, "gen": 1, "sealed": b64u(b"s1")}]
    assert tables["files"][0]["key_gen"] == 2
    before = versions(alice, f)
    upload(client, alice.h, 3, b"four", file_id=f)
    switch(client, admin, alice, False)
    assert client.post("/v1/admin/restore", json=backup, headers=admin.h).status_code == 200
    assert versions(alice, f) == before
    assert client.get(f"/v1/admin/identities/{alice.id}", headers=admin.h).json()["history"] is True

    # A backup from before history existed: no versions, no chain, no switch, key generation 1.
    old = {**backup, "tables": {k: v for k, v in tables.items() if k not in ("file_versions", "file_key_chain")}}
    for row in old["tables"]["identities"]:
        row.pop("history")
    for row in old["tables"]["files"]:
        row.pop("key_gen")
    assert client.post("/v1/admin/restore", json=old, headers=admin.h).status_code == 200
    assert versions(alice, f) == {"key_gen": 1, "versions": [], "chain": []}

    # Versions and chain links have to fit their file.
    for edit in (lambda t: t["file_versions"][0].update(version=3),        # not older than the file
                 lambda t: t["file_versions"][0].update(key_gen=3),        # newer key than the file's
                 lambda t: t["file_versions"][0].update(pinned="no"),
                 lambda t: t["file_versions"].append(dict(t["file_versions"][0])),
                 lambda t: t["file_key_chain"][0].update(gen=2),           # the current key isn't in the chain
                 lambda t: t["file_key_chain"][0].update(file_id="B" * 22),
                 lambda t: t["identities"][0].update(history="on")):
        doc = {**backup, "tables": {k: [dict(r) for r in v] for k, v in tables.items()}}
        edit(doc["tables"])
        assert client.post("/v1/admin/restore", json=doc, headers=admin.h).status_code == 400, edit


def test_back_up_now_saves_the_current_state_once(client, people, admin):
    alice, stranger = people(), people()
    f = put_private(alice, b"one")
    # Without a history there is nothing to save into.
    assert client.post(f"/v1/files/{f}/versions", headers=alice.h).status_code == 409
    switch(client, admin, alice)
    assert client.post(f"/v1/files/{f}/versions", headers=stranger.h).status_code == 404
    r = client.post(f"/v1/files/{f}/versions", headers=alice.h)
    assert r.status_code == 200 and r.json() == {"version": 1, "saved": True}
    # Unchanged since: nothing new.
    assert client.post(f"/v1/files/{f}/versions", headers=alice.h).json() == {"version": 1, "saved": False}
    listed = versions(alice, f)["versions"]
    assert [(v["version"], v["pinned"], v["saved"]) for v in listed] == [(1, True, True)]
    assert client.get(f"/v1/files/{f}/versions/1", headers=alice.h).json()["ciphertext"] == b64u(b"one")
    # The next uploads keep the saved copy and thin as before: the saved state doesn't count as the first
    # of its hour, so the state replaced after it stays too.
    upload(client, alice.h, 1, b"two", file_id=f)
    upload(client, alice.h, 2, b"three", file_id=f)
    upload(client, alice.h, 3, b"four", file_id=f)
    listed = versions(alice, f)["versions"]
    assert [(v["version"], v["saved"]) for v in listed] == [(2, False), (1, True)]


def test_a_backup_carries_saved_states(client, people, admin):
    alice = people()
    switch(client, admin, alice)
    f = put_private(alice, b"one")
    client.post(f"/v1/files/{f}/versions", headers=alice.h)
    backup = client.get("/v1/admin/backup", headers=admin.h).json()
    assert [(v["version"], v["saved"]) for v in backup["tables"]["file_versions"]] == [(1, True)]
    assert client.post("/v1/admin/restore", json=backup, headers=admin.h).status_code == 200
    assert [(v["version"], v["saved"]) for v in versions(alice, f)["versions"]] == [(1, True)]
    # Only a saved state may be the current one.
    backup["tables"]["file_versions"][0]["saved"] = False
    assert client.post("/v1/admin/restore", json=backup, headers=admin.h).status_code == 400
