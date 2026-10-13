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
