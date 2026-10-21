import hashlib
import os

import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.mlkem import MLKEM768PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

from notedown_server import auth, protocol
from notedown_server.app import Settings, create_app
from notedown_server.protocol import b64u, canonical, entry_hash, invitation_message, key_id

DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "postgresql://postgres@127.0.0.1:5433/notedown_test")
SECRET = b"test-secret"


def raw(public_key) -> bytes:
    return public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)


class Keys:
    """A device's (or the identity's) key pairs, like a client would hold them."""

    def __init__(self, kind: str = "device", kem: bool = True):
        self.kind = kind
        self.sign_key = Ed25519PrivateKey.generate()
        self.sign = raw(self.sign_key.public_key())
        self.enc = raw(X25519PrivateKey.generate().public_key())
        self.kem = raw(MLKEM768PrivateKey.generate().public_key())
        self.with_kem = kem   # False: a device added before post-quantum keys
        self.id = key_id(self.sign)

    def device(self) -> dict:
        record = {"id": self.id, "kind": self.kind, "sign": b64u(self.sign), "enc": b64u(self.enc)}
        return {**record, "kem": b64u(self.kem)} if self.with_kem else record

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
            "DROP TABLE IF EXISTS trmnl_installations, file_versions, file_key_chain, news, contacts, invitations, file_members, file_keys, files, devices, "
            "device_entries, identities, relay, rate_limits, server_state CASCADE")
    settings = Settings(DATABASE_URL, SECRET, ["https://localhost"], rate_limits=rate_limits)
    # Every request is from a current app (docs/server-api.md → "App versions").
    with TestClient(create_app(settings), headers={"NoteDown-Client": str(protocol.MIN_CLIENT)}) as c:
        c.settings = settings   # tests set settings.admin_identities once they know an identity
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


class Person:
    """A registered identity with a phone and the recovery device, signed in with the phone."""

    def __init__(self, client: TestClient):
        self.client = client
        self.identity, self.phone, self.recovery = Identity(), Keys(), Keys("recovery")
        self.identity.entry("add", self.phone.device())
        self.identity.entry("add", self.recovery.device())
        r = client.post("/v1/identities", json={
            "identity_key": b64u(self.identity.key.sign), "entries": self.identity.entries})
        assert r.status_code == 201, r.text
        self.id = self.identity.id
        self.h = token(client, self.identity, self.phone)

    def sign_in(self, device: Keys) -> dict:
        return token(self.client, self.identity, device)

    def add_device(self) -> Keys:
        """Links a laptop, signed by the phone."""
        laptop = Keys()
        entry = self.identity.entry("add", laptop.device(), signer=self.phone)
        r = self.client.post(f"/v1/identities/{self.id}/entries", json={"entry": entry}, headers=self.h)
        assert r.status_code == 201, r.text
        return laptop

    def invite(self, kind: str = "code", secret: bytes | None = None, device: Keys | None = None,
               headers: dict | None = None):
        """Creates an invitation; returns (invitation id, response)."""
        iid = b64u(hashlib.sha256(secret or os.urandom(16)).digest()[:16])
        sig = b64u((device or self.phone).sign_key.sign(invitation_message(iid)))
        r = self.client.post("/v1/invitations", json={"id": iid, "kind": kind, "sig": sig},
                             headers=headers or self.h)
        return iid, r

    def request(self, iid: str, to: "Person", cards: dict | None = None):
        """Sends a contact request through an invitation of `to` (cards for all its active devices)."""
        cards = cards if cards is not None else {to.phone.id: b64u(b"card-phone"), to.recovery.id: b64u(b"card-rec")}
        return self.client.post(f"/v1/invitations/{iid}/request", json={"cards": cards}, headers=self.h)

    def confirm(self, iid: str):
        return self.client.post("/v1/contacts", json={"invitation": iid}, headers=self.h)

    def befriend(self, other: "Person") -> None:
        """Makes `other` a contact through the full invitation flow."""
        iid, r = self.invite()
        assert r.status_code == 201, r.text
        assert other.request(iid, self).status_code == 204
        assert self.confirm(iid).status_code == 201

    def identity_status(self, other_id: str, invitation: str | None = None) -> int:
        params = {"invitation": invitation} if invitation else {}
        return self.client.get(f"/v1/identities/{other_id}", params=params, headers=self.h).status_code


@pytest.fixture
def people(client):
    """A factory for registered identities."""
    return lambda: Person(client)


def new_slot() -> dict:
    """The body of POST /v1/relay: a new device's ML-KEM-768 key."""
    return {"kem": b64u(raw(MLKEM768PrivateKey.generate().public_key()))}
