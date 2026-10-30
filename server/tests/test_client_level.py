"""The oldest app the server serves (docs/server-api.md → "App versions", backlog #51)."""

from notedown_server import protocol
from notedown_server.protocol import client_level


def test_client_level_reads_the_header():
    assert client_level("3") == 3
    assert client_level(" 12 ") == 12
    assert client_level(None) == 0
    assert client_level("") == 0
    assert client_level("1.2") == 0
    assert client_level("-1") == 0
    assert client_level("9" * 20) == 0


def test_apps_from_before_bound_sign_ins_get_426(client):
    # Level 3: a sign-in names the server and files are bound to their version (security review 2026-10-30); a
    # level 2 app's sign-in would fail and end its sync as if its device had been removed.
    assert protocol.MIN_CLIENT == 3
    assert client.get("/v1/auth/challenge", headers={"NoteDown-Client": "3"}).status_code == 200
    assert client.get("/v1/auth/challenge", headers={"NoteDown-Client": "2"}).status_code == 426


def test_older_apps_get_426(client, monkeypatch):
    monkeypatch.setattr(protocol, "MIN_CLIENT", 4)
    for headers in ({"NoteDown-Client": ""}, {"NoteDown-Client": "3"}, {"NoteDown-Client": "x"}):
        r = client.get("/v1/auth/challenge", headers=headers)
        assert r.status_code == 426
        assert r.json() == {"detail": "app outdated", "min_client": 4}
    assert client.post("/v1/identities", json={}).status_code == 426
    assert client.get("/v1/auth/challenge", headers={"NoteDown-Client": "4"}).status_code == 200
    assert client.get("/health").status_code == 200


def test_the_426_carries_cors_headers(client, monkeypatch):
    monkeypatch.setattr(protocol, "MIN_CLIENT", 4)
    origin = {"Origin": "https://localhost"}
    r = client.get("/v1/auth/challenge", headers=origin)
    assert r.status_code == 426
    assert r.headers["access-control-allow-origin"] == "https://localhost"
    pre = client.options("/v1/files", headers={**origin, "Access-Control-Request-Method": "GET",
                                               "Access-Control-Request-Headers": "authorization,notedown-client"})
    assert pre.status_code == 200
    assert "notedown-client" in pre.headers["access-control-allow-headers"].lower()
