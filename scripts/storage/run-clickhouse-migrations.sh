#!/bin/sh
set -eu

: "${CLICKHOUSE_HOST:=clickhouse}"
: "${CLICKHOUSE_PORT:=9000}"
: "${CLICKHOUSE_DB:=liquidmap}"
: "${CLICKHOUSE_USER:=liquidmap}"
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is required}"

if [ "$CLICKHOUSE_DB" != "liquidmap" ]; then
  echo "ClickHouse migration v1 requires CLICKHOUSE_DB=liquidmap" >&2
  exit 1
fi

clickhouse_query() {
  clickhouse-client \
    --host "$CLICKHOUSE_HOST" \
    --port "$CLICKHOUSE_PORT" \
    --user "$CLICKHOUSE_USER" \
    --password "$CLICKHOUSE_PASSWORD" \
    "$@"
}

for migration_file in /migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  [ -f "$migration_file" ] || continue
  migration_version="$(basename "$migration_file")"
  migration_checksum="$(sha256sum "$migration_file" | awk '{print $1}')"

  case "$migration_version" in
    *[!a-zA-Z0-9_.-]*)
      echo "Unsafe ClickHouse migration filename: $migration_version" >&2
      exit 1
      ;;
  esac

  ledger_exists="$(clickhouse_query --query \
    "EXISTS TABLE ${CLICKHOUSE_DB}.storage_migrations FORMAT TSVRaw")"
  existing_checksum=""
  if [ "$ledger_exists" = "1" ]; then
    existing_checksum="$(clickhouse_query \
      --param_migration_version "$migration_version" \
      --query "SELECT checksum
               FROM ${CLICKHOUSE_DB}.storage_migrations
               WHERE version = {migration_version:String}
               ORDER BY applied_at DESC
               LIMIT 1
               FORMAT TSVRaw")"
  fi

  if [ -n "$existing_checksum" ]; then
    if [ "$existing_checksum" != "$migration_checksum" ]; then
      echo "ClickHouse migration checksum changed: $migration_version" >&2
      exit 1
    fi
    echo "ClickHouse migration already applied: $migration_version"
    continue
  fi

  echo "Applying ClickHouse migration: $migration_version"
  clickhouse_query --multiquery < "$migration_file"
  clickhouse_query \
    --param_migration_version "$migration_version" \
    --param_migration_checksum "$migration_checksum" \
    --query "INSERT INTO ${CLICKHOUSE_DB}.storage_migrations(version, checksum)
             VALUES ({migration_version:String}, {migration_checksum:String})"
done
