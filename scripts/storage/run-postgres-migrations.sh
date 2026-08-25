#!/bin/sh
set -eu

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DB:=liquidmap}"
: "${POSTGRES_USER:=liquidmap}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

export PGPASSWORD="$POSTGRES_PASSWORD"

psql_base="psql -X -v ON_ERROR_STOP=1 -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d $POSTGRES_DB"

for migration_file in /migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  [ -f "$migration_file" ] || continue
  migration_version="$(basename "$migration_file")"
  migration_checksum="$(sha256sum "$migration_file" | awk '{print $1}')"

  case "$migration_version" in
    *[!a-zA-Z0-9_.-]*)
      echo "Unsafe PostgreSQL migration filename: $migration_version" >&2
      exit 1
      ;;
  esac

  ledger_exists="$($psql_base -Atc "SELECT to_regclass('public.storage_migrations') IS NOT NULL")"
  existing_checksum=""
  if [ "$ledger_exists" = "t" ]; then
    # The filename allowlist above makes direct SQL quoting safe. psql does not
    # expand :'variables' inside a command supplied through -c.
    existing_checksum="$($psql_base -Atc \
      "SELECT checksum FROM storage_migrations WHERE version = '$migration_version'")"
  fi

  if [ -n "$existing_checksum" ]; then
    if [ "$existing_checksum" != "$migration_checksum" ]; then
      echo "PostgreSQL migration checksum changed: $migration_version" >&2
      exit 1
    fi
    echo "PostgreSQL migration already applied: $migration_version"
    continue
  fi

  echo "Applying PostgreSQL migration: $migration_version"
  $psql_base -f "$migration_file"
  $psql_base -c "INSERT INTO storage_migrations(version, checksum)
        VALUES ('$migration_version', '$migration_checksum')
        ON CONFLICT (version) DO NOTHING"
done
