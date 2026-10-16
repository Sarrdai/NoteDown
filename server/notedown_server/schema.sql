-- Applied at every start; only additive, idempotent statements.

CREATE TABLE IF NOT EXISTS identities (
    id           text PRIMARY KEY,
    identity_key bytea NOT NULL,
    created      timestamptz NOT NULL DEFAULT now()
);

-- The signed device list, entry by entry (docs/server-api.md → "Device list").
CREATE TABLE IF NOT EXISTS device_entries (
    identity_id text NOT NULL REFERENCES identities (id),
    seq         integer NOT NULL,
    entry       jsonb NOT NULL,
    PRIMARY KEY (identity_id, seq)
);

-- Derived from device_entries, for the check on every request.
CREATE TABLE IF NOT EXISTS devices (
    identity_id text NOT NULL REFERENCES identities (id),
    id          text NOT NULL,
    kind        text NOT NULL,
    active      boolean NOT NULL,
    PRIMARY KEY (identity_id, id)
);

CREATE TABLE IF NOT EXISTS files (
    id         text PRIMARY KEY,
    owner      text NOT NULL REFERENCES identities (id),
    version    integer NOT NULL,
    ciphertext bytea NOT NULL,
    updated    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_owner ON files (owner);

-- Milestone 2: a file belongs to a fixed set of identities (docs/server-api.md → "Members").
-- `owner` is the identity that created it. `member_key` is the sorted member IDs joined by "+"
-- and unique: one file per member set. The statements below migrate milestone-1 data and are safe
-- to re-run: members = [owner]; of several old files of one owner only the oldest gets the key
-- (the others keep NULL, which the unique index allows).
ALTER TABLE files ADD COLUMN IF NOT EXISTS member_key text;

CREATE TABLE IF NOT EXISTS file_members (
    file_id     text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    identity_id text NOT NULL REFERENCES identities (id),
    PRIMARY KEY (file_id, identity_id)
);
CREATE INDEX IF NOT EXISTS file_members_identity ON file_members (identity_id);

INSERT INTO file_members (file_id, identity_id) SELECT id, owner FROM files
    ON CONFLICT DO NOTHING;
UPDATE files f SET member_key = f.owner WHERE f.member_key IS NULL AND f.id =
    (SELECT g.id FROM files g WHERE g.owner = f.owner AND coalesce(g.member_key, g.owner) = g.owner ORDER BY g.updated, g.id LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM files h WHERE h.member_key = f.owner);
CREATE UNIQUE INDEX IF NOT EXISTS files_member_key ON files (member_key);

CREATE TABLE IF NOT EXISTS file_keys (
    file_id   text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    device_id text NOT NULL,
    wrapped   text NOT NULL,
    PRIMARY KEY (file_id, device_id)
);

CREATE TABLE IF NOT EXISTS relay (
    slot    text PRIMARY KEY,
    payload text,
    expires timestamptz NOT NULL
);

-- Per-IP request counters in fixed windows (bucket = "<endpoint>:<ip or /64>"); stale rows are
-- deleted by the next limited request.
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket       text NOT NULL,
    window_start timestamptz NOT NULL,
    expires      timestamptz NOT NULL,
    count        integer NOT NULL,
    PRIMARY KEY (bucket, window_start)
);

-- Invitations (docs/server-api.md → "Contacts and invitations"). `expires` ends the time a request
-- may arrive; once `requester` is set the row waits for the inviter's decision up to 30 days after
-- `requested_at`. `cards` maps the inviter's device IDs to the sealed card of the requester.
CREATE TABLE IF NOT EXISTS invitations (
    id           text PRIMARY KEY,
    identity_id  text NOT NULL REFERENCES identities (id),
    kind         text NOT NULL,
    device_id    text NOT NULL,
    sig          text NOT NULL,
    expires      timestamptz NOT NULL,
    requester    text REFERENCES identities (id),
    requested_at timestamptz,
    cards        jsonb
);
CREATE INDEX IF NOT EXISTS invitations_identity ON invitations (identity_id);

-- A contact pair is stored in both directions, so every query is one lookup by `a`.
CREATE TABLE IF NOT EXISTS contacts (
    a text NOT NULL REFERENCES identities (id),
    b text NOT NULL REFERENCES identities (id),
    PRIMARY KEY (a, b)
);

-- Per-identity storage quota override in bytes (admin endpoints); NULL = the default quota.
ALTER TABLE identities ADD COLUMN IF NOT EXISTS quota bigint;

-- Server-wide state: the restore epoch (key "epoch"), which changes whenever a backup is restored so
-- clients know the server went back in time, and the news version (key "news"), which changes with
-- every change to the news posts.
CREATE TABLE IF NOT EXISTS server_state (
    key   text PRIMARY KEY,
    value text NOT NULL
);

-- The owner's news posts (docs/server-api.md → "News"), plain Markdown, the same for everybody.
-- `modified` changes only with the body; `archived` posts are not in the feed.
CREATE TABLE IF NOT EXISTS news (
    id       text PRIMARY KEY,
    body     text NOT NULL,
    created  timestamptz NOT NULL DEFAULT now(),
    modified timestamptz NOT NULL DEFAULT now(),
    archived boolean NOT NULL DEFAULT false
);

-- Version history (backlog #7, docs/server-api.md → "Version history"): switched on per identity by the
-- admin; a file keeps older states while one of its members has it.
ALTER TABLE identities ADD COLUMN IF NOT EXISTS history boolean NOT NULL DEFAULT false;
-- The generation of a file's current key: 1 at creation, + 1 whenever the keys are replaced (renewed).
ALTER TABLE files ADD COLUMN IF NOT EXISTS key_gen integer NOT NULL DEFAULT 1;

-- Older states of a file: `updated` is when the state was uploaded, `replaced` when the next one came;
-- `pinned` marks the state a restore replaced, which thinning keeps.
CREATE TABLE IF NOT EXISTS file_versions (
    file_id    text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    version    integer NOT NULL,
    ciphertext bytea NOT NULL,
    updated    timestamptz NOT NULL,
    replaced   timestamptz NOT NULL,
    key_gen    integer NOT NULL,
    pinned     boolean NOT NULL DEFAULT false,
    PRIMARY KEY (file_id, version)
);

-- A file's earlier keys: the key of generation `gen`, sealed with the key of generation gen + 1 (opaque here).
CREATE TABLE IF NOT EXISTS file_key_chain (
    file_id text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    gen     integer NOT NULL,
    sealed  text NOT NULL,
    PRIMARY KEY (file_id, gen)
);

-- Blocking and deleting identities (backlog #34, docs/server-api.md → "Blocked and deleted identities").
-- A block holds while `blocked` and `blocked_until` is NULL (no end) or still ahead. `deleted` marks the
-- row that stays of a deleted identity: its ID and key, nothing else.
ALTER TABLE identities ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS blocked_until timestamptz;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS deleted timestamptz;
