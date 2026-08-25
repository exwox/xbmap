# Storage migrations

- `clickhouse/0001_history_v1.sql` owns high-volume immutable market facts and
  1 s/5 s/1 m metric projections. Prices are integer ticks and table engines use
  compressed, time-ordered MergeTree parts with resolution-specific TTLs.
- `postgres/0001_replay_metadata.sql` owns dataset/replay/backup metadata only;
  it intentionally contains no raw market payloads.

Migration files are append-only after deployment. A runner must hash each exact
file with SHA-256, compare it with `storage_migrations`, and refuse a changed
checksum. The local `FileHistoryStore` uses its own atomically-created catalog
format version and provides the same `HistoryStore` contract for development and
tests without requiring database dependencies.

The Compose `storage` profile includes one-shot `postgres-migrate` and
`clickhouse-migrate` services. They run after database health checks, apply
missing migrations to both fresh and existing volumes, record exact file
checksums, and fail if an already-applied file has changed. Database entrypoint
mounts remain as a fast bootstrap for clean volumes; the runners make upgrades
independent from first-start initialization.
