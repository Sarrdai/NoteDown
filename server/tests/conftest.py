import os

import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

from notedown_server import auth
from notedown_server.app import Settings, create_app
from notedown_server.protocol import b64u, canonical, entry_hash, key_id

DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "postgresql://postgres@127.0.0.1:5433/notedown_test")
SECRET = b"test-secret"


def raw(public_key) -> bytes:
    return public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)


class Keys:
    """A device's (or the identity's) key pairs, like a client would hold them."""

    def __init__(self, kind: str = "device"):
        self.kind = kind
        self.sign_key = Ed25519PrivateKey.generate()
        self.sign = raw(self.sign_key.public_key())
        self.enc = raw(X25519PrivateKey.generate().public_key())
        self.id = key_id(self.sign)

    def device(self) -> dict:
        return {"id": self.id, "kind": self.kind, "sign": b64u(self.sign), "enc": b64u(self.enc)}

    def signed(self, entry: dict, signer: str) -> dict:
        return {**entry, "signer": signer, "sig": b64u(self.sign_key.sign(canonical({**entry, "signer": signer})))}


class Identity:
    """Builds a device list the way the client does."""

    def __init__(self):
        self.key = Keys()
        self.id = key_id(self.key.sign)
        self.entries: list[dict] = []

    def entry(self, op: str, device: dict, signer: Keys | None = None) -> dict:
        prev = entry_hash(self.entries[-1]) if self.entries else ""
        body = {"identity": self.id, "seq": len(self.entries), "prev": prev, "op": op, "device": device}
        entry = signer.signed(body, signer.id) if signer else self.key.signed(body, "identity")
        self.entries.append(entry)
        return entry


def make_client(rate_limits: bool):
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute(
            "DROP TABLE IF EXISTS file_keys, files, devices, device_entries, identities, relay, rate_limits")
    settings = Settings(DATABASE_URL, SECRET, ["https://localhost"], rate_limits=rate_limits)
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture
def client():
    """Rate limits off: most tests register identities from the same address."""
    yield from make_client(False)


@pytest.fixture
def limited_client():
    yield from make_client(True)


def token(client: TestClient, identity: Identity, device: Keys) -> dict:
    challenge = client.get("/v1/auth/challenge").json()["challenge"]
    sig = b64u(device.sign_key.sign(auth.auth_message(challenge)))
    r = client.post("/v1/auth/token", json={
        "identity": identity.id, "device": device.id, "challenge": challenge, "sig": sig})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture
def setup(client):
    """A registered identity with one phone and the recovery device."""
    identity, phone, recovery = Identity(), Keys(), Keys("recovery")
    identity.entry("add", phone.device())
    identity.entry("add", recovery.device())
    r = client.post("/v1/identities", json={"identity_key": b64u(identity.key.sign), "entries": identity.entries})
    assert r.status_code == 201, r.text
    return identity, phone, recovery
