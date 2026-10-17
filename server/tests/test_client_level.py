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


def test_every_app_is_served_while_the_minimum_is_zero(client):
    assert protocol.MIN_CLIENT == 0
    assert client.get("/v1/auth/challenge").status_code == 200
    assert client.get("/v1/auth/challenge", headers={"NoteDown-Client": "1"}).status_code == 200


def test_older_apps_get_426(client, monkeypatch):
    monkeypatch.setattr(protocol, "MIN_CLIENT", 2)
    for headers in ({}, {"NoteDown-Client": "1"}, {"NoteDown-Client": "x"}):
        r = client.get("/v1/auth/challenge", headers=headers)
        assert r.status_code == 426
        assert r.json() == {"detail": "app outdated", "min_client": 2}
    assert client.post("/v1/identities", json={}).status_code == 426
    assert client.get("/v1/auth/challenge", headers={"NoteDown-Client": "2"}).status_code == 200
    assert client.get("/health").status_code == 200


def test_the_426_carries_cors_headers(client, monkeypatch):
    monkeypatch.setattr(protocol, "MIN_CLIENT", 2)
    origin = {"Origin": "https://localhost"}
    r = client.get("/v1/auth/challenge", headers=origin)
    assert r.status_code == 426
    assert r.headers["access-control-allow-origin"] == "https://localhost"
    pre = client.options("/v1/files", headers={**origin, "Access-Control-Request-Method": "GET",
                                               "Access-Control-Request-Headers": "authorization,notedown-client"})
    assert pre.status_code == 200
    assert "notedown-client" in pre.headers["access-control-allow-headers"].lower()
