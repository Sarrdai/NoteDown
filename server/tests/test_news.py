"""News posts (docs/server-api.md → "News"): the feed, its version, the admin endpoints, the limits, backup."""

import copy
import os
import time

import pytest

from notedown_server.protocol import MAX_NEWS, MAX_NEWS_BODY, MAX_NEWS_PUBLISHED, b64u

from test_admin import NOT_FOUND, admin  # noqa: F401  (the fixture)

TOO_MANY = {"detail": "too many news"}


def publish(client, admin, body="## Post"):
    r = client.post("/v1/admin/news", json={"body": body}, headers=admin.h)
    assert r.status_code == 201, r.text
    return r.json()


def feed(client, who):
    r = client.get("/v1/news", headers=who.h)
    assert r.status_code == 200, r.text
    return r.json()


def version(client, who):
    return client.get("/v1/files", headers=who.h).json()["news"]


def admin_posts(client, admin):
    return {p["id"]: p for p in client.get("/v1/admin/news", headers=admin.h).json()["news"]}


# --- the feed ---


def test_no_news_yet(client, people, admin):
    alice = people()
    assert feed(client, alice) == {"version": None, "news": []}
    assert version(client, alice) is None
    assert client.get("/v1/admin/news", headers=admin.h).json() == {"news": []}


def test_the_feed_needs_a_signed_in_identity_but_not_the_admin(client, people, admin):
    alice = people()
    publish(client, admin, "## Hello")
    assert client.get("/v1/news").status_code == 401
    assert client.get("/v1/news", headers={"Authorization": "Bearer nonsense"}).status_code == 401
    assert [p["body"] for p in feed(client, alice)["news"]] == ["## Hello"]


def test_the_feed_lists_published_posts_newest_first(client, people, admin):
    alice = people()
    first, second, third = (publish(client, admin, f"## {n}") for n in ("one", "two", "three"))
    assert client.put(f"/v1/admin/news/{second['id']}", json={"archived": True}, headers=admin.h).status_code == 204
    got = feed(client, alice)
    assert [p["id"] for p in got["news"]] == [third["id"], first["id"]]
    assert set(got["news"][0]) == {"id", "created", "modified", "body"}
    assert got["news"][0] == {"id": third["id"], "created": third["created"], "modified": third["modified"],
                              "body": "## three"}
    assert got["version"] == version(client, alice) and got["version"]
    # Times are ISO 8601 UTC.
    assert third["created"].endswith("+00:00") and third["created"] == third["modified"]
    # The admin list has them all, archived ones included, newest first.
    listed = client.get("/v1/admin/news", headers=admin.h).json()["news"]
    assert [(p["id"], p["archived"]) for p in listed] == [
        (third["id"], False), (second["id"], True), (first["id"], False)]
    assert set(listed[0]) == {"id", "created", "modified", "body", "archived"}


def test_create_answers_id_and_times(client, admin):
    r = client.post("/v1/admin/news", json={"body": "## New"}, headers=admin.h)
    assert r.status_code == 201
    got = r.json()
    assert set(got) == {"id", "created", "modified"} and len(got["id"]) == 22
    assert admin_posts(client, admin)[got["id"]] == {**got, "body": "## New", "archived": False}


# --- the version ---


def test_the_version_changes_with_every_change(client, people, admin):
    alice = people()
    seen = [version(client, alice)]

    def changed():
        seen.append(version(client, alice))
        assert seen[-1] and seen[-1] != seen[-2], seen
        assert feed(client, alice)["version"] == seen[-1]

    post = publish(client, admin)
    changed()
    client.put(f"/v1/admin/news/{post['id']}", json={"body": "## Edited"}, headers=admin.h)
    changed()
    client.put(f"/v1/admin/news/{post['id']}", json={"archived": True}, headers=admin.h)
    changed()
    client.put(f"/v1/admin/news/{post['id']}", json={"archived": False}, headers=admin.h)
    changed()
    client.delete(f"/v1/admin/news/{post['id']}", headers=admin.h)
    changed()
    backup = client.get("/v1/admin/backup", headers=admin.h).json()
    assert client.post("/v1/admin/restore", json=backup, headers=admin.h).status_code == 200
    changed()


def test_nothing_changes_nothing_is_renewed(client, people, admin):
    alice = people()
    post = publish(client, admin, "## Same")
    before = version(client, alice)
    # An identical body, an archived flag that already holds, and deleting what is gone.
    assert client.put(f"/v1/admin/news/{post['id']}", json={"body": "## Same", "archived": False},
                      headers=admin.h).status_code == 204
    assert client.delete(f"/v1/admin/news/{b64u(os.urandom(16))}", headers=admin.h).status_code == 204
    assert version(client, alice) == before


# --- editing, archiving, deleting ---


def test_modified_changes_only_with_the_body(client, admin):
    post = publish(client, admin, "## Draft")
    pid = post["id"]
    time.sleep(0.01)
    # An identical body: untouched.
    client.put(f"/v1/admin/news/{pid}", json={"body": "## Draft"}, headers=admin.h)
    assert admin_posts(client, admin)[pid]["modified"] == post["modified"]
    # Archiving and publishing again: untouched.
    client.put(f"/v1/admin/news/{pid}", json={"archived": True}, headers=admin.h)
    client.put(f"/v1/admin/news/{pid}", json={"archived": False}, headers=admin.h)
    got = admin_posts(client, admin)[pid]
    assert got["modified"] == post["modified"] and got["created"] == post["created"] and not got["archived"]
    # A different body: modified moves, created does not.
    client.put(f"/v1/admin/news/{pid}", json={"body": "## Final", "archived": True}, headers=admin.h)
    got = admin_posts(client, admin)[pid]
    assert got["body"] == "## Final" and got["archived"] is True
    assert got["modified"] > post["modified"] and got["created"] == post["created"]


def test_an_archived_or_deleted_post_is_gone_from_the_feed(client, people, admin):
    alice = people()
    keep, archive, delete = (publish(client, admin, f"## {n}") for n in ("keep", "archive", "delete"))
    client.put(f"/v1/admin/news/{archive['id']}", json={"archived": True}, headers=admin.h)
    assert client.delete(f"/v1/admin/news/{delete['id']}", headers=admin.h).status_code == 204
    assert [p["id"] for p in feed(client, alice)["news"]] == [keep["id"]]
    assert set(admin_posts(client, admin)) == {keep["id"], archive["id"]}
    # Publishing again brings it back to its place by `created`.
    client.put(f"/v1/admin/news/{archive['id']}", json={"archived": False}, headers=admin.h)
    assert [p["id"] for p in feed(client, alice)["news"]] == [archive["id"], keep["id"]]
    # Deleting twice is fine.
    assert client.delete(f"/v1/admin/news/{delete['id']}", headers=admin.h).status_code == 204


def test_update_errors(client, admin):
    post = publish(client, admin)
    url = f"/v1/admin/news/{post['id']}"
    assert client.put("/v1/admin/news/" + b64u(os.urandom(16)), json={"archived": True},
                      headers=admin.h).status_code == 404
    assert client.put("/v1/admin/news/not-an-id", json={"archived": True}, headers=admin.h).status_code == 404
    for body in ({}, {"other": 1}, {"archived": "yes"}, {"archived": 1}, {"archived": None}, {"body": 5},
                 {"body": ""}, {"body": " \n\t"}, {"body": None}, [], "x", None):
        r = client.put(url, json=body, headers=admin.h)
        assert r.status_code == 400, (body, r.status_code, r.text)
    assert client.put(url, content=b"{", headers=admin.h).status_code == 400
    # A bad patch changed nothing.
    assert admin_posts(client, admin)[post["id"]] | {} == {**post, "body": "## Post", "archived": False}


# --- limits ---


@pytest.mark.parametrize("body", ["", " ", "\n\t \n", None, 5, ["x"], "x" * (MAX_NEWS_BODY + 1), "é" * (MAX_NEWS_BODY // 2 + 1),
                                  "a\u0000b"])
def test_bad_bodies_are_refused(client, admin, body):
    r = client.post("/v1/admin/news", json={"body": body}, headers=admin.h)
    assert r.status_code == 400, r.text
    assert client.get("/v1/admin/news", headers=admin.h).json() == {"news": []}


def test_a_lone_surrogate_is_refused(client, admin):
    r = client.post("/v1/admin/news", content=b'{"body": "\\ud800"}', headers=admin.h)
    assert r.status_code == 400, r.text


def test_malformed_requests_are_refused(client, admin):
    for kwargs in ({"content": b"x"}, {"json": {}}, {"json": []}, {"json": "x"}, {"json": {"text": "a"}}):
        assert client.post("/v1/admin/news", headers=admin.h, **kwargs).status_code == 400, kwargs
    # Unknown keys are ignored.
    assert client.post("/v1/admin/news", json={"body": "a", "x": 1}, headers=admin.h).status_code == 201


def test_body_size_is_counted_in_utf8_bytes(client, people, admin):
    for body in ("x" * MAX_NEWS_BODY, "é" * (MAX_NEWS_BODY // 2), "## " + "€" * 100):
        post = publish(client, admin, body)
        assert admin_posts(client, admin)[post["id"]]["body"] == body
    post = publish(client, admin, "## Short")
    url = f"/v1/admin/news/{post['id']}"
    assert client.put(url, json={"body": "x" * MAX_NEWS_BODY}, headers=admin.h).status_code == 204
    assert client.put(url, json={"body": "x" * (MAX_NEWS_BODY + 1)}, headers=admin.h).status_code == 400
    # Whitespace around text is kept as written.
    assert client.put(url, json={"body": "\n## Padded \n"}, headers=admin.h).status_code == 204
    assert admin_posts(client, admin)[post["id"]]["body"] == "\n## Padded \n"


def test_at_most_twenty_published_posts(client, people, admin):
    alice = people()
    ids = [publish(client, admin, f"## {n}")["id"] for n in range(MAX_NEWS_PUBLISHED)]
    before = version(client, alice)
    r = client.post("/v1/admin/news", json={"body": "## 21"}, headers=admin.h)
    assert r.status_code == 409 and r.json() == TOO_MANY
    assert version(client, alice) == before and len(feed(client, alice)["news"]) == MAX_NEWS_PUBLISHED
    # Archiving one makes room; publishing it again does not fit once the room is taken.
    assert client.put(f"/v1/admin/news/{ids[0]}", json={"archived": True}, headers=admin.h).status_code == 204
    extra = publish(client, admin, "## 21")
    r = client.put(f"/v1/admin/news/{ids[0]}", json={"archived": False}, headers=admin.h)
    assert r.status_code == 409 and r.json() == TOO_MANY
    assert admin_posts(client, admin)[ids[0]]["archived"] is True
    # Editing a published post and archiving still work at the limit; so does "unarchive" of a published one.
    assert client.put(f"/v1/admin/news/{ids[1]}", json={"body": "## Edited"}, headers=admin.h).status_code == 204
    assert client.put(f"/v1/admin/news/{ids[1]}", json={"archived": False}, headers=admin.h).status_code == 204
    assert client.put(f"/v1/admin/news/{extra['id']}", json={"archived": True}, headers=admin.h).status_code == 204
    # Deleting makes room as well.
    assert client.delete(f"/v1/admin/news/{extra['id']}", headers=admin.h).status_code == 204
    assert client.put(f"/v1/admin/news/{ids[0]}", json={"archived": False}, headers=admin.h).status_code == 204


def test_at_most_two_hundred_posts_in_total(client, people, admin):
    alice = people()
    # Archived posts count in the total: publish one, archive it, repeat.
    for n in range(MAX_NEWS - 1):
        post = publish(client, admin, f"## {n}")
        assert client.put(f"/v1/admin/news/{post['id']}", json={"archived": True}, headers=admin.h).status_code == 204
    last = publish(client, admin, "## last")
    assert len(admin_posts(client, admin)) == MAX_NEWS
    before = version(client, alice)
    r = client.post("/v1/admin/news", json={"body": "## 201"}, headers=admin.h)
    assert r.status_code == 409 and r.json() == TOO_MANY
    assert version(client, alice) == before
    # Deleting one makes room.
    client.delete(f"/v1/admin/news/{last['id']}", headers=admin.h)
    assert client.post("/v1/admin/news", json={"body": "## 201"}, headers=admin.h).status_code == 201


# --- access ---


def test_only_the_admin_may_write_news(client, people, admin):
    other = people()
    post = publish(client, admin, "## Mine")
    for method, path, body in (("GET", "/v1/admin/news", None), ("POST", "/v1/admin/news", {"body": "x"}),
                               ("PUT", f"/v1/admin/news/{post['id']}", {"archived": True}),
                               ("DELETE", f"/v1/admin/news/{post['id']}", None)):
        for headers in (other.h, {}, {"Authorization": "Bearer nonsense"}):
            r = client.request(method, path, json=body, headers=headers)
            assert r.status_code == 404 and r.json() == NOT_FOUND, (method, path, r.text)
    assert list(admin_posts(client, admin)) == [post["id"]]
    # A bad body does not give the endpoints away either.
    assert client.post("/v1/admin/news", content=b"x", headers=other.h).status_code == 404


def test_overview_counts_published_posts(client, admin):
    a, b = publish(client, admin), publish(client, admin)
    client.put(f"/v1/admin/news/{b['id']}", json={"archived": True}, headers=admin.h)
    assert client.get("/v1/admin/overview", headers=admin.h).json()["counts"]["news"] == 1


# --- backup and restore ---


def test_backup_holds_the_news(client, admin):
    keep, archived = publish(client, admin, "## Keep"), publish(client, admin, "## Archived")
    client.put(f"/v1/admin/news/{archived['id']}", json={"archived": True}, headers=admin.h)
    rows = client.get("/v1/admin/backup", headers=admin.h).json()["tables"]["news"]
    assert all(set(r) == {"id", "body", "created", "modified", "archived"} for r in rows)
    assert {r["id"]: (r["body"], r["archived"]) for r in rows} == {
        keep["id"]: ("## Keep", False), archived["id"]: ("## Archived", True)}


def test_news_round_trip_through_a_backup(client, people, admin):
    alice = people()
    keep, archived, gone = (publish(client, admin, f"## {n}") for n in ("keep", "archived", "gone"))
    client.put(f"/v1/admin/news/{archived['id']}", json={"archived": True}, headers=admin.h)
    client.put(f"/v1/admin/news/{keep['id']}", json={"body": "## kept, edited"}, headers=admin.h)
    backup = client.get("/v1/admin/backup", headers=admin.h).json()
    feed_before, posts_before = feed(client, alice)["news"], admin_posts(client, admin)

    # Mutate: edit, delete, add.
    client.put(f"/v1/admin/news/{keep['id']}", json={"body": "## changed again"}, headers=admin.h)
    client.delete(f"/v1/admin/news/{gone['id']}", headers=admin.h)
    client.put(f"/v1/admin/news/{archived['id']}", json={"archived": False}, headers=admin.h)
    publish(client, admin, "## late")
    changed = version(client, alice)

    assert client.post("/v1/admin/restore", json=backup, headers=admin.h).status_code == 200
    assert feed(client, alice)["news"] == feed_before
    assert admin_posts(client, admin) == posts_before
    assert version(client, alice) not in (None, changed)
    # The restored posts can be changed as usual.
    assert client.put(f"/v1/admin/news/{keep['id']}", json={"archived": True}, headers=admin.h).status_code == 204


def test_an_old_backup_without_news_restores_with_no_news(client, people, admin):
    alice = people()
    publish(client, admin)
    old = client.get("/v1/admin/backup", headers=admin.h).json()
    del old["tables"]["news"]
    before = version(client, alice)
    r = client.post("/v1/admin/restore", json=old, headers=admin.h)
    assert r.status_code == 200, r.text
    assert feed(client, alice)["news"] == [] and client.get("/v1/admin/news", headers=admin.h).json() == {"news": []}
    assert version(client, alice) not in (None, before)
    assert client.get("/v1/admin/overview", headers=admin.h).json()["counts"]["news"] == 0


def test_restore_refuses_bad_news(client, admin):
    post = publish(client, admin)
    keep = client.get("/v1/admin/backup", headers=admin.h).json()
    row = keep["tables"]["news"][0]
    many = [{**row, "id": b64u(os.urandom(16))} for _ in range(MAX_NEWS_PUBLISHED)]
    cases = {
        "extra column": lambda t: row.update(evil=1) or t.update(news=[row]),
        "missing column": lambda t: t.update(news=[{k: v for k, v in row.items() if k != "modified"}]),
        "table is not a list": lambda t: t.update(news={}),
        "row is not an object": lambda t: t.update(news=["x"]),
        "bad id": lambda t: t.update(news=[{**row, "id": "x"}]),
        "repeated id": lambda t: t.update(news=[row, row]),
        "empty body": lambda t: t.update(news=[{**row, "body": "  "}]),
        "huge body": lambda t: t.update(news=[{**row, "body": "x" * (MAX_NEWS_BODY + 1)}]),
        "archived is not a bool": lambda t: t.update(news=[{**row, "archived": 0}]),
        "bad time": lambda t: t.update(news=[{**row, "created": "yesterday"}]),
        "no time zone": lambda t: t.update(news=[{**row, "modified": "2026-01-01T00:00:00"}]),
        "too many published": lambda t: t.update(news=[row] + many),
        "too many in total": lambda t: t.update(news=[{**row, "id": b64u(os.urandom(16)), "archived": True}
                                                      for _ in range(MAX_NEWS + 1)]),
    }
    for name, edit in cases.items():
        doc = copy.deepcopy(keep)
        row = doc["tables"]["news"][0]
        edit(doc["tables"])
        r = client.post("/v1/admin/restore", json=doc, headers=admin.h)
        assert r.status_code == 400, (name, r.status_code, r.text)
    assert list(admin_posts(client, admin)) == [post["id"]]
    # The limits themselves are allowed.
    doc = copy.deepcopy(keep)
    doc["tables"]["news"] = [{**row, "id": b64u(os.urandom(16)), "archived": n >= MAX_NEWS_PUBLISHED}
                             for n in range(MAX_NEWS)]
    assert client.post("/v1/admin/restore", json=doc, headers=admin.h).status_code == 200
    assert len(admin_posts(client, admin)) == MAX_NEWS
