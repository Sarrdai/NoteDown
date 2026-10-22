"""The sync server's HTTP API (docs/server-api.md)."""

import ipaddress
import logging
import os
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from importlib.resources import files as package_files
from typing import Annotated

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel

from . import auth, protocol
from .admin import BLOCKED, MAX_QUOTA_OVERRIDE, MEMBER_LIMIT, erase_identity, register_admin, utc_iso
from .protocol import (LimitError, ProtocolError, b64u, check_members, client_level, entry_hash, from_b64u, invitation_message, is_id,
                       key_id, member_key, verify_chain, verify_signature)
from .trmnl.plugin import TrmnlSettings, register_trmnl

# Total decoded ciphertext per identity; a constant for now (a paid option may raise it later).
MAX_STORAGE_BYTES = 2 * 1024 * 1024
MAX_FILES = 50
MAX_WRAPPED_KEY = 2048   # a hybrid wrapped key is 1575 characters, a sealed card a little more
MAX_PREVIOUS_KEY = 512   # the old file key sealed with the new one (symmetric, 80 characters)
MAX_RELAY_PAYLOAD = 8 * 1024
RELAY_MINUTES = 10
MAX_OPEN_INVITATIONS = 20
INVITATION_MINUTES = {"code": 10, "link": 7 * 24 * 60}
# An invitation can be requested until it expires; a request waits for the decision this long.
REQUEST_DAYS = 30
# SQL: an invitation that can still be requested, or has a request waiting for the inviter.
INVITATION_LIVE = ("((requester IS NULL AND expires > now()) OR "
                   f"(requester IS NOT NULL AND requested_at > now() - interval '{REQUEST_DAYS} days'))")
# Version history (docs/server-api.md → "Version history"): one state per hour for this many hours, then one
# per day, and nothing replaced longer ago than this many days.
HISTORY_HOURLY_HOURS = 24
HISTORY_DAYS = 30
# Per-IP limits on the unauthenticated endpoints that create something: (max requests, window seconds).
LIMIT_IDENTITIES = (10, 24 * 3600)
LIMIT_RELAY = (30, 3600)

log = logging.getLogger(__name__)


@dataclass
class Settings:
    database_url: str
    secret: bytes
    cors_origins: list[str]
    rate_limits: bool = True   # switched off only for tests and the local end-to-end run
    admin_identities: list[str] = field(default_factory=list)   # who may use /v1/admin; empty = nobody
    # The database host's size limit in bytes, only shown on the admin page (env DATABASE_LIMIT_MB; Postgres doesn't
    # know it). None: not set, and the admin page says so.
    database_limit: int | None = None
    trmnl: TrmnlSettings | None = None   # the TRMNL plugin (backlog #49); None = off

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            database_url=os.environ["DATABASE_URL"],
            secret=os.environ["SERVER_SECRET"].encode(),
            cors_origins=[o for o in re.split(r"[,\s]+", os.environ.get("CORS_ORIGINS", "")) if o],
            rate_limits=os.environ.get("RATE_LIMITS", "on").lower() != "off",
            # Exact identity IDs only: anything else (a typo, "*") never matches and is dropped here.
            admin_identities=[i for i in re.split(r"[,\s]+", os.environ.get("ADMIN_IDENTITIES", "")) if is_id(i)],
            database_limit=database_limit(os.environ.get("DATABASE_LIMIT_MB", "")),
            trmnl=TrmnlSettings.from_env(),
        )


def database_limit(value: str) -> int | None:
    """DATABASE_LIMIT_MB in bytes: a whole number of MiB above 0. Missing, empty (an unset deploy variable) or
    invalid is None: the server starts anyway, logs it, and the admin page shows the limit as not set."""
    value = value.strip()
    if value.isdigit() and int(value) > 0:
        return int(value) * 1024 * 1024
    log.warning("DATABASE_LIMIT_MB is %s: the admin page shows the database limit as not set",
                f"not a whole number of MB ({value!r})" if value else "not set")
    return None


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


class DeleteRequest(BaseModel):
    challenge: str
    sig: str


class Upload(BaseModel):
    base_version: int
    ciphertext: str
    keys: dict[str, str] | None = None
    members: list[str] | None = None
    previous_key: str | None = None   # with new keys on an existing file: the old key, sealed with the new one
    restore: bool = False             # this upload brings back an older version: pin the one it replaces


class Keys(BaseModel):
    keys: dict[str, str]


class NewInvitation(BaseModel):
    id: str
    kind: str
    sig: str


class InvitationRequest(BaseModel):
    cards: dict[str, str]


class Confirm(BaseModel):
    invitation: str


class RelayPayload(BaseModel):
    payload: str


class NewSlot(BaseModel):
    kem: str   # the new device's ML-KEM-768 key, which its link code only names by hash


def client_ip(request: Request) -> str:
    """The address rate limits count: IPv4 as is, IPv6 per /64 prefix."""
    # Cloud Run's front end appends the address it received the request from to X-Forwarded-For,
    # so the last entry is the client; earlier ones are client-supplied and can be forged.
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[-1].strip()
    host = forwarded or (request.client.host if request.client else "unknown")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return host
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped:
            return str(address.ipv4_mapped)
        return str(ipaddress.ip_network((address, 64), strict=False))
    return str(address)


class ClosedError(Exception):
    """The identity is blocked by the admin; `until` is the block's end (ISO) or None."""

    def __init__(self, until: str | None):
        self.until = until


@dataclass
class Caller:
    identity: str
    device: str


def create_app(settings: Settings) -> FastAPI:
    # check: Neon closes idle connections when it suspends; test each one before use
    # instead of failing the first request afterwards with a 500.
    pool = ConnectionPool(settings.database_url, min_size=1, max_size=5, open=False,
                          check=ConnectionPool.check_connection)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        pool.open(wait=True)
        with pool.connection() as conn:
            conn.execute(package_files(__package__).joinpath("schema.sql").read_text())
        yield
        pool.close()

    app = FastAPI(title="NoteDown sync", lifespan=lifespan)

    # Added before the CORS middleware, so CORS wraps it and the app can read the 426.
    @app.middleware("http")
    async def refuse_outdated(request: Request, call_next):
        """426 for an app older than MIN_CLIENT (docs/server-api.md → "App versions", backlog #51)."""
        if request.url.path.startswith("/v1/") and request.method != "OPTIONS":
            if client_level(request.headers.get("NoteDown-Client")) < protocol.MIN_CLIENT:
                return JSONResponse(status_code=426, content={"detail": "app outdated", "min_client": protocol.MIN_CLIENT})
        return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "NoteDown-Client"],
        expose_headers=["Content-Disposition"],   # the admin page names a downloaded backup after it
    )

    @app.exception_handler(LimitError)
    async def limit_error(_: Request, exc: LimitError):
        return JSONResponse(status_code=413, content={"detail": exc.detail, "members": exc.members})

    @app.exception_handler(ClosedError)
    async def closed_error(_: Request, exc: ClosedError):
        return JSONResponse(status_code=423, content={"detail": "identity is blocked", "until": exc.until})

    @app.exception_handler(ProtocolError)
    async def protocol_error(_: Request, exc: ProtocolError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    def refuse_closed(conn: psycopg.Connection, identity: str) -> None:
        """410 for a deleted identity, 423 with the block's end for a blocked one (backlog #34)."""
        row = conn.execute(f"SELECT i.deleted IS NOT NULL, {BLOCKED}, i.blocked_until FROM identities i "
                           "WHERE i.id = %s", (identity,)).fetchone()
        if row and row[0]:
            raise HTTPException(410, "identity deleted")
        if row and row[1]:
            raise ClosedError(utc_iso(row[2]))

    def caller(authorization: Annotated[str | None, Header()] = None) -> Caller:
        token = authorization.removeprefix("Bearer ") if authorization else ""
        claims = auth.read_token(settings.secret, token)
        if claims is None:
            raise HTTPException(401, "missing or invalid token")
        with pool.connection() as conn:
            refuse_closed(conn, claims[0])
            row = conn.execute(
                "SELECT active FROM devices WHERE identity_id = %s AND id = %s", claims
            ).fetchone()
        if not row or not row[0]:
            raise HTTPException(401, "device is not on the list")
        return Caller(*claims)

    Authed = Annotated[Caller, Depends(caller)]

    def rate_limit(name: str, limit: tuple[int, int]):
        """A dependency counting this endpoint's requests per IP in fixed windows (table rate_limits)."""
        maximum, window = limit

        def check(request: Request) -> None:
            if not settings.rate_limits:
                return
            with pool.connection() as conn:
                conn.execute("DELETE FROM rate_limits WHERE expires < now()")
                count, wait = conn.execute(
                    "INSERT INTO rate_limits (bucket, window_start, expires, count) "
                    "SELECT %(bucket)s, w, w + make_interval(secs => %(window)s), 1 FROM "
                    "(SELECT to_timestamp(floor(extract(epoch FROM now()) / %(window)s) * %(window)s) AS w) t "
                    "ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1 "
                    "RETURNING count, extract(epoch FROM expires - now())",
                    {"bucket": f"{name}:{client_ip(request)}", "window": window}).fetchone()
            if count > maximum:
                raise HTTPException(429, "too many requests",
                                    headers={"Retry-After": str(max(1, int(wait) + 1))})

        return Depends(check)

    def check_keys(conn: psycopg.Connection, members: list[str], keys: dict[str, str]) -> None:
        """Every key must belong to an active device of one of the file's members."""
        active = {r[0] for r in conn.execute(
            "SELECT id FROM devices WHERE identity_id = ANY(%s) AND active", (members,))}
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

    def keeps_history(conn: psycopg.Connection, members: list[str]) -> bool:
        return bool(conn.execute("SELECT bool_or(history) FROM identities WHERE id = ANY(%s)",
                                 (members,)).fetchone()[0])

    def thin_versions(conn: psycopg.Connection, file_id: str) -> None:
        """Keeps, per hour (the last HISTORY_HOURLY_HOURS) or per UTC day (before), the first state replaced
        in it: the one from before that hour's or day's changes. Pinned states stay; nothing stays longer
        than HISTORY_DAYS after it was replaced. States saved by hand don't count as the first of their hour or day."""
        bucket = ("CASE WHEN v.replaced >= now() - make_interval(hours => %(hours)s) THEN 'hour' ELSE 'day' END")
        conn.execute(
            "DELETE FROM file_versions v WHERE v.file_id = %(file)s AND "
            "(v.replaced < now() - make_interval(days => %(days)s) OR (NOT v.pinned AND EXISTS ("
            "SELECT 1 FROM file_versions w WHERE w.file_id = v.file_id AND NOT w.saved AND w.replaced < v.replaced "
            f"AND date_trunc({bucket}, w.replaced, 'UTC') = date_trunc({bucket}, v.replaced, 'UTC'))))",
            {"file": file_id, "hours": HISTORY_HOURLY_HOURS, "days": HISTORY_DAYS})

    # --- health and auth ---

    @app.get("/health")
    def health():
        with pool.connection() as conn:
            conn.execute("SELECT 1")
        return {"ok": True}

    @app.get("/health/live")
    def health_live():
        # For the uptime check: no database access, so Neon can still sleep.
        return {"ok": True}

    @app.get("/v1/auth/challenge")
    def challenge():
        return {"challenge": auth.new_challenge(settings.secret)}

    @app.post("/v1/auth/token")
    def token(body: TokenRequest):
        auth.check_challenge(settings.secret, body.challenge)
        with pool.connection() as conn:
            refuse_closed(conn, body.identity)
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
            # In every file the identity is a member of, not only the ones it owns.
            cur.execute(
                "DELETE FROM file_keys k USING file_members m WHERE k.file_id = m.file_id "
                "AND m.identity_id = %s AND k.device_id = ANY(%s)", (identity, removed))

    @app.post("/v1/identities", status_code=201,
              dependencies=[rate_limit("identities", LIMIT_IDENTITIES)])
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

    @app.post("/v1/identities/{identity}/delete", status_code=204)
    def delete_identity(identity: str, body: DeleteRequest):
        """The user deletes their identity: signed with the identity key, i.e. by whoever holds the recovery
        key, so it works without a device and while blocked (backlog #34)."""
        auth.check_challenge(settings.secret, body.challenge)
        sig = from_b64u(body.sig, 64)
        with pool.connection() as conn:
            row = conn.execute("SELECT identity_key FROM identities WHERE id = %s", (identity,)).fetchone()
            if row is None:
                raise HTTPException(404, "unknown identity")
            if not verify_signature(row[0], sig, auth.delete_message(body.challenge)):
                raise HTTPException(403, "signature does not match the identity key")
            erase_identity(conn, identity)

    def may_read_identity(conn: psycopg.Connection, who: Caller, identity: str,
                          invitation: str | None) -> bool:
        """Who may read a device list (backlog #18): the identity itself, its contacts, identities
        sharing a file with it, and the holder of an open invitation of it."""
        if who.identity == identity:
            return True
        if conn.execute("SELECT 1 FROM contacts WHERE a = %s AND b = %s", (who.identity, identity)).fetchone():
            return True
        if conn.execute(
                "SELECT 1 FROM file_members m1 JOIN file_members m2 ON m2.file_id = m1.file_id "
                "WHERE m1.identity_id = %s AND m2.identity_id = %s LIMIT 1",
                (who.identity, identity)).fetchone():
            return True
        return invitation is not None and conn.execute(
            f"SELECT 1 FROM invitations WHERE id = %s AND identity_id = %s AND {INVITATION_LIVE}",
            (invitation, identity)).fetchone() is not None

    @app.get("/v1/identities/{identity}")
    def get_identity(identity: str, who: Authed, invitation: str | None = None):
        with pool.connection() as conn:
            row = conn.execute("SELECT identity_key, deleted IS NOT NULL FROM identities WHERE id = %s",
                               (identity,)).fetchone()
            # Not allowed looks like unknown.
            if row is None or not may_read_identity(conn, who, identity, invitation):
                raise HTTPException(404, "unknown identity")
            if row[1]:
                # Still a member of a file the caller shares: no devices to wrap keys for any more.
                return {"identity_key": b64u(row[0]), "entries": [], "deleted": True}
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

    def file_members(conn: psycopg.Connection, file_id: str) -> list[str]:
        # Sorted here, in code point order: the database's collation would differ.
        return sorted(r[0] for r in conn.execute(
            "SELECT identity_id FROM file_members WHERE file_id = %s", (file_id,)))

    def file_exists(file_id: str, version: int) -> JSONResponse:
        return JSONResponse(status_code=409, content={
            "detail": "file exists", "id": file_id, "version": version})

    @app.get("/v1/files")
    def list_files(who: Authed):
        with pool.connection() as conn:
            # COLLATE "C": code point order, whatever the database's collation.
            rows = conn.execute(
                "SELECT f.id, f.version, f.updated, length(f.ciphertext), "
                "(SELECT array_agg(identity_id) FROM file_members WHERE file_id = f.id), "
                "(SELECT bool_or(i.history) FROM file_members m JOIN identities i ON i.id = m.identity_id "
                " WHERE m.file_id = f.id) "
                "FROM files f JOIN file_members me ON me.file_id = f.id AND me.identity_id = %s "
                'ORDER BY f.id COLLATE "C"', (who.identity,)).fetchall()
            quota, max_members = conn.execute(f"SELECT coalesce(i.quota, %s), {MEMBER_LIMIT} FROM identities i "
                                              "WHERE i.id = %s", (MAX_STORAGE_BYTES, who.identity)).fetchone()
            epoch = conn.execute("SELECT value FROM server_state WHERE key = 'epoch'").fetchone()
            news = conn.execute("SELECT value FROM server_state WHERE key = 'news'").fetchone()
            deleted = conn.execute(
                "SELECT DISTINCT m.identity_id FROM file_members me JOIN file_members m ON m.file_id = me.file_id "
                "JOIN identities i ON i.id = m.identity_id WHERE me.identity_id = %s AND i.deleted IS NOT NULL",
                (who.identity,)).fetchall()
        return {
            "files": [{"id": r[0], "version": r[1], "updated": r[2].isoformat(), "size": r[3],
                       "members": sorted(r[4]), "history": bool(r[5])} for r in rows],
            "quota": quota,
            "max_members": max_members,
            "epoch": epoch[0] if epoch else None,
            "news": news[0] if news else None,
            "deleted": sorted(r[0] for r in deleted),
        }

    @app.get("/v1/news")
    def get_news(who: Authed):
        with pool.connection() as conn:
            # The version first: a change in between only makes the client fetch once more.
            version = conn.execute("SELECT value FROM server_state WHERE key = 'news'").fetchone()
            rows = conn.execute('SELECT id, created, modified, body FROM news WHERE NOT archived '
                                'ORDER BY created DESC, id COLLATE "C"').fetchall()
        return {"version": version[0] if version else None,
                "news": [{"id": r[0], "created": utc_iso(r[1]), "modified": utc_iso(r[2]), "body": r[3]}
                         for r in rows]}

    @app.get("/v1/files/{file_id}")
    def get_file(file_id: str, who: Authed):
        with pool.connection() as conn:
            row = conn.execute(
                "SELECT f.version, f.ciphertext, k.wrapped FROM files f "
                "JOIN file_members m ON m.file_id = f.id AND m.identity_id = %s "
                "LEFT JOIN file_keys k ON k.file_id = f.id AND k.device_id = %s WHERE f.id = %s",
                (who.identity, who.device, file_id)).fetchone()
        if row is None:
            raise HTTPException(404, "unknown file")
        return {"id": file_id, "version": row[0], "ciphertext": b64u(row[1]), "key": row[2]}

    @app.put("/v1/files/{file_id}")
    def put_file(file_id: str, body: Upload, who: Authed):
        require_file_id(file_id)
        if len(body.ciphertext) > MAX_QUOTA_OVERRIDE * 4 // 3 + 4:   # no quota is bigger
            raise LimitError("storage quota exceeded", [who.identity])
        ciphertext = from_b64u(body.ciphertext)
        requested = check_members(body.members, who.identity) if body.members is not None else None
        with pool.connection() as conn:
            row = conn.execute("SELECT version FROM files WHERE id = %s FOR UPDATE", (file_id,)).fetchone()
            if row is not None:
                members = file_members(conn, file_id)
                if who.identity not in members:
                    raise HTTPException(404, "unknown file")
                if requested is not None and requested != members:
                    raise ProtocolError("the members of a file can't change")
            else:
                members = requested or [who.identity]
            if body.keys is not None:
                check_keys(conn, members, body.keys)
                if row is not None:
                    # Renewing: the old key goes into the chain, so the file's history stays readable.
                    if body.previous_key is None:
                        raise ProtocolError("new keys for an existing file need previous_key")
                    if len(body.previous_key) > MAX_PREVIOUS_KEY:
                        raise ProtocolError("previous_key too long")
                    from_b64u(body.previous_key)
            current = row[0] if row else 0
            if body.base_version != current:
                return JSONResponse(status_code=409, content={
                    "detail": "version conflict", "version": current})
            if row is None:
                # The creator's limit counts; a lower limit later leaves existing files as they are.
                if len(members) > conn.execute(f"SELECT {MEMBER_LIMIT} FROM identities i WHERE i.id = %s",
                                               (who.identity,)).fetchone()[0]:
                    raise ProtocolError("too many members")
                others = [m for m in members if m != who.identity]
                if others and conn.execute(
                        "SELECT count(*) FROM contacts WHERE a = %s AND b = ANY(%s)",
                        (who.identity, others)).fetchone()[0] != len(others):
                    raise HTTPException(403, "every member must be a contact")
                existing = conn.execute("SELECT id, version FROM files WHERE member_key = %s",
                                        (member_key(members),)).fetchone()
                if existing:
                    return file_exists(*existing)
            # A file counts in full for every member (backlog #27), so the limits are checked
            # for each of them. Uploads touching a member queue up here (locked in ID order,
            # after the file row), so the checks below can't be raced.
            # A deleted member has no limits any more (it counts nothing): None.
            quotas = {r[0]: None if r[2] else r[1] or MAX_STORAGE_BYTES for r in conn.execute(
                "SELECT id, quota, deleted IS NOT NULL FROM identities WHERE id = ANY(%s) ORDER BY id FOR UPDATE",
                (members,))}
            usage = conn.execute(
                "SELECT m.identity_id, coalesce(sum(length(f.ciphertext)) FILTER (WHERE f.id <> %s), 0), "
                "count(*) FILTER (WHERE f.id <> %s) FROM file_members m JOIN files f ON f.id = m.file_id "
                "WHERE m.identity_id = ANY(%s) GROUP BY m.identity_id",
                (file_id, file_id, members)).fetchall()
            used = {m: (0, 0) for m in members} | {r[0]: (r[1], r[2]) for r in usage}
            over = sorted(m for m, (size, _) in used.items()
                          if quotas[m] is not None and size + len(ciphertext) > quotas[m])
            if over:
                raise LimitError("storage quota exceeded", over)
            if row is None:
                if not body.keys:
                    raise ProtocolError("a new file needs keys")
                over = sorted(m for m, (_, count) in used.items() if quotas[m] is not None and count >= MAX_FILES)
                if over:
                    raise LimitError("too many files", over)
                try:
                    with conn.transaction():
                        conn.execute("INSERT INTO files (id, owner, version, ciphertext, member_key) "
                                     "VALUES (%s, %s, 1, %s, %s)",
                                     (file_id, who.identity, ciphertext, member_key(members)))
                except psycopg.errors.UniqueViolation:
                    # Raced: another device created this file ID or this member set first.
                    existing = conn.execute("SELECT id, version FROM files WHERE member_key = %s",
                                            (member_key(members),)).fetchone()
                    if existing and existing[0] != file_id:
                        return file_exists(*existing)
                    return JSONResponse(status_code=409, content={
                        "detail": "version conflict", "version": 1})
                with conn.cursor() as cur:
                    cur.executemany("INSERT INTO file_members (file_id, identity_id) VALUES (%s, %s)",
                                    [(file_id, m) for m in members])
            else:
                if keeps_history(conn, members):
                    conn.execute(
                        "INSERT INTO file_versions (file_id, version, ciphertext, updated, replaced, key_gen, pinned) "
                        "SELECT id, version, ciphertext, updated, now(), key_gen, %s FROM files WHERE id = %s "
                        "ON CONFLICT (file_id, version) DO NOTHING",   # saved by hand already: that copy stays
                        (body.restore, file_id))
                    thin_versions(conn, file_id)
                renewed = body.keys is not None
                if renewed:
                    conn.execute("INSERT INTO file_key_chain (file_id, gen, sealed) "
                                 "SELECT id, key_gen, %s FROM files WHERE id = %s", (body.previous_key, file_id))
                conn.execute("UPDATE files SET version = version + 1, ciphertext = %s, updated = now(), "
                             "key_gen = key_gen + %s WHERE id = %s", (ciphertext, int(renewed), file_id))
            if body.keys is not None:
                conn.execute("DELETE FROM file_keys WHERE file_id = %s", (file_id,))
                save_keys(conn, file_id, body.keys)
        return {"version": current + 1}

    # The window a stored state is listed in; thinning on the next upload deletes what is older.
    LISTED = f"replaced > now() - make_interval(days => {HISTORY_DAYS})"

    @app.get("/v1/files/{file_id}/versions")
    def list_versions(file_id: str, who: Authed):
        with pool.connection() as conn:
            row = conn.execute(
                "SELECT f.key_gen FROM files f JOIN file_members m ON m.file_id = f.id AND m.identity_id = %s "
                "WHERE f.id = %s", (who.identity, file_id)).fetchone()
            if row is None:
                raise HTTPException(404, "unknown file")
            versions = conn.execute(
                "SELECT version, updated, replaced, length(ciphertext), key_gen, pinned, saved FROM file_versions "
                f"WHERE file_id = %s AND {LISTED} ORDER BY version DESC", (file_id,)).fetchall()
            chain = conn.execute("SELECT gen, sealed FROM file_key_chain WHERE file_id = %s ORDER BY gen",
                                 (file_id,)).fetchall()
        return {"key_gen": row[0],
                "versions": [{"version": v[0], "updated": utc_iso(v[1]), "replaced": utc_iso(v[2]), "size": v[3],
                              "key_gen": v[4], "pinned": v[5], "saved": v[6]} for v in versions],
                "chain": [{"gen": c[0], "sealed": c[1]} for c in chain]}

    @app.post("/v1/files/{file_id}/versions")
    def save_version(file_id: str, who: Authed):
        """"Back up now": stores the current state as a pinned state of the history, unless it is stored already."""
        with pool.connection() as conn:
            row = conn.execute(
                "SELECT f.version FROM files f JOIN file_members m ON m.file_id = f.id AND m.identity_id = %s "
                "WHERE f.id = %s FOR UPDATE OF f", (who.identity, file_id)).fetchone()
            if row is None:
                raise HTTPException(404, "unknown file")
            if not keeps_history(conn, file_members(conn, file_id)):
                raise HTTPException(409, "no version history")
            saved = conn.execute(
                "INSERT INTO file_versions (file_id, version, ciphertext, updated, replaced, key_gen, pinned, saved) "
                "SELECT id, version, ciphertext, updated, now(), key_gen, true, true FROM files WHERE id = %s "
                "ON CONFLICT (file_id, version) DO NOTHING", (file_id,)).rowcount
        return {"version": row[0], "saved": bool(saved)}

    @app.get("/v1/files/{file_id}/versions/{version}")
    def get_version(file_id: str, version: int, who: Authed):
        if not 0 < version < 2 ** 31:
            raise HTTPException(404, "unknown version")
        with pool.connection() as conn:
            row = conn.execute(
                "SELECT v.ciphertext, v.key_gen FROM file_versions v "
                "JOIN file_members m ON m.file_id = v.file_id AND m.identity_id = %s "
                f"WHERE v.file_id = %s AND v.version = %s AND {LISTED}", (who.identity, file_id, version)).fetchone()
        if row is None:
            raise HTTPException(404, "unknown version")
        return {"id": file_id, "version": version, "ciphertext": b64u(row[0]), "key_gen": row[1]}

    @app.post("/v1/files/{file_id}/keys", status_code=204)
    def add_keys(file_id: str, body: Keys, who: Authed):
        with pool.connection() as conn:
            row = conn.execute("SELECT 1 FROM file_members WHERE file_id = %s AND identity_id = %s",
                               (file_id, who.identity)).fetchone()
            if row is None:
                raise HTTPException(404, "unknown file")
            check_keys(conn, file_members(conn, file_id), body.keys)
            save_keys(conn, file_id, body.keys)

    # --- invitations and contacts ---

    @app.post("/v1/invitations", status_code=201)
    def create_invitation(body: NewInvitation, who: Authed):
        if not is_id(body.id):
            raise ProtocolError("invalid invitation id")
        if body.kind not in INVITATION_MINUTES:
            raise ProtocolError("kind must be code or link")
        sig = from_b64u(body.sig, 64)
        with pool.connection() as conn:
            # Creations of one identity queue up here, so the limit below can't be raced.
            identity_key = conn.execute("SELECT identity_key FROM identities WHERE id = %s FOR UPDATE",
                                        (who.identity,)).fetchone()[0]
            device = verify_chain(identity_key, load_entries(conn, who.identity)).get(who.device)
            if device is None or not verify_signature(device.sign, sig, invitation_message(body.id)):
                raise ProtocolError("signature does not match the calling device")
            conn.execute(f"DELETE FROM invitations WHERE NOT {INVITATION_LIVE}")
            open_count = conn.execute(
                "SELECT count(*) FROM invitations WHERE identity_id = %s AND expires > now()",
                (who.identity,)).fetchone()[0]
            if open_count >= MAX_OPEN_INVITATIONS:
                raise HTTPException(413, "too many open invitations")
            try:
                with conn.transaction():
                    expires = conn.execute(
                        "INSERT INTO invitations (id, identity_id, kind, device_id, sig, expires) "
                        "VALUES (%s, %s, %s, %s, %s, now() + make_interval(mins => %s)) RETURNING expires",
                        (body.id, who.identity, body.kind, who.device, body.sig,
                         INVITATION_MINUTES[body.kind])).fetchone()[0]
            except psycopg.errors.UniqueViolation:
                raise HTTPException(409, "invitation exists")
        return {"expires": expires.isoformat()}

    @app.get("/v1/invitations")
    def list_invitations(who: Authed):
        with pool.connection() as conn:
            rows = conn.execute(
                "SELECT id, kind, device_id, sig, expires, requester, cards FROM invitations "
                f"WHERE identity_id = %s AND {INVITATION_LIVE} ORDER BY expires, id",
                (who.identity,)).fetchall()
        return {"invitations": [{
            "id": r[0], "kind": r[1], "device": r[2], "sig": r[3], "expires": r[4].isoformat(),
            "request": {"identity": r[5], "card": (r[6] or {}).get(who.device)} if r[5] else None,
        } for r in rows]}

    @app.post("/v1/invitations/{invitation}/request", status_code=204)
    def request_contact(invitation: str, body: InvitationRequest, who: Authed):
        with pool.connection() as conn:
            row = conn.execute(
                f"SELECT identity_id, requester FROM invitations WHERE id = %s AND {INVITATION_LIVE} "
                "FOR UPDATE", (invitation,)).fetchone()
            if row is None:
                raise HTTPException(404, "unknown or expired invitation")
            inviter, requester = row
            if inviter == who.identity:
                raise HTTPException(403, "your own invitation")
            if requester is not None:
                raise HTTPException(409, "invitation already requested")
            if not body.cards:
                raise ProtocolError("a request needs cards")
            active = {r[0] for r in conn.execute(
                "SELECT id FROM devices WHERE identity_id = %s AND active", (inviter,))}
            for device, card in body.cards.items():
                if device not in active:
                    raise ProtocolError(f"device {device} is not on the list")
                if len(card) > MAX_WRAPPED_KEY:
                    raise ProtocolError("card too long")
                from_b64u(card)
            conn.execute(
                "UPDATE invitations SET requester = %s, requested_at = now(), cards = %s WHERE id = %s",
                (who.identity, Jsonb(body.cards), invitation))

    @app.delete("/v1/invitations/{invitation}", status_code=204)
    def delete_invitation(invitation: str, who: Authed):
        with pool.connection() as conn:
            conn.execute("DELETE FROM invitations WHERE id = %s AND identity_id = %s",
                         (invitation, who.identity))

    @app.get("/v1/contacts")
    def list_contacts(who: Authed):
        with pool.connection() as conn:
            rows = conn.execute("SELECT b FROM contacts WHERE a = %s", (who.identity,)).fetchall()
        return {"contacts": sorted(r[0] for r in rows)}

    @app.post("/v1/contacts", status_code=201)
    def confirm_contact(body: Confirm, who: Authed):
        with pool.connection() as conn:
            row = conn.execute(
                "SELECT requester FROM invitations WHERE id = %s AND identity_id = %s "
                f"AND requester IS NOT NULL AND {INVITATION_LIVE} FOR UPDATE",
                (body.invitation, who.identity)).fetchone()
            if row is None:
                raise HTTPException(404, "no request to confirm")
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO contacts (a, b) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    [(who.identity, row[0]), (row[0], who.identity)])
            conn.execute("DELETE FROM invitations WHERE id = %s", (body.invitation,))
        return {"identity": row[0]}

    @app.delete("/v1/contacts/{contact}", status_code=204)
    def remove_contact(contact: str, who: Authed):
        with pool.connection() as conn:
            conn.execute("DELETE FROM contacts WHERE (a = %s AND b = %s) OR (a = %s AND b = %s)",
                         (who.identity, contact, contact, who.identity))

    # --- relay slots for linking a device ---

    @app.post("/v1/relay", status_code=201, dependencies=[rate_limit("relay", LIMIT_RELAY)])
    def create_slot(body: NewSlot):
        protocol.check_kem(body.kem)
        slot = b64u(os.urandom(16))
        with pool.connection() as conn:
            conn.execute("DELETE FROM relay WHERE expires < now()")
            expires = conn.execute(
                "INSERT INTO relay (slot, kem, expires) VALUES (%s, %s, now() + make_interval(mins => %s)) "
                "RETURNING expires", (slot, body.kem, RELAY_MINUTES)).fetchone()[0]
        return {"slot": slot, "expires": expires.isoformat()}

    @app.get("/v1/relay/{slot}/kem")
    def slot_kem(slot: str):
        with pool.connection() as conn:
            row = conn.execute("SELECT kem FROM relay WHERE slot = %s AND payload IS NULL AND expires > now()",
                               (slot,)).fetchone()
        if not row:
            raise HTTPException(404, "unknown, expired or already filled slot")
        return {"kem": row[0]}

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

    register_admin(app, pool, settings, caller, default_quota=MAX_STORAGE_BYTES, invitation_live=INVITATION_LIVE,
                   load_entries=load_entries, file_members=file_members)
    if settings.trmnl:
        register_trmnl(app, pool, settings.trmnl, client_ip, settings.secret)
    return app
