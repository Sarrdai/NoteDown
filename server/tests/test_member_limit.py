"""The limit of members per file (docs/server-api.md → "Limits"): the server-wide default the admin sets, the
override per identity, how it is checked when a file is created, and that a backup carries the override."""

import pytest

from notedown_server.protocol import MAX_MEMBERS

from test_admin import admin  # noqa: F401 (fixture)
from test_api import upload
from test_shared_files import create_shared


def set_server(client, admin, value):
    r = client.put("/v1/admin/max-members", json={"max_members": value}, headers=admin.h)
    assert r.status_code == 204, r.text


def set_identity(client, admin, person, value):
    r = client.put(f"/v1/admin/identities/{person.id}/max-members", json={"max_members": value}, headers=admin.h)
    assert r.status_code == 204, r.text


def listed_limit(person):
    return person.client.get("/v1/files", headers=person.h).json()["max_members"]


def friends(people, owner, n):
    others = [people() for _ in range(n)]
    for o in others:
        owner.befriend(o)
    return others


def test_the_server_wide_limit_applies_to_new_files(client, people, admin):
    alice = people()
    others = friends(people, alice, 3)
    assert listed_limit(alice) == 20
    set_server(client, admin, 3)
    assert listed_limit(alice) == 3
    got = client.get("/v1/admin/overview", headers=admin.h).json()
    assert (got["max_members"], got["max_members_override"]) == (3, 3)
    r = create_shared(alice, *others)                                    # 4 members
    assert r.status_code == 400 and r.json() == {"detail": "too many members"}
    assert create_shared(alice, *others[:2]).status_code == 200          # 3
    # null goes back to the default.
    set_server(client, admin, None)
    assert listed_limit(alice) == 20
    got = client.get("/v1/admin/overview", headers=admin.h).json()
    assert (got["max_members"], got["max_members_override"]) == (20, None)
    assert create_shared(alice, *others).status_code == 200


def test_a_lower_limit_leaves_existing_files_as_they_are(client, people, admin):
    alice = people()
    others = friends(people, alice, 3)
    assert create_shared(alice, *others).status_code == 200
    set_server(client, admin, 2)
    file_id = alice.client.get("/v1/files", headers=alice.h).json()["files"][0]["id"]
    for p in (alice, *others):
        version = p.client.get("/v1/files", headers=p.h).json()["files"][0]["version"]
        assert upload(p.client, p.h, version, b"edit", file_id=file_id).status_code == 200


def test_the_override_per_identity_counts_for_the_files_it_creates(client, people, admin):
    alice, bob = people(), people()
    others = friends(people, alice, 4)
    bob.befriend(others[0])
    set_server(client, admin, 2)
    set_identity(client, admin, alice, 5)
    assert listed_limit(alice) == 5 and listed_limit(bob) == 2
    rows = {r["id"]: r for r in client.get("/v1/admin/identities", headers=admin.h).json()["identities"]}
    assert (rows[alice.id]["max_members"], rows[alice.id]["max_members_override"]) == (5, 5)
    assert (rows[bob.id]["max_members"], rows[bob.id]["max_members_override"]) == (2, None)
    detail = client.get(f"/v1/admin/identities/{alice.id}", headers=admin.h).json()
    assert (detail["max_members"], detail["max_members_override"]) == (5, 5)
    assert create_shared(alice, *others).status_code == 200              # 5 members, Alice's limit
    bob.befriend(others[1])
    assert create_shared(bob, *others[:2]).status_code == 400             # 3, Bob's limit is 2
    # An override below the server-wide limit counts too, and null resets it.
    set_server(client, admin, None)
    set_identity(client, admin, bob, 2)
    assert listed_limit(bob) == 2
    set_identity(client, admin, bob, None)
    assert listed_limit(bob) == 20 and create_shared(bob, *others[:2]).status_code == 200


@pytest.mark.parametrize("value", [1, MAX_MEMBERS + 1, "5", 2.0, True])
def test_limit_bounds(client, people, admin, value):
    alice = people()
    for path in ("/v1/admin/max-members", f"/v1/admin/identities/{alice.id}/max-members"):
        assert client.put(path, json={"max_members": value}, headers=admin.h).status_code == 400
    assert client.put("/v1/admin/max-members", json={}, headers=admin.h).status_code == 400


def test_the_hard_cap_and_unknown_identities(client, people, admin):
    alice = people()
    set_identity(client, admin, alice, MAX_MEMBERS)
    assert client.put("/v1/admin/identities/" + "A" * 22 + "/max-members", json={"max_members": 5},
                      headers=admin.h).status_code == 404


def test_backup_carries_the_override(client, people, admin):
    alice = people()
    set_identity(client, admin, alice, 7)
    backup = client.get("/v1/admin/backup", headers=admin.h).json()
    row = next(r for r in backup["tables"]["identities"] if r["id"] == alice.id)
    assert row["max_members"] == 7
    set_identity(client, admin, alice, None)
    assert client.post("/v1/admin/restore", json=backup, headers=admin.h).status_code == 200
    assert listed_limit(alice) == 7
    # Older backups without it restore with no override; one out of range is refused.
    for r in backup["tables"]["identities"]:
        r.pop("max_members")
    assert client.post("/v1/admin/restore", json=backup, headers=admin.h).status_code == 200
    assert listed_limit(alice) == 20
    next(r for r in backup["tables"]["identities"] if r["id"] == alice.id)["max_members"] = 1
    assert client.post("/v1/admin/restore", json=backup, headers=admin.h).status_code == 400
