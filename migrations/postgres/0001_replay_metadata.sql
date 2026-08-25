BEGIN;

CREATE TABLE IF NOT EXISTS storage_migrations (
    version text PRIMARY KEY,
    checksum char(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replay_datasets (
    id uuid PRIMARY KEY,
    exchange text NOT NULL,
    symbol text NOT NULL CHECK (symbol ~ '^[A-Z0-9_.-]{1,48}$'),
    capture_id text NOT NULL,
    object_key text NOT NULL,
    object_sha256 char(64) NOT NULL CHECK (object_sha256 ~ '^[a-f0-9]{64}$'),
    history_schema_version integer NOT NULL,
    adapter_version text NOT NULL,
    analytics_version text NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    complete boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (exchange, symbol, capture_id),
    CHECK (ends_at >= starts_at)
);

CREATE TABLE IF NOT EXISTS replay_sessions (
    id uuid PRIMARY KEY,
    dataset_id uuid NOT NULL REFERENCES replay_datasets(id) ON DELETE RESTRICT,
    exchange text NOT NULL,
    symbol text NOT NULL CHECK (symbol ~ '^[A-Z0-9_.-]{1,48}$'),
    range_from timestamptz NOT NULL,
    range_to timestamptz NOT NULL,
    cursor_timestamp timestamptz,
    cursor_capture_sequence bigint,
    cursor_kind text,
    cursor_capture_id text,
    cursor_record_key text,
    speed numeric(6, 2) NOT NULL DEFAULT 1 CHECK (speed BETWEEN 0.25 AND 20),
    state text NOT NULL CHECK (state IN ('paused', 'playing', 'complete', 'failed')),
    expected_checksum char(64),
    actual_checksum char(64),
    failure_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (range_to > range_from),
    CHECK ((expected_checksum IS NULL OR expected_checksum ~ '^[a-f0-9]{64}$')),
    CHECK ((actual_checksum IS NULL OR actual_checksum ~ '^[a-f0-9]{64}$')),
    CHECK ((cursor_timestamp IS NULL) = (cursor_capture_sequence IS NULL)),
    CHECK ((cursor_timestamp IS NULL) = (cursor_kind IS NULL)),
    CHECK ((cursor_timestamp IS NULL) = (cursor_capture_id IS NULL)),
    CHECK ((cursor_timestamp IS NULL) = (cursor_record_key IS NULL))
);

CREATE INDEX IF NOT EXISTS replay_sessions_dataset_created_idx
    ON replay_sessions (dataset_id, created_at DESC);

CREATE TABLE IF NOT EXISTS storage_backup_runs (
    id uuid PRIMARY KEY,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    status text NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'verified')),
    postgres_object_key text,
    clickhouse_object_key text,
    raw_manifest_object_key text,
    manifest_sha256 char(64),
    failure_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((manifest_sha256 IS NULL OR manifest_sha256 ~ '^[a-f0-9]{64}$'))
);

COMMIT;
