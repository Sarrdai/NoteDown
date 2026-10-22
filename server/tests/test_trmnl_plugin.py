"""The TRMNL plugin end to end (docs/server-api.md → "TRMNL plugin"): installed from TRMNL, added as a contact by a
user, shown a shared file, uninstalled. TRMNL's token exchange and its signing key are simulated; the plugin's client
talks to the same test server."""

import hashlib
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import parse_qs

import jwt
import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric.mlkem import MLKEM768PublicKey
from cryptography.hazmat.primitives.asymmetric.rsa import generate_private_key
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi.testclient import TestClient

from notedown_server import protocol
from notedown_server.app import Settings, create_app
from notedown_server.protocol import b64u, canonical, from_b64u
from notedown_server.trmnl.client import hkdf, raw
from notedown_server.trmnl.plugin import TrmnlSettings

from conftest import DATABASE_URL, SECRET, Person, make_client

CALLBACK = "https://trmnl.com/plugin_settings/7/installation_complete"
SAMPLE = (Path(__file__).resolve().parents[2] / "app/sample/notes.md").read_text()
TRMNL_KEY = generate_private_key(public_exponent=65537, key_size=2048)   # TRMNL's key for the settings page's token


@pytest.fixture
def client():
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute(
            "DROP TABLE IF EXISTS trmnl_installations, file_versions, file_key_chain, news, contacts, invitations, "
            "file_members, file_keys, files, devices, device_entries, identities, relay, rate_limits, server_state "
            "CASCADE")
    holder = {}

    def send(method, path, body, headers):
        r = holder["c"].request(method, path, json=body, headers=headers)
        return r.status_code, (r.json() if r.content else None)

    trmnl = TrmnlSettings("client-id", "https://notes.example", send=send,
                          exchange=lambda code: f"token-{code}", jwt_key=lambda token: TRMNL_KEY.public_key())
    settings = Settings(DATABASE_URL, SECRET, ["https://localhost"], rate_limits=False, trmnl=trmnl)
    with TestClient(create_app(settings), base_url="https://testserver",
                    headers={"NoteDown-Client": str(protocol.MIN_CLIENT)}) as c:
        holder["c"] = c
        yield c


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def install(client, code="abc", uuid="user-1", locale="de"):
    r = client.get("/trmnl/install", params={"code": code, "installation_callback_url": CALLBACK},
                   follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == CALLBACK, r.text
    r = client.post("/trmnl/installed", headers=bearer(f"token-{code}"),
                    json={"user": {"uuid": uuid, "time_zone_iana": "Europe/Berlin", "locale": locale, "name": "x"}})
    assert r.json() == {"success": True}


def screen(client, code="abc") -> dict:
    r = client.post("/trmnl/markup", headers=bearer(f"token-{code}"), data={"user_uuid": "user-1"})
    assert r.status_code == 200, r.text
    return r.json()


def signed(uuid="user-1", key=TRMNL_KEY, aud="client-id", age=0) -> str:
    """The token TRMNL adds when it opens the settings page."""
    now = int(time.time()) - age
    return jwt.encode({"sub": uuid, "aud": aud, "iat": now, "exp": now + 120}, key, algorithm="RS256",
                      headers={"kid": "trmnl"})


def settings(client, uuid="user-1"):
    """Opens the settings page as TRMNL's Configure button does; the session cookie stays with `client`."""
    return client.get("/trmnl/manage", params={"uuid": uuid, "jwt": signed(uuid)})


def invitation(client, uuid="user-1") -> dict:
    page = settings(client, uuid).text
    link = re.search(r'href="([^"]*/invite/#[^"]*)"', page).group(1).replace("&amp;", "&")
    return {k: v[0] for k, v in parse_qs(link.split("#", 1)[1]).items()}


def hybrid_seal(label: bytes, device: dict, plain: bytes) -> str:
    """What the app's sealFor makes for a device record {enc, kem}."""
    enc, kem = from_b64u(device["enc"]), from_b64u(device["kem"])
    ephemeral = X25519PrivateKey.generate()
    eph_pub = raw(ephemeral.public_key())
    shared_kem, kem_ct = MLKEM768PublicKey.from_public_bytes(kem).encapsulate()
    shared_x = ephemeral.exchange(X25519PublicKey.from_public_bytes(enc))
    key = hkdf(shared_x + shared_kem, None, label + b"-pq" + hashlib.sha256(eph_pub + enc + kem_ct + kem).digest())
    nonce = os.urandom(12)
    return b64u(b"\x01" + eph_pub + kem_ct + nonce + AESGCM(key).encrypt(nonce, plain, None))


def plugin_devices(user: Person, identity: str, iid: str | None = None) -> list[dict]:
    params = {"invitation": iid} if iid else {}
    entries = user.client.get(f"/v1/identities/{identity}", params=params, headers=user.h).json()["entries"]
    return [e["device"] for e in entries if e["op"] == "add" and e["device"]["kind"] == "device"]


def add_contact(user: Person, invite: dict) -> None:
    iid = b64u(hashlib.sha256(from_b64u(invite["s"])).digest()[:16])
    card = json.dumps({"v": 1, "identity": user.id, "name": "Alex", "secret": invite["s"]}).encode()
    cards = {d["id"]: hybrid_seal(b"notedown-contact", d, card) for d in plugin_devices(user, invite["id"], iid)}
    r = user.client.post(f"/v1/invitations/{iid}/request", json={"cards": cards}, headers=user.h)
    assert r.status_code == 204, r.text


def share(user: Person, plugin: str, text: str, signer=None) -> str:
    """Creates the file of the user and the plugin, its key wrapped and signed for the plugin's device."""
    file_id, file_key = b64u(os.urandom(16)), os.urandom(32)
    signer = signer or user.phone
    keys = {user.phone.id: b64u(b"own-key")}
    for device in plugin_devices(user, plugin):
        wrap = hybrid_seal(b"notedown-wrap", device, file_key)
        sig = signer.sign_key.sign(canonical({"label": "notedown-wrap-sig", "file": file_id, "to": device["id"],
                                              "gen": 1, "signer": signer.id, "wrap": wrap}))
        keys[device["id"]] = b64u(b"\x02" + (1).to_bytes(4, "big") + from_b64u(signer.id) + sig + from_b64u(wrap))
    padded = text.encode() + b"\x80"
    padded += b"\x00" * (-len(padded) % 4096)
    nonce = os.urandom(12)
    r = user.client.put(f"/v1/files/{file_id}", headers=user.h, json={
        "base_version": 0, "ciphertext": b64u(nonce + AESGCM(file_key).encrypt(nonce, padded, None)), "keys": keys,
        "members": sorted([user.id, plugin])})
    assert r.status_code == 200, r.text
    return file_id


def notes(*ids: str) -> str:
    """Notes of the sample file, by id."""
    parts = re.split(r"(?=^<!-- note )", SAMPLE, flags=re.M)
    return "\n".join(p for p in parts if any(p.startswith(f"<!-- note id={i} ") for i in ids))


def test_install_connect_share_show_and_uninstall(client):
    install(client)
    assert "NoteDown verbinden" in screen(client)["markup"]          # not a contact yet

    invite = invitation(client)
    assert invite["name"] == "TRMNL" and invite["kind"] == "display" and invite["srv"] == "https://testserver"
    user = Person(client)
    add_contact(user, invite)
    out = screen(client)                                              # the request is confirmed on the next refresh
    assert "Noch nichts geteilt" in out["markup"]
    assert user.client.get("/v1/contacts", headers=user.h).json()["contacts"] == [invite["id"]]

    text = notes("s01", "s12") + f"\n<!-- member id={user.id} name=Alex -->\n"
    file_id = share(user, invite["id"], text)
    out = screen(client)
    assert set(out) == {"markup", "markup_half_horizontal", "markup_half_vertical", "markup_quadrant"}
    assert "Weekly groceries" in out["markup"] and "Car" in out["markup"] and ">Alex<" in out["markup"]
    assert "Stand " in out["markup"]                                  # German, from the install webhook

    page = settings(client).text
    assert "Was das Display zeigt" in page and "<span>Alex</span>" in page
    r = client.post("/trmnl/manage", params={"uuid": "user-1"}, data={"file": file_id}, follow_redirects=False)
    assert r.status_code == 303
    assert f'value="{file_id}" checked' in client.get("/trmnl/manage", params={"uuid": "user-1"}).text

    assert client.post("/trmnl/uninstalled", headers=bearer("token-abc"), json={"user_uuid": "user-1"}).json() == \
        {"success": True}
    assert client.post("/trmnl/markup", headers=bearer("token-abc")).status_code == 401
    listed = user.client.get(f"/v1/identities/{invite['id']}", headers=user.h).json()
    assert listed["deleted"] is True                                  # the plugin's identity is gone


def test_settings_open_only_with_trmnls_token(client):
    install(client)
    install(client, code="def", uuid="user-2")
    other = TestClient(client.app, base_url="https://testserver", headers={"NoteDown-Client": str(protocol.MIN_CLIENT)})
    page = other.get("/trmnl/manage", params={"uuid": "user-1"})
    assert page.status_code == 403 and "aus TRMNL heraus" in page.text and "/invite/" not in page.text
    assert other.post("/trmnl/manage", params={"uuid": "user-1"}, data={"file": ""}).status_code == 403
    stranger = generate_private_key(public_exponent=65537, key_size=2048)
    for token in (signed("user-2"), signed(key=stranger), signed(aud="other-plugin"), signed(age=600)):
        assert other.get("/trmnl/manage", params={"uuid": "user-1", "jwt": token}).status_code == 403
    page = settings(other)                                            # any browser TRMNL sends
    assert "/invite/" in page.text and "jwt" not in str(page.url)     # the token is dropped from the address
    assert other.get("/trmnl/manage", params={"uuid": "user-2"}).status_code == 403   # its session is user-1's
    assert client.get("/trmnl/manage", params={"uuid": "nobody"}).status_code == 404


def test_only_the_first_request_is_confirmed(client):
    install(client)
    invite = invitation(client)
    user = Person(client)
    add_contact(user, invite)
    screen(client)
    # a second invitation can't be got any more: the page shows the files once the contact stands
    assert "/invite/" not in settings(client).text


def test_a_key_not_signed_by_a_member_is_refused(client):
    install(client)
    invite = invitation(client)
    user, stranger = Person(client), Person(client)
    add_contact(user, invite)
    screen(client)
    share(user, invite["id"], notes("s01"), signer=stranger.phone)
    assert client.post("/trmnl/markup", headers=bearer("token-abc")).status_code == 503


def test_a_changed_server_secret_asks_to_reconnect(client):
    install(client)
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:   # as if sealed with another server secret
        conn.execute("UPDATE trmnl_installations SET sealed = %s", (b64u(os.urandom(60)),))
    assert "neu verbinden" in screen(client)["markup"]


def test_install_refuses_a_foreign_callback(client):
    r = client.get("/trmnl/install", params={"code": "x", "installation_callback_url": "https://evil.example/cb"},
                   follow_redirects=False)
    assert r.status_code == 400


def test_the_plugin_is_off_without_settings():
    plain = make_client(False)   # this module's `client` has the plugin on
    c = next(plain)
    try:
        assert c.post("/trmnl/markup", headers=bearer("token")).status_code == 404
    finally:
        plain.close()
