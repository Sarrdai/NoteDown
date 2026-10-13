"""The sync server's HTTP API (docs/server-api.md)."""

import os
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from importlib.resources import files as package_files
from typing import Annotated

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel

from . import auth
from .protocol import (ProtocolError, b64u, entry_hash, from_b64u, is_id, key_id, verify_chain,
                       verify_signature)

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_FILES = 50
MAX_WRAPPED_KEY = 512
MAX_RELAY_PAYLOAD = 8 * 1024
RELAY_MINUTES = 10


@dataclass
class Settings:
    database_url: str
    secret: bytes
    cors_origins: list[str]

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            database_url=os.environ["DATABASE_URL"],
            secret=os.environ["SERVER_SECRET"].encode(),
            cors_origins=[o for o in re.split(r"[,\s]+", os.environ.get("CORS_ORIGINS", "")) if o],
        )


class NewIdentity(BaseModel):
    identity_key: str
    entries: list[dict]


class NewEntry(BaseModel):
    entry: dict


class TokenRequest(BaseModel):
    identity: str
    device: str
    challenge: str
    sig: str


class Upload(BaseModel):
    base_version: int
    ciphertext: str
    keys: dict[str, str] | None = None


class Keys(BaseModel):
    keys: dict[str, str]


class RelayPayload(BaseModel):
    payload: str


@dataclass
class Caller:
    identity: str
    device: str


def create_app(settings: Settings) -> FastAPI:
    pool = ConnectionPool(settings.database_url, min_size=1, max_size=5, open=False)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        pool.open(wait=True)
        with pool.connection() as conn:
            conn.execute(package_files(__package__).joinpath("schema.sql").read_text())
        yield
        pool.close()

    app = FastAPI(title="NoteDown sync", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.exception_handler(ProtocolError)
    async def protocol_error(_: Request, exc: ProtocolError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    def caller(authorization: Annotated[str | None, Header()] = None) -> Caller:
        token = authorization.removeprefix("Bearer ") if authorization else ""
        claims = auth.read_token(settings.secret, token)
        if claims is None:
            raise HTTPException(401, "missing or invalid token")
        with pool.connection() as conn:
            row = conn.execute(
                "SELECT active FROM devices WHERE identity_id = %s AND id = %s", claims
            ).fetchone()
        if not row or not row[0]:
            raise HTTPException(401, "device is not on the list")
        return Caller(*claims)

    Authed = Annotated[Caller, Depends(caller)]

    def check_keys(conn: psycopg.Connection, identity: str, keys: dict[str, str]) -> None:
        active = {r[0] for r in conn.execute(
            "SELECT id FROM devices WHERE identity_id = %s AND active", (identity,))}
        for device, wrapped in keys.items():
            if device not in active:
                raise ProtocolError(f"device {device} is not on the list")
            if len(wrapped) > MAX_WRAPPED_KEY:
                raise ProtocolError("wrapped key too long")
            from_b64u(wrapped)

    def save_keys(conn: psycopg.Connection, file_id: str, keys: dict[str, str]) -> None:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO file_keys (file_id, device_id, wrapped) VALUES (%s, %s, %s) "
                "ON CONFLICT (file_id, device_id) DO UPDATE SET wrapped = EXCLUDED.wrapped",
                [(file_id, d, w) for d, w in keys.items()],
            )

    # --- health and auth ---

    @app.get("/health")
    def health():
        with pool.connection() as conn:
            conn.execute("SELECT 1")
        return {"ok": True}

    @app.get("/v1/auth/challenge")
    def challenge():
        return {"challenge": auth.new_challenge(settings.secret)}

    @app.post("/v1/auth/token")
    def token(body: TokenRequest):
        auth.check_challenge(settings.secret, body.challenge)
        with pool.connection() as conn:
            row = conn.execute("SELECT identity_key FROM identities WHERE id = %s",
                               (body.identity,)).fetchone()
            entries = load_entries(conn, body.identity)
        if row is None:
            raise HTTPException(401, "unknown identity")
        device = verify_chain(row[0], entries).get(body.device)
        if device is None or not device.active or not verify_signature(
                device.sign, from_b64u(body.sig, 64), auth.auth_message(body.challenge)):
            raise HTTPException(401, "signature does not match an active device")
        value, expires = auth.new_token(settings.secret, body.identity, body.device)
        return {"token": value, "expires": expires}

    # --- identities and the device list ---

    def load_entries(conn: psycopg.Connection, identity: str) -> list[dict]:
        return [r[0] for r in conn.execute(
            "SELECT entry FROM device_entries WHERE identity_id = %s ORDER BY seq", (identity,))]

    def store_entries(conn: psycopg.Connection, identity: str, identity_key: bytes,
                      entries: list[dict], start: int) -> None:
        devices = verify_chain(identity_key, entries)
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO device_entries (identity_id, seq, entry) VALUES (%s, %s, %s)",
                [(identity, e["seq"], Jsonb(e)) for e in entries[start:]],
            )
            cur.executemany(
                "INSERT INTO devices (identity_id, id, kind, active) VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (identity_id, id) DO UPDATE SET active = EXCLUDED.active",
                [(identity, d.id, d.kind, d.active) for d in devices.values()],
            )
            removed = [d.id for d in devices.values() if not d.active]
            cur.execute(
                "DELETE FROM file_keys k USING files f WHERE k.file_id = f.id "
                "AND f.owner = %s AND k.device_id = ANY(%s)", (identity, removed))

    @app.post("/v1/identities", status_code=201)
    def create_identity(body: NewIdentity):
        identity_key = from_b64u(body.identity_key, 32)
        identity = key_id(identity_key)
        devices = verify_chain(identity_key, body.entries)
        if any(e["signer"] != "identity" for e in body.entries) or not any(
                d.kind == "recovery" for d in devices.values()):
            raise ProtocolError("genesis must be signed by the identity and add a recovery device")
        try:
            with pool.connection() as conn:
                conn.execute("INSERT INTO identities (id, identity_key) VALUES (%s, %s)",
                             (identity, identity_key))
                store_entries(conn, identity, identity_key, body.entries, 0)
        except psycopg.errors.UniqueViolation:
            raise HTTPException(409, "identity exists")
        return {"id": identity}

    @app.get("/v1/identities/{identity}")
    def get_identity(identity: str):
        with pool.connection() as conn:
            row = conn.execute("SELECT identity_key FROM identities WHERE id = %s",
                               (identity,)).fetchone()
            if row is None:
                raise HTTPException(404, "unknown identity")
            return {"identity_key": b64u(row[0]), "entries": load_entries(conn, identity)}

    @app.post("/v1/identities/{identity}/entries", status_code=201)
    def append_entry(identity: str, body: NewEntry, who: Authed):
        if who.identity != identity:
            raise HTTPException(403, "not your identity")
        with pool.connection() as conn:
            identity_key = conn.execute(
                "SELECT identity_key FROM identities WHERE id = %s FOR UPDATE",
                (identity,)).fetchone()[0]
            entries = load_entries(conn, identity)
            if body.entry.get("seq") != len(entries) or body.entry.get("prev") != entry_hash(entries[-1]):
                return JSONResponse(status_code=409, content={
                    "detail": "not the end of the list", "seq": len(entries)})
            store_entries(conn, identity, identity_key, entries + [body.entry], len(entries))
        return {"seq": body.entry["seq"]}

    # --- files ---

    def require_file_id(file_id: str) -> None:
        if not is_id(file_id):
            raise ProtocolError("invalid file id")

    @app.get("/v1/files")
    def list_files(who: Authed):
        with pool.connection() as conn:
            rows = conn.execute("SELECT id, version, updated FROM files WHERE owner = %s ORDER BY id",
                                (who.identity,)).fetchall()
        return {"files": [{"id": r[0], "version": r[1], "updated": r[2].isoformat()} for r in rows]}

    @app.get("/v1/files/{file_id}")
    def get_file(file_id: str, who: Authed):
        with pool.connection() as conn:
            row = conn.execute(
                "SELECT f.version, f.ciphertext, k.wrapped FROM files f LEFT JOIN file_keys k "
                "ON k.file_id = f.id AND k.device_id = %s WHERE f.id = %s AND f.owner = %s",
                (who.device, file_id, who.identity)).fetchone()
        if row is None:
            raise HTTPException(404, "unknown file")
        return {"id": file_id, "version": row[0], "ciphertext": b64u(row[1]), "key": row[2]}

    @app.put("/v1/files/{file_id}")
    def put_file(file_id: str, body: Upload, who: Authed):
        require_file_id(file_id)
        if len(body.ciphertext) > MAX_FILE_BYTES * 4 // 3 + 4:
            raise HTTPException(413, "file too large")
        ciphertext = from_b64u(body.ciphertext)
        with pool.connection() as conn:
            if body.keys is not None:
                check_keys(conn, who.identity, body.keys)
            row = conn.execute("SELECT owner, version FROM files WHERE id = %s FOR UPDATE",
                               (file_id,)).fetchone()
            if row is not None and row[0] != who.identity:
                raise HTTPException(404, "unknown file")
            current = row[1] if row else 0
            if body.base_version != current:
                return JSONResponse(status_code=409, content={
                    "detail": "version conflict", "version": current})
            if row is None:
                if not body.keys:
                    raise ProtocolError("a new file needs keys")
                count = conn.execute("SELECT count(*) FROM files WHERE owner = %s",
                                     (who.identity,)).fetchone()[0]
                if count >= MAX_FILES:
                    raise HTTPException(413, "too many files")
                try:
                    conn.execute("INSERT INTO files (id, owner, version, ciphertext) "
                                 "VALUES (%s, %s, 1, %s)", (file_id, who.identity, ciphertext))
                except psycopg.errors.UniqueViolation:
                    return JSONResponse(status_code=409, content={
                        "detail": "version conflict", "version": 1})
            else:
                conn.execute("UPDATE files SET version = version + 1, ciphertext = %s, "
                             "updated = now() WHERE id = %s", (ciphertext, file_id))
            if body.keys is not None:
                conn.execute("DELETE FROM file_keys WHERE file_id = %s", (file_id,))
                save_keys(conn, file_id, body.keys)
        return {"version": current + 1}

    @app.post("/v1/files/{file_id}/keys", status_code=204)
    def add_keys(file_id: str, body: Keys, who: Authed):
        with pool.connection() as conn:
            row = conn.execute("SELECT 1 FROM files WHERE id = %s AND owner = %s",
                               (file_id, who.identity)).fetchone()
            if row is None:
                raise HTTPException(404, "unknown file")
            check_keys(conn, who.identity, body.keys)
            save_keys(conn, file_id, body.keys)

    # --- relay slots for linking a device ---

    @app.post("/v1/relay", status_code=201)
    def create_slot():
        slot = b64u(os.urandom(16))
        with pool.connection() as conn:
            conn.execute("DELETE FROM relay WHERE expires < now()")
            expires = conn.execute(
                "INSERT INTO relay (slot, expires) VALUES (%s, now() + make_interval(mins => %s)) "
                "RETURNING expires", (slot, RELAY_MINUTES)).fetchone()[0]
        return {"slot": slot, "expires": expires.isoformat()}

    @app.put("/v1/relay/{slot}", status_code=204)
    def fill_slot(slot: str, body: RelayPayload, who: Authed):
        if len(body.payload) > MAX_RELAY_PAYLOAD:
            raise HTTPException(413, "payload too large")
        with pool.connection() as conn:
            filled = conn.execute(
                "UPDATE relay SET payload = %s WHERE slot = %s AND payload IS NULL "
                "AND expires > now()", (body.payload, slot)).rowcount
        if not filled:
            raise HTTPException(409, "slot is unknown, expired or already filled")

    @app.get("/v1/relay/{slot}")
    def read_slot(slot: str):
        with pool.connection() as conn:
            row = conn.execute(
                "DELETE FROM relay WHERE slot = %s AND payload IS NOT NULL AND expires > now() "
                "RETURNING payload", (slot,)).fetchone()
            if row:
                return {"payload": row[0]}
            waiting = conn.execute("SELECT 1 FROM relay WHERE slot = %s AND expires > now()",
                                   (slot,)).fetchone()
        if not waiting:
            raise HTTPException(404, "unknown or expired slot")
        return Response(status_code=204)

    return app
