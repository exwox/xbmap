/**
 * Production PostgreSQL runtime adapter for durable replay session metadata,
 * implementing `ReplaySessionMetadataStore` against the schema in
 * `migrations/postgres/0001_replay_metadata.sql`. The client is an injected
 * minimal `PoolLike` so unit tests run without a live database and the
 * production wiring stays a thin `new Pool(...)` in server/index.ts.
 *
 * The `replay_datasets` foreign key is satisfied by upserting a placeholder
 * dataset row on session creation; capture bytes themselves belong to the
 * object store and are registered separately by the operator pipeline.
 */

import type { HistoryCursor, ReplaySessionMetadata } from "./types.js";

export interface PoolLike {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const SESSION_COLUMNS = [
  "id", "dataset_id", "exchange", "symbol", "range_from", "range_to",
  "cursor_timestamp", "cursor_capture_sequence", "cursor_kind",
  "cursor_capture_id", "cursor_record_key", "speed", "state",
  "expected_checksum", "actual_checksum", "created_at", "updated_at",
] as const;

function dateToMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === "string" ? Date.parse(value) : Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError("PostgreSQL timestamp is invalid");
  return Math.trunc(parsed);
}

function rowToMetadata(row: Record<string, unknown>): ReplaySessionMetadata {
  const hasCursor = row.cursor_timestamp !== null && row.cursor_timestamp !== undefined;
  const cursor: HistoryCursor | null = hasCursor
    ? {
        timestamp: dateToMs(row.cursor_timestamp),
        captureSequence: Number(row.cursor_capture_sequence),
        kind: String(row.cursor_kind ?? "") as HistoryCursor["kind"],
        captureId: String(row.cursor_capture_id ?? ""),
        recordKey: String(row.cursor_record_key ?? ""),
      }
    : null;
  const state = String(row.state);
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    exchange: "binance",
    symbol: String(row.symbol),
    from: dateToMs(row.range_from),
    to: dateToMs(row.range_to),
    cursor,
    speed: Number(row.speed),
    state: state === "playing" || state === "complete" || state === "failed" ? state : "paused",
    expectedChecksum: row.expected_checksum === null ? null : String(row.expected_checksum),
    actualChecksum: row.actual_checksum === null ? null : String(row.actual_checksum),
    createdAt: dateToMs(row.created_at),
    updatedAt: dateToMs(row.updated_at),
  };
}

export class PostgresReplaySessionMetadataStore {
  constructor(private readonly pool: PoolLike) {}

  async createSession(metadata: ReplaySessionMetadata): Promise<void> {
    // Placeholder dataset keeps the foreign key satisfied without embedding
    // capture bytes in metadata; the registrar updates it after upload.
    await this.pool.query(
      `INSERT INTO replay_datasets
         (id, exchange, symbol, capture_id, object_key, object_sha256,
          history_schema_version, adapter_version, analytics_version,
          starts_at, ends_at, complete)
       VALUES ($1,'binance',$2,'pending','pending','pending',1,'gateway','gateway',
               to_timestamp(0), to_timestamp(0), false)
       ON CONFLICT (id) DO NOTHING`,
      [metadata.datasetId, metadata.symbol],
    );
    const cursor = metadata.cursor;
    await this.pool.query(
      `INSERT INTO replay_sessions
         (id, dataset_id, exchange, symbol, range_from, range_to,
          cursor_timestamp, cursor_capture_sequence, cursor_kind,
          cursor_capture_id, cursor_record_key, speed, state,
          expected_checksum, actual_checksum, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
       ON CONFLICT (id) DO NOTHING`,
      [
        metadata.id, metadata.datasetId, "binance", metadata.symbol,
        new Date(metadata.from), new Date(metadata.to),
        cursor ? new Date(cursor.timestamp) : null,
        cursor ? cursor.captureSequence : null,
        cursor?.kind ?? null, cursor?.captureId ?? null, cursor?.recordKey ?? null,
        metadata.speed, metadata.state,
        metadata.expectedChecksum, metadata.actualChecksum,
        new Date(metadata.createdAt),
      ],
    );
  }

  async getSession(id: string): Promise<ReplaySessionMetadata | null> {
    const result = await this.pool.query(
      `SELECT ${SESSION_COLUMNS.join(", ")} FROM replay_sessions WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToMetadata(row) : null;
  }

  async updateSession(id: string, patch: Partial<ReplaySessionMetadata>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    let param = 2;
    const assign = (column: string, value: unknown): void => {
      sets.push(`${column} = $${param}`);
      values.push(value);
      param += 1;
    };
    if (patch.cursor !== undefined) {
      const cursor = patch.cursor;
      assign("cursor_timestamp", cursor ? new Date(cursor.timestamp) : null);
      assign("cursor_capture_sequence", cursor ? cursor.captureSequence : null);
      assign("cursor_kind", cursor?.kind ?? null);
      assign("cursor_capture_id", cursor?.captureId ?? null);
      assign("cursor_record_key", cursor?.recordKey ?? null);
    }
    if (patch.speed !== undefined) assign("speed", patch.speed);
    if (patch.state !== undefined) assign("state", patch.state);
    if (patch.expectedChecksum !== undefined) assign("expected_checksum", patch.expectedChecksum);
    if (patch.actualChecksum !== undefined) assign("actual_checksum", patch.actualChecksum);
    if (sets.length === 0) return;
    sets.push(`updated_at = now()`);
    await this.pool.query(
      `UPDATE replay_sessions SET ${sets.join(", ")} WHERE id = $1`,
      values,
    );
  }
}
