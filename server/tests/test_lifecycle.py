"""Blocking and deleting identities (backlog #34, docs/server-api.md → "Blocked and deleted identities"):
the admin blocks or deletes, the user deletes with the identity key."""

from datetime import datetime, timedelta, timezone

import psycopg

from notedown_server import auth
from notedown_server.protocol import b64u

from conftest import DATABASE_URL, HOST
from test_admin import admin, put_private, share   # noqa: F401 (fixture)
from test_api import upload


def block(client, admin, who, blocked=True, until=None):
    body = {"blocked": blocked} | ({"until": until} if until is not None else {})
    return client.put(f"/v1/admin/identities/{who.id}/block", json=body, headers=admin.h)


def self_delete(client, person, key=None):
    challenge = client.get("/v1/auth/challenge").json()["challenge"]
    sig = b64u((key or person.identity.key).sign_key.sign(auth.delete_message(HOST, person.id, challenge)))
    return client.post(f"/v1/identities/{person.id}/delete", json={"challenge": challenge, "sig": sig})


def sign_in_status(client, person):
    challenge = client.get("/v1/auth/challenge").json()["challenge"]
    sig = b64u(person.phone.sign_key.sign(auth.auth_message(HOST, person.id, person.phone.id, challenge)))
    return client.post("/v1/auth/token", json={
        "identity": person.id, "device": person.phone.id, "challenge": challenge, "sig": sig})


# --- blocking ---


def test_a_block_locks_every_device_out_until_lifted(client, people, admin):
    alice = people()
    assert block(client, admin, alice).status_code == 204
    r = client.get("/v1/files", headers=alice.h)   # a token from before the block
    assert r.status_code == 423 and r.json() == {"detail": "identity is blocked", "until": None}
    assert sign_in_status(client, alice).status_code == 423
    row = {r["id"]: r for r in client.get("/v1/admin/identities", headers=admin.h).json()["identities"]}[alice.id]
    assert row["blocked"] is True and row["blocked_until"] is None
    assert client.get("/v1/admin/overview", headers=admin.h).json()["counts"]["blocked"] == 1
    assert block(client, admin, alice, False).status_code == 204
    assert client.get("/v1/files", headers=alice.h).status_code == 200


def test_a_block_with_an_end_names_it_and_ends_by_itself(client, people, admin):
    alice = people()
    until = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
    assert block(client, admin, alice, until=until).status_code == 204
    r = client.get("/v1/files", headers=alice.h)
    assert r.status_code == 423 and datetime.fromisoformat(r.json()["until"]) == datetime.fromisoformat(until)
    detail = client.get(f"/v1/admin/identities/{alice.id}", headers=admin.h).json()
    assert detail["blocked"] is True and datetime.fromisoformat(detail["blocked_until"]) == datetime.fromisoformat(until)
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:   # the end passes
        conn.execute("UPDATE identities SET blocked_until = now() - interval '1 minute' WHERE id = %s", (alice.id,))
    assert client.get("/v1/files", headers=alice.h).status_code == 200
    detail = client.get(f"/v1/admin/identities/{alice.id}", headers=admin.h).json()
    assert detail["blocked"] is False and detail["blocked_until"] is None


def test_a_blocked_identity_does_not_stop_the_others(client, people, admin):
    alice, bob = people(), people()
    alice.befriend(bob)
    file_id = share(alice, bob)
    block(client, admin, bob)
    assert upload(client, alice.h, 1, b"next", file_id=file_id).status_code == 200
    assert client.get(f"/v1/identities/{bob.id}", headers=alice.h).status_code == 200


def test_block_input(client, people, admin):
    alice = people()
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    for body in ({}, {"blocked": "yes"}, {"blocked": True, "until": "soon"}, {"blocked": True, "until": past},
                 {"blocked": True, "until": "2099-01-01T00:00:00"}, {"blocked": False, "until": "2099-01-01T00:00:00Z"}):
        r = client.put(f"/v1/admin/identities/{alice.id}/block", json=body, headers=admin.h)
        assert r.status_code == 400, body
    assert client.put("/v1/admin/identities/" + b64u(b"x" * 16) + "/block", json={"blocked": True},
                      headers=admin.h).status_code == 404
    r = client.put(f"/v1/admin/identities/{admin.id}/block", json={"blocked": True}, headers=admin.h)
    assert r.status_code == 409
    assert client.delete(f"/v1/admin/identities/{admin.id}", headers=admin.h).status_code == 409


# --- deleting ---


def test_deleting_removes_everything_but_what_others_share(client, people, admin):
    alice, bob, carol = people(), people(), people()
    alice.befriend(bob)
    alice.befriend(carol)
    private = put_private(alice, b"a" * 100)
    shared = share(alice, bob, b"b" * 50)
    alice.invite()
    iid, _ = carol.invite()
    alice.request(iid, carol)
    assert client.delete(f"/v1/admin/identities/{alice.id}", headers=admin.h).status_code == 204

    # Alice's devices learn about it, her private file and everything about her are gone.
    assert client.get("/v1/files", headers=alice.h).status_code == 410
    assert sign_in_status(client, alice).status_code == 410
    with psycopg.connect(DATABASE_URL) as conn:
        assert conn.execute("SELECT count(*) FROM files WHERE id = %s", (private,)).fetchone()[0] == 0
        for sql in ("SELECT count(*) FROM devices WHERE identity_id = %(i)s",
                    "SELECT count(*) FROM device_entries WHERE identity_id = %(i)s",
                    "SELECT count(*) FROM contacts WHERE a = %(i)s OR b = %(i)s",
                    "SELECT count(*) FROM invitations WHERE identity_id = %(i)s OR requester = %(i)s",
                    "SELECT count(*) FROM file_keys WHERE device_id = %(d)s"):
            assert conn.execute(sql, {"i": alice.id, "d": alice.phone.id}).fetchone()[0] == 0, sql
    # Bob keeps the shared file with its member set; Alice's list has no devices left.
    files = client.get("/v1/files", headers=bob.h).json()["files"]
    assert [(f["id"], f["members"]) for f in files] == [(shared, sorted([alice.id, bob.id]))]
    assert client.get("/v1/files", headers=bob.h).json()["deleted"] == [alice.id]
    assert client.get("/v1/files", headers=carol.h).json()["deleted"] == []
    assert client.get(f"/v1/identities/{alice.id}", headers=bob.h).json() == {
        "identity_key": b64u(alice.identity.key.sign), "entries": [], "deleted": True}
    assert client.get(f"/v1/identities/{alice.id}", headers=carol.h).status_code == 404   # no longer a contact
    assert upload(client, bob.h, 1, b"n" * 60, keys={bob.phone.id: b64u(b"k2")}, file_id=shared).status_code == 200
    # The admin page no longer lists her; deleting again is unknown.
    ids = [r["id"] for r in client.get("/v1/admin/identities", headers=admin.h).json()["identities"]]
    assert alice.id not in ids
    assert client.get(f"/v1/admin/identities/{alice.id}", headers=admin.h).status_code == 404
    assert client.delete(f"/v1/admin/identities/{alice.id}", headers=admin.h).status_code == 404
    assert client.get("/v1/admin/overview", headers=admin.h).json()["counts"]["identities"] == 3
    # Once Bob deletes too, the shared file goes.
    assert self_delete(client, bob).status_code == 204
    with psycopg.connect(DATABASE_URL) as conn:
        assert conn.execute("SELECT count(*) FROM files").fetchone()[0] == 0


def test_a_deleted_member_has_no_limits(client, people, admin):
    alice, bob = people(), people()
    alice.befriend(bob)
    shared = share(alice, bob, b"b" * 50)
    client.put(f"/v1/admin/identities/{alice.id}/quota", json={"quota": 60}, headers=admin.h)
    client.delete(f"/v1/admin/identities/{alice.id}", headers=admin.h)
    assert upload(client, bob.h, 1, b"n" * 100, file_id=shared).status_code == 200


def test_the_user_deletes_with_the_identity_key(client, people):
    alice = people()
    put_private(alice)
    assert self_delete(client, alice, key=alice.phone).status_code == 403   # a device key is not enough
    assert client.get("/v1/files", headers=alice.h).status_code == 200
    assert self_delete(client, alice).status_code == 204
    assert client.get("/v1/files", headers=alice.h).status_code == 410
    assert self_delete(client, alice).status_code == 204   # twice: nothing changes
    assert client.post("/v1/identities/" + b64u(b"x" * 16) + "/delete", json={
        "challenge": client.get("/v1/auth/challenge").json()["challenge"], "sig": b64u(b"s" * 64)}).status_code == 404


def test_a_blocked_user_can_still_delete(client, people, admin):
    alice = people()
    block(client, admin, alice)
    assert self_delete(client, alice).status_code == 204
    assert client.get("/v1/files", headers=alice.h).status_code == 410


def test_a_delete_signature_made_for_another_server_deletes_nothing(client, people):
    """Security review H1: the delete page signs for the server it talks to; another server can't pass it on."""
    alice, bob = people(), people()
    challenge = client.get("/v1/auth/challenge").json()["challenge"]
    for message in (auth.delete_message("evil.example", alice.id, challenge), auth.delete_message(HOST, bob.id, challenge),
                    f"notedown-delete-v1:{challenge}".encode()):
        sig = b64u(alice.identity.key.sign_key.sign(message))
        r = client.post(f"/v1/identities/{alice.id}/delete", json={"challenge": challenge, "sig": sig})
        assert r.status_code == 403, message
    assert client.get("/v1/files", headers=alice.h).status_code == 200


def test_the_delete_signature_is_not_a_sign_in(client, people):
    alice = people()
    challenge = client.get("/v1/auth/challenge").json()["challenge"]
    sig = b64u(alice.identity.key.sign_key.sign(auth.auth_message(HOST, alice.id, alice.id, challenge)))
    r = client.post(f"/v1/identities/{alice.id}/delete", json={"challenge": challenge, "sig": sig})
    assert r.status_code == 403
    r = client.post(f"/v1/identities/{alice.id}/delete", json={"challenge": "bogus", "sig": sig})
    assert r.status_code == 400


def test_backup_and_restore_keep_blocks_and_deletions(client, people, admin):
    alice, bob, carol = people(), people(), people()
    alice.befriend(bob)
    share(alice, bob)
    until = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
    block(client, admin, carol, until=until)
    client.delete(f"/v1/admin/identities/{alice.id}", headers=admin.h)
    doc = client.get("/v1/admin/backup", headers=admin.h).json()
    rows = {r["id"]: r for r in doc["tables"]["identities"]}
    assert rows[alice.id]["deleted"] and rows[carol.id]["blocked"] is True
    assert client.post("/v1/admin/restore", json=doc, headers=admin.h).status_code == 200
    assert client.get("/v1/files", headers=carol.h).status_code == 423
    assert client.get(f"/v1/identities/{alice.id}", headers=bob.h).json()["deleted"] is True
    # A deleted identity with a device list doesn't fit, nor does a live one without.
    bad = {**doc, "tables": {**doc["tables"], "identities": [
        {**r, "deleted": None} if r["id"] == alice.id else r for r in doc["tables"]["identities"]]}}
    assert client.post("/v1/admin/restore", json=bad, headers=admin.h).status_code == 400
    # A backup from before blocking existed restores with nobody blocked.
    old = {**doc, "tables": {**doc["tables"], "identities": [
        {k: v for k, v in r.items() if k not in ("blocked", "blocked_until", "deleted")}
        for r in doc["tables"]["identities"]]}}
    old["tables"]["identities"] = [r for r in old["tables"]["identities"] if r["id"] != alice.id]
    old["tables"]["file_members"] = old["tables"]["files"] = old["tables"]["file_keys"] = []
    old["tables"]["file_versions"] = old["tables"]["file_key_chain"] = []
    assert client.post("/v1/admin/restore", json=old, headers=admin.h).status_code == 200
    assert client.get("/v1/files", headers=carol.h).status_code == 200
