"""The owner's admin endpoints under /v1/admin (docs/server-api.md → "Admin").

Every one of them answers 404 unless the caller's identity is listed in `Settings.admin_identities`
(env ADMIN_IDENTITIES): to everybody else the endpoints don't exist. Nothing here records anything new
about identities or devices; it only reads what the tables hold, stores the quota and member-limit overrides
and the history switch and replaces the data on a restore.
"""

import json
import os
from datetime import datetime, timezone
from typing import Annotated, Any, Callable

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from psycopg import IsolationLevel
from psycopg.types.json import Jsonb

from .protocol import (DEFAULT_MEMBERS, MAX_MEMBERS, MIN_MEMBERS, MAX_NEWS, MAX_NEWS_PUBLISHED, ProtocolError, b64u, check_news_body, from_b64u, is_id, key_id,
                       member_key, verify_chain)

MAX_QUOTA_OVERRIDE = 1024 ** 3
# The Neon free plan's database size; the overview shows the usage against it.
DATABASE_LIMIT_BYTES = 512 * 1024 * 1024
BACKUP_FORMAT = "notedown-backup"
BACKUP_VERSION = 1
MAX_WRAPPED_KEY = 512   # as in app.py: the longest wrapped key / sealed card
INVITATION_KINDS = ("code", "link")


def utc_iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None


# SQL on `identities` aliased `i`: a block that holds now (docs/server-api.md → "Blocked and deleted identities").
BLOCKED = "(i.blocked AND (i.blocked_until IS NULL OR i.blocked_until > now()))"
# SQL: the server-wide limit of members per file (docs/server-api.md → "Limits"), and the one of identity `i`.
SERVER_MEMBERS = f"coalesce((SELECT value::int FROM server_state WHERE key = 'max_members'), {DEFAULT_MEMBERS})"
MEMBER_LIMIT = f"coalesce(i.max_members, {SERVER_MEMBERS})"


def erase_identity(conn: psycopg.Connection, identity: str) -> bool:
    """Deletes an identity in the caller's transaction (backlog #34): its files no other remaining identity is a
    member of, its devices' keys, device list, contacts and invitations. Shared files stay for the other
    members, and so does a row with the ID and key, marked `deleted`, which keeps the files' member sets intact
    and tells its other devices what happened. False for an unknown identity; deleting twice changes nothing."""
    row = conn.execute("SELECT deleted FROM identities WHERE id = %s FOR UPDATE", (identity,)).fetchone()
    if row is None:
        return False
    if row[0] is not None:
        return True
    conn.execute("DELETE FROM files f WHERE f.id IN (SELECT file_id FROM file_members WHERE identity_id = %(i)s) "
                 "AND NOT EXISTS (SELECT 1 FROM file_members m JOIN identities o ON o.id = m.identity_id "
                 "WHERE m.file_id = f.id AND m.identity_id <> %(i)s AND o.deleted IS NULL)", {"i": identity})
    conn.execute("DELETE FROM file_keys k USING devices d WHERE d.identity_id = %(i)s AND k.device_id = d.id "
                 "AND k.file_id IN (SELECT file_id FROM file_members WHERE identity_id = %(i)s)", {"i": identity})
    conn.execute("DELETE FROM devices WHERE identity_id = %s", (identity,))
    conn.execute("DELETE FROM device_entries WHERE identity_id = %s", (identity,))
    conn.execute("DELETE FROM contacts WHERE a = %(i)s OR b = %(i)s", {"i": identity})
    conn.execute("DELETE FROM invitations WHERE identity_id = %(i)s OR requester = %(i)s", {"i": identity})
    conn.execute("UPDATE identities SET deleted = now(), quota = NULL, max_members = NULL, history = false, blocked = false, "
                 "blocked_until = NULL WHERE id = %s", (identity,))
    return True


def renew_news_version(conn: psycopg.Connection) -> None:
    """A new opaque news version, in the transaction of the change it announces."""
    conn.execute("INSERT INTO server_state (key, value) VALUES ('news', %s) "
                 "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (b64u(os.urandom(16)),))


# --- backup and restore: the table layout, with a fixed whitelist of columns per table ---

# Deleting goes child tables first; relay and rate_limits are cleared but never backed up.
CLEAR_ORDER = ["rate_limits", "relay", "news", "invitations", "contacts", "file_key_chain", "file_versions", "file_keys",
               "file_members", "files",
               "devices", "device_entries", "identities"]


def read_backup(conn: psycopg.Connection) -> dict:
    """The backup document, read in the transaction the caller opened."""
    def rows(sql: str) -> list[tuple]:
        return conn.execute(sql).fetchall()

    tables = {
        "identities": [
            {"id": r[0], "identity_key": b64u(r[1]), "created": utc_iso(r[2]), "quota": r[3], "history": r[4],
             "blocked": r[5], "blocked_until": utc_iso(r[6]), "deleted": utc_iso(r[7]), "max_members": r[8]}
            for r in rows('SELECT id, identity_key, created, quota, history, blocked, blocked_until, deleted, max_members '
                          'FROM identities ORDER BY id COLLATE "C"')],
        "device_entries": [
            {"identity_id": r[0], "seq": r[1], "entry": r[2]}
            for r in rows('SELECT identity_id, seq, entry FROM device_entries '
                          'ORDER BY identity_id COLLATE "C", seq')],
        "files": [
            {"id": r[0], "owner": r[1], "version": r[2], "ciphertext": b64u(r[3]),
             "updated": utc_iso(r[4]), "member_key": r[5], "key_gen": r[6]}
            for r in rows('SELECT id, owner, version, ciphertext, updated, member_key, key_gen FROM files '
                          'ORDER BY id COLLATE "C"')],
        "file_versions": [
            {"file_id": r[0], "version": r[1], "ciphertext": b64u(r[2]), "updated": utc_iso(r[3]),
             "replaced": utc_iso(r[4]), "key_gen": r[5], "pinned": r[6], "saved": r[7]}
            for r in rows('SELECT file_id, version, ciphertext, updated, replaced, key_gen, pinned, saved FROM file_versions '
                          'ORDER BY file_id COLLATE "C", version')],
        "file_key_chain": [
            {"file_id": r[0], "gen": r[1], "sealed": r[2]}
            for r in rows('SELECT file_id, gen, sealed FROM file_key_chain ORDER BY file_id COLLATE "C", gen')],
        "file_members": [
            {"file_id": r[0], "identity_id": r[1]}
            for r in rows('SELECT file_id, identity_id FROM file_members '
                          'ORDER BY file_id COLLATE "C", identity_id COLLATE "C"')],
        "file_keys": [
            {"file_id": r[0], "device_id": r[1], "wrapped": r[2]}
            for r in rows('SELECT file_id, device_id, wrapped FROM file_keys '
                          'ORDER BY file_id COLLATE "C", device_id COLLATE "C"')],
        "contacts": [
            {"a": r[0], "b": r[1]}
            for r in rows('SELECT a, b FROM contacts ORDER BY a COLLATE "C", b COLLATE "C"')],
        "invitations": [
            {"id": r[0], "identity_id": r[1], "kind": r[2], "device_id": r[3], "sig": r[4],
             "expires": utc_iso(r[5]), "requester": r[6], "requested_at": utc_iso(r[7]), "cards": r[8]}
            for r in rows('SELECT id, identity_id, kind, device_id, sig, expires, requester, requested_at, cards '
                          'FROM invitations ORDER BY id COLLATE "C"')],
        "news": [
            {"id": r[0], "body": r[1], "created": utc_iso(r[2]), "modified": utc_iso(r[3]), "archived": r[4]}
            for r in rows('SELECT id, body, created, modified, archived FROM news ORDER BY id COLLATE "C"')],
    }
    return {"format": BACKUP_FORMAT, "version": BACKUP_VERSION,
            "created": datetime.now(timezone.utc).isoformat(), "tables": tables}


def _bad(what: str) -> ProtocolError:
    return ProtocolError(f"invalid backup: {what}")


def _rows(tables: dict, name: str, columns: set[str], optional: frozenset[str] = frozenset()) -> list[dict]:
    """The rows of one table: a list of objects with exactly the whitelisted keys; `optional` ones may be
    missing (backups from before they existed)."""
    rows = tables.get(name)
    if not isinstance(rows, list):
        raise _bad(f"table {name} is missing")
    for row in rows:
        if not isinstance(row, dict) or not columns - optional <= set(row) <= columns:
            raise _bad(f"malformed row in {name}")
    return rows


def _bool(row: dict, key: str, table: str, default: bool = False) -> bool:
    value = row.get(key, default)
    if type(value) is not bool:
        raise _bad(f"{table}.{key} must be true or false")
    return value


def _text(row: dict, key: str, table: str, nullable: bool = False) -> Any:
    value = row[key]
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise _bad(f"{table}.{key} must be a string")
    return value


def _id(row: dict, key: str, table: str, nullable: bool = False) -> Any:
    value = row[key]
    if value is None and nullable:
        return None
    if not is_id(value):
        raise _bad(f"{table}.{key} must be an ID")
    return value


def _time(row: dict, key: str, table: str, nullable: bool = False) -> datetime | None:
    value = row[key]
    if value is None and nullable:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        raise _bad(f"{table}.{key} must be a time")
    if parsed.tzinfo is None:
        raise _bad(f"{table}.{key} needs a time zone")
    return parsed


def _int(row: dict, key: str, table: str, low: int, high: int | None = None, nullable: bool = False) -> Any:
    value = row[key]
    if value is None and nullable:
        return None
    if type(value) is not int or value < low or (high is not None and value > high):
        raise _bad(f"{table}.{key} out of range")
    return value


def _b64u(row: dict, key: str, table: str, length: int | None = None) -> bytes:
    try:
        return from_b64u(row[key], length)
    except ProtocolError:
        raise _bad(f"{table}.{key} must be base64url")


def parse_backup(doc: Any) -> dict:
    """Checks a backup document and returns the rows to insert, per table, as tuples in column order, plus
    the devices rebuilt from every identity's chain. Raises ProtocolError (→ 400) on anything wrong."""
    if not isinstance(doc, dict) or doc.get("format") != BACKUP_FORMAT:
        raise _bad("not a NoteDown backup")
    if type(doc.get("version")) is not int or doc["version"] != BACKUP_VERSION:
        raise _bad("unsupported version")
    tables = doc.get("tables")
    if not isinstance(tables, dict):
        raise _bad("tables are missing")

    identities: dict[str, bytes] = {}
    out: dict[str, list] = {"identities": [], "device_entries": [], "devices": [], "files": [], "file_members": [],
                            "file_keys": [], "file_versions": [], "file_key_chain": [], "contacts": [],
                            "invitations": [], "news": []}
    # history and key_gen, file_versions and file_key_chain are optional: older backups restore without history;
    # so are blocked, blocked_until and deleted (missing: neither blocked nor deleted).
    deleted: set[str] = set()
    for r in _rows(tables, "identities", {"id", "identity_key", "created", "quota", "history", "blocked",
                                          "blocked_until", "deleted", "max_members"},
                   frozenset({"history", "blocked", "blocked_until", "deleted", "max_members"})):
        key = _b64u(r, "identity_key", "identities", 32)
        identity = _id(r, "id", "identities")
        if key_id(key) != identity or identity in identities:
            raise _bad("identities.id does not match its key, or repeats")
        identities[identity] = key
        gone = _time(r, "deleted", "identities", nullable=True) if "deleted" in r else None
        if gone:
            deleted.add(identity)
        out["identities"].append((identity, key, _time(r, "created", "identities"),
                                  _int(r, "quota", "identities", 1, MAX_QUOTA_OVERRIDE, nullable=True),
                                  _bool(r, "history", "identities"), _bool(r, "blocked", "identities"),
                                  _time(r, "blocked_until", "identities", nullable=True) if "blocked_until" in r
                                  else None, gone,
                                  _int(r, "max_members", "identities", MIN_MEMBERS, MAX_MEMBERS, nullable=True)
                                  if "max_members" in r else None))

    chains: dict[str, dict[int, dict]] = {i: {} for i in identities}
    for r in _rows(tables, "device_entries", {"identity_id", "seq", "entry"}):
        identity = _id(r, "identity_id", "device_entries")
        seq = _int(r, "seq", "device_entries", 0)
        if identity not in identities or seq in chains[identity] or not isinstance(r["entry"], dict):
            raise _bad("device_entries row does not fit")
        chains[identity][seq] = r["entry"]
    devices: dict[str, dict] = {}
    for identity, by_seq in chains.items():
        # A deleted identity has no device list left; every other one has one without gaps.
        if (identity in deleted) != (not by_seq) or sorted(by_seq) != list(range(len(by_seq))):
            raise _bad("a device list has gaps, is empty or belongs to a deleted identity")
        if not by_seq:
            continue
        entries = [by_seq[i] for i in range(len(by_seq))]
        devices[identity] = verify_chain(identities[identity], entries)   # ProtocolError → 400
        out["device_entries"] += [(identity, e["seq"], Jsonb(e)) for e in entries]
        out["devices"] += [(identity, d.id, d.kind, d.active) for d in devices[identity].values()]

    files: set[str] = set()
    owners: dict[str, str] = {}
    current: dict[str, tuple[int, int]] = {}   # file → (version, key_gen)
    for r in _rows(tables, "files", {"id", "owner", "version", "ciphertext", "updated", "member_key", "key_gen"},
                   frozenset({"key_gen"})):
        fid, owner = _id(r, "id", "files"), _id(r, "owner", "files")
        if fid in files or owner not in identities:
            raise _bad("files row does not fit")
        files.add(fid)
        owners[fid] = _text(r, "member_key", "files", nullable=True)
        current[fid] = (_int(r, "version", "files", 1, 2 ** 31 - 1),
                        _int(r, "key_gen", "files", 1, 2 ** 31 - 1) if "key_gen" in r else 1)
        out["files"].append((fid, owner, current[fid][0], _b64u(r, "ciphertext", "files"),
                             _time(r, "updated", "files"), owners[fid], current[fid][1]))
    members: dict[str, list[str]] = {f: [] for f in files}
    for r in _rows(tables, "file_members", {"file_id", "identity_id"}):
        fid, identity = _id(r, "file_id", "file_members"), _id(r, "identity_id", "file_members")
        if fid not in files or identity not in identities or identity in members[fid]:
            raise _bad("file_members row does not fit")
        members[fid].append(identity)
        out["file_members"].append((fid, identity))
    for fid, listed in members.items():
        if not listed or owners[fid] not in (None, member_key(listed)):
            raise _bad("a file's members and member_key disagree")
    seen_keys: set[tuple] = set()
    for r in _rows(tables, "file_keys", {"file_id", "device_id", "wrapped"}):
        fid, device = _id(r, "file_id", "file_keys"), _id(r, "device_id", "file_keys")
        wrapped = _text(r, "wrapped", "file_keys")
        _b64u(r, "wrapped", "file_keys")
        if fid not in files or (fid, device) in seen_keys or len(wrapped) > MAX_WRAPPED_KEY:
            raise _bad("file_keys row does not fit")
        seen_keys.add((fid, device))
        out["file_keys"].append((fid, device, wrapped))
    seen_versions: set[tuple] = set()
    for r in _rows(tables, "file_versions", {"file_id", "version", "ciphertext", "updated", "replaced", "key_gen",
                                             "pinned", "saved"}, frozenset({"saved"})) if "file_versions" in tables else []:
        fid = _id(r, "file_id", "file_versions")
        if fid not in files:
            raise _bad("file_versions row does not fit")
        saved = _bool(r, "saved", "file_versions")
        # A state saved by hand may be the current one; any other was replaced.
        version = _int(r, "version", "file_versions", 1, current[fid][0] - (not saved))
        if (fid, version) in seen_versions:
            raise _bad("file_versions row does not fit")
        seen_versions.add((fid, version))
        out["file_versions"].append((fid, version, _b64u(r, "ciphertext", "file_versions"),
                                     _time(r, "updated", "file_versions"), _time(r, "replaced", "file_versions"),
                                     _int(r, "key_gen", "file_versions", 1, current[fid][1]),
                                     _bool(r, "pinned", "file_versions"), saved))
    seen_chain: set[tuple] = set()
    for r in _rows(tables, "file_key_chain", {"file_id", "gen", "sealed"}) if "file_key_chain" in tables else []:
        fid = _id(r, "file_id", "file_key_chain")
        if fid not in files:
            raise _bad("file_key_chain row does not fit")
        gen = _int(r, "gen", "file_key_chain", 1, current[fid][1] - 1)
        sealed = _text(r, "sealed", "file_key_chain")
        _b64u(r, "sealed", "file_key_chain")
        if (fid, gen) in seen_chain or len(sealed) > MAX_WRAPPED_KEY:
            raise _bad("file_key_chain row does not fit")
        seen_chain.add((fid, gen))
        out["file_key_chain"].append((fid, gen, sealed))
    pairs: set[tuple] = set()
    for r in _rows(tables, "contacts", {"a", "b"}):
        a, b = _id(r, "a", "contacts"), _id(r, "b", "contacts")
        if a not in identities or b not in identities or (a, b) in pairs:
            raise _bad("contacts row does not fit")
        pairs.add((a, b))
        out["contacts"].append((a, b))
    seen_invitations: set[str] = set()
    for r in _rows(tables, "invitations", {"id", "identity_id", "kind", "device_id", "sig", "expires",
                                           "requester", "requested_at", "cards"}):
        iid, identity = _id(r, "id", "invitations"), _id(r, "identity_id", "invitations")
        requester = _id(r, "requester", "invitations", nullable=True)
        cards = r["cards"]
        if iid in seen_invitations or identity not in identities or (requester and requester not in identities) \
                or r["kind"] not in INVITATION_KINDS or (cards is not None and (
                    not isinstance(cards, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                                           for k, v in cards.items()))):
            raise _bad("invitations row does not fit")
        seen_invitations.add(iid)
        out["invitations"].append((
            iid, identity, r["kind"], _text(r, "device_id", "invitations"), _text(r, "sig", "invitations"),
            _time(r, "expires", "invitations"), requester, _time(r, "requested_at", "invitations", nullable=True),
            None if cards is None else Jsonb(cards)))
    # News is optional: a backup from before it existed restores with no news.
    if "news" in tables:
        seen_news: set[str] = set()
        for r in _rows(tables, "news", {"id", "body", "created", "modified", "archived"}):
            nid = _id(r, "id", "news")
            try:
                check_news_body(r["body"])
            except ProtocolError:
                raise _bad("news.body is not a valid post")
            if nid in seen_news or type(r["archived"]) is not bool:
                raise _bad("news row does not fit")
            seen_news.add(nid)
            out["news"].append((nid, r["body"], _time(r, "created", "news"), _time(r, "modified", "news"),
                                r["archived"]))
        if len(out["news"]) > MAX_NEWS or sum(not n[4] for n in out["news"]) > MAX_NEWS_PUBLISHED:
            raise _bad("too many news")
    out["_devices"] = devices   # for the lock-out check
    return out


INSERTS = {
    "identities": ("INSERT INTO identities (id, identity_key, created, quota, history, blocked, blocked_until, deleted, "
                   "max_members) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)"),
    "device_entries": "INSERT INTO device_entries (identity_id, seq, entry) VALUES (%s, %s, %s)",
    "devices": "INSERT INTO devices (identity_id, id, kind, active) VALUES (%s, %s, %s, %s)",
    "files": ("INSERT INTO files (id, owner, version, ciphertext, updated, member_key, key_gen) "
              "VALUES (%s, %s, %s, %s, %s, %s, %s)"),
    "file_versions": ("INSERT INTO file_versions (file_id, version, ciphertext, updated, replaced, key_gen, pinned, "
                      "saved) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"),
    "file_key_chain": "INSERT INTO file_key_chain (file_id, gen, sealed) VALUES (%s, %s, %s)",
    "file_members": "INSERT INTO file_members (file_id, identity_id) VALUES (%s, %s)",
    "file_keys": "INSERT INTO file_keys (file_id, device_id, wrapped) VALUES (%s, %s, %s)",
    "contacts": "INSERT INTO contacts (a, b) VALUES (%s, %s)",
    "invitations": ("INSERT INTO invitations (id, identity_id, kind, device_id, sig, expires, requester, "
                    "requested_at, cards) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)"),
    "news": "INSERT INTO news (id, body, created, modified, archived) VALUES (%s, %s, %s, %s, %s)",
}
# Parents before children (foreign keys).
INSERT_ORDER = ["identities", "device_entries", "devices", "files", "file_members", "file_keys", "file_versions",
                "file_key_chain", "contacts", "invitations", "news"]


def register_admin(app: FastAPI, pool, settings, caller: Callable, *, default_quota: int, invitation_live: str,
                   load_entries: Callable, file_members: Callable) -> None:
    """Adds the /v1/admin routes. `caller` is app.py's token check; the rest are its helpers."""

    def admin(authorization: Annotated[str | None, Header()] = None):
        # Anything but a valid admin (no token, a bad one, another identity) looks like no such endpoint.
        try:
            who = caller(authorization)
        except HTTPException:
            raise HTTPException(404, "not found")
        if who.identity not in settings.admin_identities:
            raise HTTPException(404, "not found")
        return who

    Admin = Annotated[Any, Depends(admin)]

    def count(conn: psycopg.Connection, sql: str) -> int:
        return int(conn.execute(sql).fetchone()[0])

    @app.get("/v1/admin/overview")
    def overview(who: Admin):
        with pool.connection() as conn:
            counts = {
                "identities": count(conn, "SELECT count(*) FROM identities WHERE deleted IS NULL"),
                "blocked": count(conn, f"SELECT count(*) FROM identities i WHERE {BLOCKED}"),
                "devices": count(conn, "SELECT count(*) FROM devices WHERE kind = 'device' AND active"),
                "files": count(conn, "SELECT count(*) FROM files"),
                "shared_files": count(conn, "SELECT count(*) FROM (SELECT 1 FROM file_members GROUP BY file_id "
                                            "HAVING count(*) > 1) s"),
                "contacts": count(conn, "SELECT count(*) FROM contacts WHERE a < b"),   # each pair once
                "invitations": count(conn, f"SELECT count(*) FROM invitations WHERE {invitation_live}"),
                "news": count(conn, "SELECT count(*) FROM news WHERE NOT archived"),
            }
            storage = {
                "files": count(conn, "SELECT coalesce(sum(length(ciphertext)), 0) FROM files"),
                "history": count(conn, "SELECT coalesce(sum(length(ciphertext)), 0) FROM file_versions"),
                "database": count(conn, "SELECT pg_database_size(current_database())"),
                "database_limit": DATABASE_LIMIT_BYTES,
            }
            override = conn.execute("SELECT value::int FROM server_state WHERE key = 'max_members'").fetchone()
        return {"identity": who.identity, "counts": counts, "storage": storage, "quota": default_quota,
                "max_members": override[0] if override else DEFAULT_MEMBERS,
                "max_members_override": override[0] if override else None}

    @app.get("/v1/admin/identities")
    def list_identities(who: Admin):
        with pool.connection() as conn:
            rows = conn.execute(
                "SELECT i.id, i.created, i.quota, "
                "(SELECT count(*) FROM devices d WHERE d.identity_id = i.id AND d.kind = 'device' AND d.active), "
                "(SELECT count(*) FROM file_members m WHERE m.identity_id = i.id), "
                "(SELECT coalesce(sum(length(f.ciphertext)), 0) FROM file_members m JOIN files f "
                " ON f.id = m.file_id WHERE m.identity_id = i.id), "
                "(SELECT max(f.updated) FROM file_members m JOIN files f ON f.id = m.file_id "
                " WHERE m.identity_id = i.id), "
                f"(SELECT count(*) FROM contacts c WHERE c.a = i.id), i.history, {BLOCKED}, i.blocked_until, "
                f"{MEMBER_LIMIT}, i.max_members "
                'FROM identities i WHERE i.deleted IS NULL ORDER BY i.created DESC, i.id COLLATE "C"').fetchall()
        return {"identities": [{
            "id": r[0], "created": r[1].isoformat(), "devices": r[3], "files": r[4], "used": int(r[5]),
            "quota": r[2] or default_quota, "quota_override": r[2], "updated": r[6].isoformat() if r[6] else None,
            "contacts": r[7], "history": r[8], "blocked": r[9], "blocked_until": utc_iso(r[10]) if r[9] else None,
            "max_members": r[11], "max_members_override": r[12]}
            for r in rows]}

    @app.get("/v1/admin/identities/{identity}")
    def get_identity(identity: str, who: Admin):
        with pool.connection() as conn:
            row = conn.execute(f"SELECT i.created, i.quota, i.history, {BLOCKED}, i.blocked_until, {MEMBER_LIMIT}, "
                               "i.max_members FROM identities i "
                               "WHERE i.id = %s AND i.deleted IS NULL", (identity,)).fetchone()
            if row is None:
                raise HTTPException(404, "unknown identity")
            devices = conn.execute(
                "SELECT d.id, d.kind, d.active FROM device_entries e JOIN devices d "
                "ON d.identity_id = e.identity_id AND d.id = e.entry->'device'->>'id' "
                "WHERE e.identity_id = %s AND e.entry->>'op' = 'add' ORDER BY e.seq", (identity,)).fetchall()
            files = conn.execute(
                "SELECT f.id, f.version, f.updated, length(f.ciphertext) FROM files f "
                "JOIN file_members m ON m.file_id = f.id AND m.identity_id = %s "
                'ORDER BY f.updated DESC, f.id COLLATE "C"', (identity,)).fetchall()
            listed = [{"id": f[0], "version": f[1], "updated": f[2].isoformat(), "size": f[3],
                       "members": file_members(conn, f[0])} for f in files]
            history_size = conn.execute(
                "SELECT coalesce(sum(length(v.ciphertext)), 0) FROM file_versions v JOIN file_members m "
                "ON m.file_id = v.file_id AND m.identity_id = %s", (identity,)).fetchone()[0]
            contacts = sorted(r[0] for r in conn.execute("SELECT b FROM contacts WHERE a = %s", (identity,)))
            invitations = conn.execute(
                f"SELECT count(*) FROM invitations WHERE identity_id = %s AND {invitation_live}",
                (identity,)).fetchone()[0]
        return {"id": identity, "created": row[0].isoformat(), "used": sum(f["size"] for f in listed),
                "quota": row[1] or default_quota, "quota_override": row[1],
                "history": row[2], "history_size": int(history_size),
                "blocked": row[3], "blocked_until": utc_iso(row[4]) if row[3] else None,
                "max_members": row[5], "max_members_override": row[6],
                "devices": [{"id": d[0], "kind": d[1], "active": d[2]} for d in devices],
                "files": listed, "contacts": contacts, "invitations": invitations}

    async def json_body(request: Request) -> Any:
        # Read here, not as a declared body: the admin check has to come first, whatever is sent.
        try:
            return json.loads(await request.body())
        except ValueError:
            raise ProtocolError("body is not JSON")

    @app.put("/v1/admin/identities/{identity}/quota", status_code=204)
    async def set_quota(identity: str, request: Request, who: Admin):
        body = await json_body(request)
        quota = body.get("quota", "missing") if isinstance(body, dict) else "missing"
        if quota is not None and (type(quota) is not int or not 1 <= quota <= MAX_QUOTA_OVERRIDE):
            raise ProtocolError(f"quota must be null or between 1 and {MAX_QUOTA_OVERRIDE} bytes")

        def update() -> None:
            with pool.connection() as conn:
                if not conn.execute("UPDATE identities SET quota = %s WHERE id = %s", (quota, identity)).rowcount:
                    raise HTTPException(404, "unknown identity")

        await run_in_threadpool(update)

    def member_limit(body: Any) -> int | None:
        value = body.get("max_members", "missing") if isinstance(body, dict) else "missing"
        if value is not None and (type(value) is not int or not MIN_MEMBERS <= value <= MAX_MEMBERS):
            raise ProtocolError(f"max_members must be null or between {MIN_MEMBERS} and {MAX_MEMBERS}")
        return value

    @app.put("/v1/admin/max-members", status_code=204)
    async def set_server_members(request: Request, who: Admin):
        value = member_limit(await json_body(request))

        def update() -> None:
            with pool.connection() as conn:
                if value is None:
                    conn.execute("DELETE FROM server_state WHERE key = 'max_members'")
                else:
                    conn.execute("INSERT INTO server_state (key, value) VALUES ('max_members', %s) "
                                 "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (str(value),))

        await run_in_threadpool(update)

    @app.put("/v1/admin/identities/{identity}/max-members", status_code=204)
    async def set_identity_members(identity: str, request: Request, who: Admin):
        value = member_limit(await json_body(request))

        def update() -> None:
            with pool.connection() as conn:
                if not conn.execute("UPDATE identities SET max_members = %s WHERE id = %s AND deleted IS NULL",
                                    (value, identity)).rowcount:
                    raise HTTPException(404, "unknown identity")

        await run_in_threadpool(update)

    @app.put("/v1/admin/identities/{identity}/history", status_code=204)
    async def set_history(identity: str, request: Request, who: Admin):
        body = await json_body(request)
        on = body.get("history") if isinstance(body, dict) else None
        if type(on) is not bool:
            raise ProtocolError("history must be true or false")

        def update() -> None:
            with pool.connection() as conn:
                if not conn.execute("UPDATE identities SET history = %s WHERE id = %s", (on, identity)).rowcount:
                    raise HTTPException(404, "unknown identity")
                if not on:
                    # The stored states of the files no member keeps history for any more go.
                    conn.execute(
                        "DELETE FROM file_versions v WHERE v.file_id IN "
                        "(SELECT file_id FROM file_members WHERE identity_id = %s) AND NOT EXISTS "
                        "(SELECT 1 FROM file_members m JOIN identities i ON i.id = m.identity_id "
                        " WHERE m.file_id = v.file_id AND i.history)", (identity,))

        await run_in_threadpool(update)

    def not_an_admin(identity: str) -> None:
        # Blocking or deleting an admin identity would lock the owner out of this page.
        if identity in settings.admin_identities:
            raise HTTPException(409, "an admin identity can't be blocked or deleted")

    @app.put("/v1/admin/identities/{identity}/block", status_code=204)
    async def set_block(identity: str, request: Request, who: Admin):
        body = await json_body(request)
        on = body.get("blocked") if isinstance(body, dict) else None
        until = body.get("until") if isinstance(body, dict) else None
        if type(on) is not bool:
            raise ProtocolError("blocked must be true or false")
        if until is not None:
            if not on:
                raise ProtocolError("until needs blocked")
            try:
                until = datetime.fromisoformat(until)
            except (TypeError, ValueError):
                raise ProtocolError("until must be a time")
            if until.tzinfo is None:
                raise ProtocolError("until needs a time zone")
            if until <= datetime.now(timezone.utc):
                raise ProtocolError("until must lie ahead")
        not_an_admin(identity)

        def update() -> None:
            with pool.connection() as conn:
                if not conn.execute("UPDATE identities SET blocked = %s, blocked_until = %s "
                                    "WHERE id = %s AND deleted IS NULL", (on, until, identity)).rowcount:
                    raise HTTPException(404, "unknown identity")

        await run_in_threadpool(update)

    @app.delete("/v1/admin/identities/{identity}", status_code=204)
    def delete_identity(identity: str, who: Admin):
        not_an_admin(identity)
        with pool.connection() as conn:
            gone = conn.execute("SELECT deleted IS NOT NULL FROM identities WHERE id = %s", (identity,)).fetchone()
            if gone is None or gone[0]:
                raise HTTPException(404, "unknown identity")
            erase_identity(conn, identity)

    # --- news posts ---

    def too_many_news() -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": "too many news"})

    @app.get("/v1/admin/news")
    def list_news(who: Admin):
        with pool.connection() as conn:
            rows = conn.execute('SELECT id, body, created, modified, archived FROM news '
                                'ORDER BY created DESC, id COLLATE "C"').fetchall()
        return {"news": [{"id": r[0], "created": utc_iso(r[2]), "modified": utc_iso(r[3]), "body": r[1],
                          "archived": r[4]} for r in rows]}

    @app.post("/v1/admin/news", status_code=201)
    async def create_news(request: Request, who: Admin):
        body = await json_body(request)
        text = check_news_body(body.get("body") if isinstance(body, dict) else None)

        def create():
            with pool.connection() as conn:
                conn.execute("LOCK TABLE news IN SHARE ROW EXCLUSIVE MODE")   # the limits can't be raced
                total, published = conn.execute(
                    "SELECT count(*), count(*) FILTER (WHERE NOT archived) FROM news").fetchone()
                if total >= MAX_NEWS or published >= MAX_NEWS_PUBLISHED:
                    return too_many_news()
                nid = b64u(os.urandom(16))
                created = conn.execute("INSERT INTO news (id, body) VALUES (%s, %s) RETURNING created, modified",
                                       (nid, text)).fetchone()
                renew_news_version(conn)
            return JSONResponse(status_code=201, content={"id": nid, "created": utc_iso(created[0]),
                                                          "modified": utc_iso(created[1])})

        return await run_in_threadpool(create)

    @app.put("/v1/admin/news/{news_id}", status_code=204)
    async def update_news(news_id: str, request: Request, who: Admin):
        patch = await json_body(request)
        if not isinstance(patch, dict) or not ({"body", "archived"} & set(patch)):
            raise ProtocolError("body or archived is needed")
        text = check_news_body(patch["body"]) if "body" in patch else None
        archived = patch.get("archived")
        if "archived" in patch and type(archived) is not bool:
            raise ProtocolError("archived must be true or false")

        def update():
            with pool.connection() as conn:
                conn.execute("LOCK TABLE news IN SHARE ROW EXCLUSIVE MODE")
                row = conn.execute("SELECT body, archived FROM news WHERE id = %s", (news_id,)).fetchone()
                if row is None:
                    raise HTTPException(404, "unknown news")
                new_body = text is not None and text != row[0]
                new_archived = archived is not None and archived != row[1]
                if new_archived and not archived and conn.execute(
                        "SELECT count(*) FROM news WHERE NOT archived").fetchone()[0] >= MAX_NEWS_PUBLISHED:
                    return too_many_news()
                if not new_body and not new_archived:
                    return Response(status_code=204)   # nothing changes, so neither does the version
                conn.execute(
                    "UPDATE news SET body = %s, archived = %s, "
                    "modified = CASE WHEN %s THEN now() ELSE modified END WHERE id = %s",
                    (text if new_body else row[0], archived if new_archived else row[1], new_body, news_id))
                renew_news_version(conn)
            return Response(status_code=204)

        return await run_in_threadpool(update)

    @app.delete("/v1/admin/news/{news_id}", status_code=204)
    def delete_news(news_id: str, who: Admin):
        with pool.connection() as conn:
            if conn.execute("DELETE FROM news WHERE id = %s", (news_id,)).rowcount:
                renew_news_version(conn)

    @app.get("/v1/admin/backup")
    def backup(who: Admin):
        with pool.connection() as conn:
            # One snapshot for all tables, whatever is written meanwhile.
            conn.isolation_level, conn.read_only = IsolationLevel.REPEATABLE_READ, True
            try:
                with conn.transaction():
                    doc = read_backup(conn)
            finally:
                conn.isolation_level, conn.read_only = None, None
        name = f"notedown-backup-{datetime.now(timezone.utc):%Y-%m-%d-%H%M}.json"
        return Response(json.dumps(doc, separators=(",", ":")), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.post("/v1/admin/restore")
    async def restore(request: Request, who: Admin):
        rows = parse_backup(await json_body(request))
        device = rows.pop("_devices").get(who.identity, {}).get(who.device)
        if device is None or not device.active:
            return JSONResponse(status_code=409, content={"detail": "the backup would lock you out"})

        def replace() -> None:
            try:
                with pool.connection() as conn:   # one transaction: all or nothing
                    for table in CLEAR_ORDER:
                        conn.execute(f"DELETE FROM {table}")
                    with conn.cursor() as cur:
                        for table in INSERT_ORDER:
                            cur.executemany(INSERTS[table], rows[table])
                    conn.execute(
                        "INSERT INTO server_state (key, value) VALUES ('epoch', %s) "
                        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (b64u(os.urandom(16)),))
                    renew_news_version(conn)
            except psycopg.errors.IntegrityError:
                raise _bad("rows break a constraint (duplicates or a dangling reference)")

        await run_in_threadpool(replace)
        return {"identities": len(rows["identities"]), "files": len(rows["files"])}
