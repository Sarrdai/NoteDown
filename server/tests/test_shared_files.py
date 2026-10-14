"""Shared files with a fixed member set (docs/server-api.md → "Endpoints", Members and Upload)."""

import os

import psycopg

from notedown_server.app import MAX_FILES, MAX_STORAGE_BYTES
from notedown_server.protocol import b64u

from conftest import DATABASE_URL, Keys
from test_api import upload


def fid() -> str:
    return b64u(os.urandom(16))


def keys_for(*people) -> dict:
    return {d.id: b64u(b"key-" + d.id[:4].encode()) for p in people for d in (p.phone, p.recovery)}


def create_shared(owner, *others, file_id=None, data=b"cipher"):
    members = sorted([owner.id, *[o.id for o in others]])
    return upload(owner.client, owner.h, 0, data, keys=keys_for(owner, *others), file_id=file_id or fid(),
                  members=members)


def test_shared_file_is_created_with_members_and_listed_for_all_of_them(people):
    alice, bob, carol = people(), people(), people()
    alice.befriend(bob)
    alice.befriend(carol)
    f = fid()
    assert create_shared(alice, bob, carol, file_id=f).json() == {"version": 1}
    expected = sorted([alice.id, bob.id, carol.id])
    for p in (alice, bob, carol):
        files = p.client.get("/v1/files", headers=p.h).json()["files"]
        assert [(x["id"], x["members"], x["size"]) for x in files] == [(f, expected, 6)]


def test_private_file_has_the_caller_as_only_member(people):
    alice = people()
    f = fid()
    assert upload(alice.client, alice.h, 0, keys=keys_for(alice), file_id=f).status_code == 200
    assert alice.client.get("/v1/files", headers=alice.h).json()["files"][0]["members"] == [alice.id]


def test_members_must_include_the_caller_and_be_valid(people):
    alice, bob = people(), people()
    alice.befriend(bob)
    for members in ([bob.id], [], [alice.id, alice.id], [alice.id, "x"], [alice.id, bob.id, "x"]):
        r = upload(alice.client, alice.h, 0, keys=keys_for(alice, bob), file_id=fid(), members=members)
        assert r.status_code == 400, members


def test_every_other_member_must_be_a_contact(people):
    alice, bob, carol = people(), people(), people()
    alice.befriend(bob)
    r = create_shared(alice, bob, carol)
    assert r.status_code == 403
    assert create_shared(alice, carol).status_code == 403
    assert alice.client.get("/v1/files", headers=alice.h).json()["files"] == []
    # Contacts are mutual: after Alice removed Bob, she can't start a file with him.
    alice.client.delete(f"/v1/contacts/{bob.id}", headers=alice.h)
    assert create_shared(alice, bob).status_code == 403


def test_at_most_twenty_members(people):
    alice = people()
    others = [people() for _ in range(20)]
    for o in others:
        alice.befriend(o)
    assert create_shared(alice, *others).status_code == 400            # 21
    assert create_shared(alice, *others[:19]).status_code == 200       # 20


def test_a_member_set_has_one_file_and_the_second_create_names_it(people):
    alice, bob = people(), people()
    alice.befriend(bob)
    first = fid()
    assert create_shared(alice, bob, file_id=first).status_code == 200
    upload(alice.client, alice.h, 1, b"v2", file_id=first)
    # Bob (another device, another file ID, the same set) gets the existing file.
    r = create_shared(bob, alice)
    assert r.status_code == 409
    assert r.json() == {"detail": "file exists", "id": first, "version": 2}
    # The private files stay separate sets.
    assert upload(alice.client, alice.h, 0, keys=keys_for(alice), file_id=fid()).status_code == 200
    assert upload(alice.client, alice.h, 0, keys=keys_for(alice), file_id=fid()).status_code == 409


def test_members_read_write_and_add_keys_non_members_see_nothing(people):
    alice, bob, carol = people(), people(), people()
    alice.befriend(bob)
    f = fid()
    create_shared(alice, bob, file_id=f, data=b"v1")
    path = f"/v1/files/{f}"
    got = bob.client.get(path, headers=bob.h).json()
    assert got == {"id": f, "version": 1, "ciphertext": b64u(b"v1"), "key": keys_for(bob)[bob.phone.id]}
    assert upload(bob.client, bob.h, 1, b"by-bob", file_id=f).json() == {"version": 2}
    assert alice.client.get(path, headers=alice.h).json()["ciphertext"] == b64u(b"by-bob")
    laptop = bob.add_device()
    assert bob.client.post(f"{path}/keys", json={"keys": {laptop.id: b64u(b"k-laptop")}},
                           headers=bob.h).status_code == 204
    assert bob.client.get(path, headers=bob.sign_in(laptop)).json()["key"] == b64u(b"k-laptop")

    assert carol.client.get(path, headers=carol.h).status_code == 404
    assert upload(carol.client, carol.h, 2, file_id=f).status_code == 404
    assert carol.client.post(f"{path}/keys", json={"keys": {carol.phone.id: b64u(b"k")}},
                             headers=carol.h).status_code == 404
    assert carol.client.get("/v1/files", headers=carol.h).json()["files"] == []
    # A member can't smuggle in members.
    assert upload(alice.client, alice.h, 2, file_id=f, members=[alice.id]).status_code == 400


def test_keys_may_belong_to_devices_of_any_member_but_nobody_else(people):
    alice, bob, carol = people(), people(), people()
    alice.befriend(bob)
    f = fid()
    # Bob's devices are fine in a shared file, Carol's and unknown ones are not.
    assert upload(alice.client, alice.h, 0, keys={alice.phone.id: b64u(b"k"), carol.phone.id: b64u(b"k")},
                  file_id=f, members=sorted([alice.id, bob.id])).status_code == 400
    assert upload(alice.client, alice.h, 0, keys=keys_for(alice, bob), file_id=f,
                  members=sorted([alice.id, bob.id])).status_code == 200
    path = f"/v1/files/{f}/keys"
    assert alice.client.post(path, json={"keys": {bob.phone.id: b64u(b"k2")}}, headers=alice.h).status_code == 204
    assert bob.client.get(f"/v1/files/{f}", headers=bob.h).json()["key"] == b64u(b"k2")
    for stranger in (carol.phone.id, Keys().id):
        assert alice.client.post(path, json={"keys": {stranger: b64u(b"k")}}, headers=alice.h).status_code == 400
        assert upload(alice.client, alice.h, 1, keys={stranger: b64u(b"k")}, file_id=f).status_code == 400
    # Replacing the keys works with devices of both members (renewing the file key).
    assert upload(bob.client, bob.h, 1, keys=keys_for(alice, bob), file_id=f).json() == {"version": 2}


def test_quota_and_file_count_are_per_member_over_all_files(people):
    alice, bob, carol = people(), people(), people()
    alice.befriend(bob)
    bob.befriend(carol)
    half = MAX_STORAGE_BYTES // 2
    assert create_shared(alice, bob, data=b"s" * half).status_code == 200
    # The shared file counts for Bob as well as for Alice.
    assert upload(bob.client, bob.h, 0, b"p" * half, keys=keys_for(bob), file_id=fid()).status_code == 200
    r = create_shared(bob, carol, data=b"p")
    assert r.status_code == 413 and r.json() == {"detail": "storage quota exceeded", "members": [bob.id]}
    # Bob is full, so Alice can't grow the file they share although she has room (backlog #27).
    shared = alice.client.get("/v1/files", headers=alice.h).json()["files"]
    shared = next(f["id"] for f in shared if len(f["members"]) == 2)
    r = upload(alice.client, alice.h, 1, b"s" * (half + 1), file_id=shared)
    assert r.status_code == 413 and r.json() == {"detail": "storage quota exceeded", "members": [bob.id]}
    # Replacing the shared file doesn't count its old size: the same size or smaller fits.
    assert upload(alice.client, alice.h, 1, b"s" * half, file_id=shared).status_code == 200
    assert upload(alice.client, alice.h, 0, b"p" * half, keys=keys_for(alice), file_id=fid()).status_code == 200
    # Now both are full; everyone over the limit is named.
    r = upload(bob.client, bob.h, 2, b"s" * (half + 1), file_id=shared)
    assert r.status_code == 413 and r.json()["members"] == sorted([alice.id, bob.id])


def test_the_file_count_limit_counts_shared_files_for_every_member(people):
    alice = people()
    friends = [people() for _ in range(MAX_FILES - 1)]
    for friend in friends:
        alice.befriend(friend)
    assert upload(alice.client, alice.h, 0, keys=keys_for(alice), file_id=fid()).status_code == 200
    for friend in friends:
        assert create_shared(alice, friend).status_code == 200
    # Alice is a member of 50 files now: a new contact can't share a file with her either.
    other = people()
    alice.befriend(other)
    assert create_shared(alice, other).json() == {"detail": "too many files", "members": [alice.id]}
    r = create_shared(other, alice)
    assert r.status_code == 413 and r.json() == {"detail": "too many files", "members": [alice.id]}


def test_removing_a_device_deletes_its_keys_in_every_file_it_belongs_to(people):
    alice, bob = people(), people()
    alice.befriend(bob)
    laptop = bob.add_device()
    private, shared = fid(), fid()
    keys = {**keys_for(bob), laptop.id: b64u(b"k-laptop")}
    assert upload(bob.client, bob.h, 0, keys=keys, file_id=private).status_code == 200
    # Alice created the shared file; the laptop's key was added by Bob.
    assert create_shared(alice, bob, file_id=shared).status_code == 200
    bob.client.post(f"/v1/files/{shared}/keys", json={"keys": {laptop.id: b64u(b"k-laptop")}}, headers=bob.h)
    hl = bob.sign_in(laptop)
    assert bob.client.get(f"/v1/files/{shared}", headers=hl).json()["key"] == b64u(b"k-laptop")

    entry = bob.identity.entry("remove", {"id": laptop.id}, signer=bob.phone)
    assert bob.client.post(f"/v1/identities/{bob.id}/entries", json={"entry": entry}, headers=bob.h).status_code == 201
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        left = {tuple(r) for r in conn.execute("SELECT file_id, device_id FROM file_keys")}
    assert {d for _, d in left}.isdisjoint({laptop.id})
    assert (shared, bob.phone.id) in left and (private, bob.phone.id) in left


def test_removing_a_device_leaves_the_keys_of_files_it_is_not_in(people):
    # Device IDs are hashes of public keys, so another identity can list the same device.
    alice, bob = people(), people()
    f = fid()
    assert upload(alice.client, alice.h, 0, keys=keys_for(alice), file_id=f).status_code == 200
    entry = bob.identity.entry("add", alice.phone.device(), signer=bob.phone)
    assert bob.client.post(f"/v1/identities/{bob.id}/entries", json={"entry": entry}, headers=bob.h).status_code == 201
    entry = bob.identity.entry("remove", {"id": alice.phone.id}, signer=bob.phone)
    assert bob.client.post(f"/v1/identities/{bob.id}/entries", json={"entry": entry}, headers=bob.h).status_code == 201
    assert alice.client.get(f"/v1/files/{f}", headers=alice.h).json()["key"] == keys_for(alice)[alice.phone.id]


def test_files_are_listed_in_id_order_with_sorted_members(people):
    alice, bob = people(), people()
    alice.befriend(bob)
    ids = sorted(fid() for _ in range(3))
    upload(alice.client, alice.h, 0, keys=keys_for(alice), file_id=ids[2])
    create_shared(alice, bob, file_id=ids[0])
    listed = bob.client.get("/v1/files", headers=bob.h).json()
    assert [f["id"] for f in listed["files"]] == [ids[0]]
    assert listed["files"][0]["members"] == sorted([alice.id, bob.id])
    assert [f["id"] for f in alice.client.get("/v1/files", headers=alice.h).json()["files"]] == [ids[0], ids[2]]


# --- schema migration of a milestone-1 database ---

OLD_SCHEMA = """
DROP TABLE IF EXISTS contacts, invitations, file_members, file_keys, files, devices, device_entries,
    identities, relay, rate_limits CASCADE;
CREATE TABLE identities (id text PRIMARY KEY, identity_key bytea NOT NULL, created timestamptz NOT NULL DEFAULT now());
CREATE TABLE files (id text PRIMARY KEY, owner text NOT NULL REFERENCES identities (id), version integer NOT NULL,
    ciphertext bytea NOT NULL, updated timestamptz NOT NULL DEFAULT now());
CREATE TABLE file_keys (file_id text NOT NULL REFERENCES files (id) ON DELETE CASCADE, device_id text NOT NULL,
    wrapped text NOT NULL, PRIMARY KEY (file_id, device_id));
"""


def test_a_milestone_1_database_is_migrated_and_the_migration_can_be_rerun(client):
    from fastapi.testclient import TestClient

    from notedown_server.app import Settings, create_app
    from conftest import DATABASE_URL, SECRET

    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute(OLD_SCHEMA)
        conn.execute("INSERT INTO identities (id, identity_key) VALUES ('a', 'x'), ('b', 'x')")
        # 'a' has two private files from milestone 1, 'b' one.
        conn.execute("INSERT INTO files (id, owner, version, ciphertext, updated) VALUES "
                     "('f1', 'a', 1, 'x', now() - interval '2 days'), ('f2', 'a', 1, 'x', now()), "
                     "('f3', 'b', 1, 'x', now())")
    settings = Settings(DATABASE_URL, SECRET, ["https://localhost"], rate_limits=False)
    for _ in range(2):                      # applied at every start
        with TestClient(create_app(settings)):
            pass
        with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
            assert {tuple(r) for r in conn.execute("SELECT file_id, identity_id FROM file_members")} == {
                ("f1", "a"), ("f2", "a"), ("f3", "b")}
            assert {tuple(r) for r in conn.execute("SELECT id, member_key FROM files")} == {
                ("f1", "a"), ("f2", None), ("f3", "b")}
