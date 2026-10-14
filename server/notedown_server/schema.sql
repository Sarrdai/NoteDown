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
