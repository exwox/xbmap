/**
 * Production ClickHouse runtime adapter implementing the `HistoryStore`
 * contract over the ClickHouse HTTP interface, so the gateway can persist
 * market history without a native client dependency. Table layout matches
 * `migrations/clickhouse/0001_history_v1.sql`; the only additive object is
 * `history_checkpoints_v1`, created idempotently on open() for maintenance
 * cursors. The transport is an injectable `typeof fetch`, mirroring the seam
 * used by the frontend replay API client. INSERT statements ride entirely in
 * the POST body (`INSERT ... FORMAT JSONEachRow\n{rows}`), the canonical
 * ClickHouse HTTP pattern; payloads larger than 1 KiB are gzipped.
 */

import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { writeFile, readFile } from "node:fs/promises";
import {
  HISTORY_SCHEMA_VERSION,
  type AppendResult,
  type BackupResult,
  type HistoricalRecord,
  type HistoricalRecordKind,
  type HistoryQuery,
  type HistoryQueryResult,
  type HistoryRetentionPolicy,
  type HistoryStore,
  type MaintenanceCheckpointStore,
  type RetentionResult,
} from "./types.js";

export interface ClickHouseHistoryStoreOptions {
  url: string;
  database: string;
  user?: string;
  password?: string;
  requestTimeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
}

const KIND_TABLES: Record<HistoricalRecordKind, string> = {
  trade: "raw_trades_v1",
  depth_snapshot: "depth_snapshots_v1",
  depth_delta: "depth_deltas_v1",
  metric_frame: "metric_frames_v1",
};

const ALL_KINDS: readonly HistoricalRecordKind[] = [
  "trade", "depth_snapshot", "depth_delta", "metric_frame",
];

export class ClickHouseStoreError extends Error {
  override readonly name = "ClickHouseStoreError";
}

function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError("ClickHouse identifier is invalid");
  return `"${name}"`;
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** DateTime64(3) literal in millisecond precision, timezone-free and unambiguous. */
function msToDt(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}
export class ClickHouseHistoryStore implements HistoryStore, MaintenanceCheckpointStore {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ClickHouseHistoryStoreOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  /** POSTs the full statement (+data) body; returns the response text. */
  private async send(body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const payload = Buffer.from(body);
      const gzip = payload.byteLength > 1_024 ? gzipSync(payload) : null;
      const response = await this.fetcher(`${this.options.url.replace(/\/$/, "")}/`, {
        method: "POST",
        headers: {
          "X-ClickHouse-User": this.options.user ?? "default",
          ...(this.options.password ? { "X-ClickHouse-Key": this.options.password } : {}),
          "X-ClickHouse-Database": this.options.database,
          ...(gzip ? { "Content-Encoding": "gzip" } : {}),
        },
        body: (gzip ?? payload) as unknown as BodyInit,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ClickHouseStoreError(
          `ClickHouse request failed (${response.status}): ${text.slice(0, 300)}`,
        );
      }
      return text;
    } catch (error) {
      if (error instanceof ClickHouseStoreError) throw error;
      if ((error as Error).name === "AbortError") {
        throw new ClickHouseStoreError(`ClickHouse request timed out after ${this.timeoutMs} ms`);
      }
      throw new ClickHouseStoreError(
        `ClickHouse transport error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async open(): Promise<void> {
    const ping = await this.fetcher(`${this.options.url.replace(/\/$/, "")}/ping`);
    if (!ping.ok) throw new ClickHouseStoreError(`ClickHouse ping failed (${ping.status})`);
    await this.send(`CREATE DATABASE IF NOT EXISTS ${ident(this.options.database)}`);
    await this.send(`
      CREATE TABLE IF NOT EXISTS ${ident(this.options.database)}.history_checkpoints_v1 (
        name String,
        checkpoint UInt64,
        updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
      ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY name
    `);
  }

  async getMaintenanceCheckpoint(name: string): Promise<number | null> {
    const text = await this.send(`
      SELECT argMax(checkpoint, updated_at) AS value
      FROM ${ident(this.options.database)}.history_checkpoints_v1 FINAL
      WHERE name = ${sqlString(name)}
      FORMAT JSON
    `);
    const parsed = JSON.parse(text || "{\"data\":[]}") as { data?: Array<{ value?: number | string }> };
    const value = parsed.data?.[0]?.value;
    const numeric = typeof value === "string" ? Number(value) : value;
    return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : null;
  }

  async setMaintenanceCheckpoint(name: string, timestamp: number): Promise<void> {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new TypeError("Maintenance checkpoint must be a non-negative integer");
    }
    await this.send(
      `INSERT INTO ${ident(this.options.database)}.history_checkpoints_v1 (name, checkpoint) FORMAT JSONEachRow\n` +
      `${JSON.stringify({ name, checkpoint: timestamp })}\n`,
    );
  }

  async appendBatch(records: readonly HistoricalRecord[]): Promise<AppendResult> {
    if (records.length === 0) {
      return { segmentId: "empty", recordCount: 0, uncompressedBytes: 0, compressedBytes: 0 };
    }
    const groups = new Map<HistoricalRecordKind, string[]>();
    let firstSequence = Number.MAX_SAFE_INTEGER;
    let lastSequence = 0;
    for (const record of records) {
      const rows = groups.get(record.kind) ?? [];
      rows.push(JSON.stringify(toRow(record)));
      groups.set(record.kind, rows);
      firstSequence = Math.min(firstSequence, record.captureSequence);
      lastSequence = Math.max(lastSequence, record.captureSequence);
    }
    let uncompressedBytes = 0;
    for (const [kind, rows] of groups) {
      const statement =
        `INSERT INTO ${ident(this.options.database)}.${KIND_TABLES[kind]} ` +
        `(${INSERT_COLUMNS[kind].join(", ")}) FORMAT JSONEachRow\n` +
        rows.map((row) => row + "\n").join("");
      uncompressedBytes += Buffer.byteLength(statement);
      await this.send(statement);
    }
    return {
      segmentId: `${records[0]!.captureId}:${firstSequence}-${lastSequence}`,
      recordCount: records.length,
      uncompressedBytes,
      compressedBytes: uncompressedBytes,
    };
  }

  async query(query: HistoryQuery): Promise<HistoryQueryResult> {
    const kinds = query.kinds && query.kinds.length > 0 ? query.kinds : ALL_KINDS;
    const limit = Math.max(1, Math.min(query.limit ?? 10_000, 100_000));
    const cursor = query.after;
    const selects = kinds.map((kind) => this.kindSelect(kind)).join("\nUNION ALL\n");
    const statement = `
      SELECT * FROM (
        ${selects}
      )
      WHERE exchange = ${sqlString(query.exchange)}
        AND symbol = ${sqlString(query.symbol)}
        AND exchange_ts_ms >= ${query.from}
        AND exchange_ts_ms < ${query.to}
        ${cursor ? `AND (exchange_ts_ms, capture_id, capture_sequence) > (${cursor.timestamp}, ${sqlString(cursor.captureId)}, ${cursor.captureSequence})` : ""}
      ORDER BY exchange_ts_ms, capture_id, capture_sequence
      LIMIT ${limit + 1}
      FORMAT JSONEachRow`;
    const text = await this.send(statement);
    const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const truncated = rows.length > limit;
    const records = (truncated ? rows.slice(0, limit) : rows).map((row) => fromRow(row));
    const last = records.at(-1);
    return {
      records,
      truncated,
      nextCursor: last
        ? {
            timestamp: last.exchangeTimestamp,
            captureSequence: last.captureSequence,
            kind: last.kind,
            captureId: last.captureId,
            recordKey: `${last.captureId}:${last.captureSequence}`,
          }
        : null,
      // Segment-scan metrics are file-store specific; ClickHouse enforces the
      // range server-side through its ordered key.
      scannedSegments: 0,
      scannedCompressedBytes: 0,
    };
  }

  /** Per-kind projection emitting the unified alias set consumed by fromRow(). */
  private kindSelect(kind: HistoricalRecordKind): string {
    const t = `${ident(this.options.database)}.${KIND_TABLES[kind]}`;
    const base = `
      SELECT '${kind}' AS kind,
             schema_version, exchange, symbol, capture_id, capture_sequence,
             toUnixTimestamp64Milli(exchange_timestamp) AS exchange_ts_ms,
             toUnixTimestamp64Milli(received_timestamp) AS received_ms`;
    switch (kind) {
      case "trade":
        return `${base}, trade_id, price_ticks, tick_size, quantity, side FROM ${t}`;
      case "depth_snapshot":
        return `${base}, last_update_id, tick_size, bids_price_ticks, bids_quantity, asks_price_ticks, asks_quantity, state_fingerprint FROM ${t}`;
      case "depth_delta":
        return `${base}, sequence_start, sequence_end, previous_sequence, tick_size, bids_price_ticks, bids_quantity, asks_price_ticks, asks_quantity FROM ${t}`;
      case "metric_frame":
        return `${base},
             toUnixTimestamp64Milli(interval_start) AS interval_start_ms,
             toUnixTimestamp64Milli(interval_end) AS interval_end_ms,
             resolution_ms, interval_buy_volume, interval_sell_volume,
             interval_trade_count, last_price, best_bid, best_ask, spread,
             delta, cvd, buy_volume, sell_volume, buy_sell_ratio, imbalance,
             trade_rate, volume_ratio, momentum_short, momentum_medium,
             latency_ms, stale, trend_direction, trend_score, trend_confidence,
             trend_active, trend_strength,
             toUnixTimestamp64Milli(trend_since) AS trend_since_ms,
             trend_reasons, book_fingerprint, analytics_fingerprint FROM ${t}`;
    }
  }

  async runRetention(policy?: HistoryRetentionPolicy, now?: number): Promise<RetentionResult> {
    const effective = policy ?? DEFAULT_RETENTION;
    const atMs = now ?? this.now();
    const targets: Array<{ table: string; cutoffMs: number }> = [
      { table: KIND_TABLES.trade, cutoffMs: atMs - effective.tradeMs },
      { table: KIND_TABLES.depth_snapshot, cutoffMs: atMs - effective.depthSnapshotMs },
      { table: KIND_TABLES.depth_delta, cutoffMs: atMs - effective.depthDeltaMs },
      ...ALL_RESOLUTIONS.map((resolution) => ({
        table: KIND_TABLES.metric_frame,
        cutoffMs: atMs - effective.metricFrameMs[resolution],
      })),
    ];
    let removedRecords = 0;
    for (const target of targets) removedRecords += await this.deleteBefore(target.table, target.cutoffMs);
    return {
      scannedSegments: 0,
      rewrittenSegments: 0,
      removedSegments: 0,
      removedRecords,
      retainedRecords: 0,
    };
  }

  private async deleteBefore(table: string, cutoffMs: number): Promise<number> {
    const target = `${ident(this.options.database)}.${table}`;
    const predicate = `exchange_timestamp < toDateTime64(${cutoffMs} / 1000, 3, 'UTC')`;
    const countText = await this.send(`SELECT count() AS n FROM ${target} WHERE ${predicate} FORMAT JSON`);
    const parsed = JSON.parse(countText || "{\"data\":[]}") as { data?: Array<{ n?: number | string }> };
    const before = Number(parsed.data?.[0]?.n ?? 0);
    if (before > 0) await this.send(`DELETE FROM ${target} WHERE ${predicate}`);
    return before;
  }

  async createBackup(destination: string): Promise<BackupResult> {
    const lines: string[] = [];
    for (const kind of ALL_KINDS) {
      const text = await this.send(`${this.kindSelect(kind)} ORDER BY capture_id, capture_sequence FORMAT JSONEachRow`);
      for (const line of text.split("\n").filter(Boolean)) lines.push(line);
    }
    const payload = Buffer.from(lines.map((line) => line + "\n").join(""));
    const compressed = gzipSync(payload);
    await writeFile(destination, compressed, { mode: 0o600 });
    return {
      destination,
      segmentCount: ALL_KINDS.length,
      recordCount: lines.length,
      byteCount: compressed.byteLength,
      manifestSha256: createHash("sha256").update(payload).digest("hex"),
    };
  }

  async restoreBackup(source: string): Promise<void> {
    const compressed = await readFile(source);
    const groups = new Map<HistoricalRecordKind, string[]>();
    for (const line of gunzipSync(compressed).toString("utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as { kind?: HistoricalRecordKind };
      if (!row.kind || !INSERT_COLUMNS[row.kind]) continue;
      const rows = groups.get(row.kind) ?? [];
      rows.push(line);
      groups.set(row.kind, rows);
    }
    for (const [kind, rows] of groups) {
      await this.send(
        `INSERT INTO ${ident(this.options.database)}.${KIND_TABLES[kind]} ` +
        `(${INSERT_COLUMNS[kind].join(", ")}) FORMAT JSONEachRow\n` +
        rows.map((row) => row + "\n").join(""),
      );
    }
  }
}

const ALL_RESOLUTIONS = [1_000, 5_000, 60_000] as const;

/** Mirrors DEFAULT_HISTORY_RETENTION; duplicated to keep the module self-contained. */
const DEFAULT_RETENTION: HistoryRetentionPolicy = {
  tradeMs: 90 * 24 * 60 * 60 * 1_000,
  depthSnapshotMs: 30 * 24 * 60 * 60 * 1_000,
  depthDeltaMs: 14 * 24 * 60 * 60 * 1_000,
  metricFrameMs: {
    1_000: 365 * 24 * 60 * 60 * 1_000,
    5_000: 365 * 24 * 60 * 60 * 1_000,
    60_000: 3 * 365 * 24 * 60 * 60 * 1_000,
  },
};

function num(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function reqNum(row: Record<string, unknown>, key: string): number {
  return num(row, key) ?? 0;
}

function reqStr(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : String(value ?? "");
}

function levelsFrom(
  row: Record<string, unknown>,
  priceKey: string,
  quantityKey: string,
): [number, string][] {
  const prices = Array.isArray(row[priceKey]) ? row[priceKey] as unknown[] : [];
  const quantities = Array.isArray(row[quantityKey]) ? row[quantityKey] as unknown[] : [];
  return prices.map((price, index) => [
    Number(price),
    typeof quantities[index] === "string" ? quantities[index] as string : String(quantities[index] ?? "0"),
  ]);
}
/** Rebuilds a typed record from a kindSelect projection row. */
export function fromRow(row: Record<string, unknown>): HistoricalRecord {
  const base = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    exchange: "binance" as const,
    symbol: reqStr(row, "symbol"),
    captureId: reqStr(row, "capture_id"),
    captureSequence: reqNum(row, "capture_sequence"),
    exchangeTimestamp: reqNum(row, "exchange_ts_ms"),
    receivedTimestamp: reqNum(row, "received_ms"),
  };
  switch (row.kind) {
    case "trade":
      return {
        ...base,
        kind: "trade",
        tradeId: reqStr(row, "trade_id"),
        priceTicks: reqNum(row, "price_ticks"),
        tickSize: num(row, "tick_size") ?? 0,
        quantity: reqStr(row, "quantity"),
        side: row.side === "sell" ? "sell" : "buy",
      };
    case "depth_snapshot":
      return {
        ...base,
        kind: "depth_snapshot",
        lastUpdateId: reqNum(row, "last_update_id"),
        tickSize: num(row, "tick_size") ?? 0,
        bids: levelsFrom(row, "bids_price_ticks", "bids_quantity"),
        asks: levelsFrom(row, "asks_price_ticks", "asks_quantity"),
        stateFingerprint: reqStr(row, "state_fingerprint"),
      };
    case "depth_delta":
      return {
        ...base,
        kind: "depth_delta",
        sequenceStart: reqNum(row, "sequence_start"),
        sequenceEnd: reqNum(row, "sequence_end"),
        previousSequence: num(row, "previous_sequence") ?? undefined,
        tickSize: num(row, "tick_size") ?? 0,
        bids: levelsFrom(row, "bids_price_ticks", "bids_quantity"),
        asks: levelsFrom(row, "asks_price_ticks", "asks_quantity"),
      };
    case "metric_frame": {
      const direction = reqStr(row, "trend_direction");
      const score = reqNum(row, "trend_score");
      // Component scores are not persisted by schema v1; derive them.
      return {
        ...base,
        kind: "metric_frame",
        resolutionMs: reqNum(row, "resolution_ms") as 1_000 | 5_000 | 60_000,
        intervalStart: reqNum(row, "interval_start_ms"),
        intervalEnd: reqNum(row, "interval_end_ms"),
        intervalBuyVolume: reqNum(row, "interval_buy_volume"),
        intervalSellVolume: reqNum(row, "interval_sell_volume"),
        intervalTradeCount: reqNum(row, "interval_trade_count"),
        metric: {
          lastPrice: num(row, "last_price"),
          bestBid: num(row, "best_bid"),
          bestAsk: num(row, "best_ask"),
          spread: num(row, "spread"),
          delta: reqNum(row, "delta"),
          cvd: reqNum(row, "cvd"),
          buyVolume: reqNum(row, "buy_volume"),
          sellVolume: reqNum(row, "sell_volume"),
          buySellRatio: reqNum(row, "buy_sell_ratio"),
          imbalance: reqNum(row, "imbalance"),
          tradeRate: reqNum(row, "trade_rate"),
          volumeRatio: reqNum(row, "volume_ratio"),
          momentumShort: reqNum(row, "momentum_short"),
          momentumMedium: reqNum(row, "momentum_medium"),
          latencyMs: num(row, "latency_ms"),
          stale: row.stale === true,
        },
        trend: {
          direction: direction === "up" ? ("up" as const) : direction === "down" ? ("down" as const) : ("neutral" as const),
          score,
          upScore: direction === "up" ? score : 0,
          downScore: direction === "down" ? score : 0,
          confidence: reqNum(row, "trend_confidence"),
          active: row.trend_active === true,
          strength: (["neutral", "forming", "strong", "very_strong"].includes(reqStr(row, "trend_strength"))
            ? reqStr(row, "trend_strength")
            : "neutral") as "neutral" | "forming" | "strong" | "very_strong",
          reasons: Array.isArray(row.trend_reasons) ? row.trend_reasons as string[] : [],
          since: num(row, "trend_since_ms"),
        },
        bookFingerprint: typeof row.book_fingerprint === "string" ? row.book_fingerprint : null,
        analyticsFingerprint: typeof row.analytics_fingerprint === "string" ? row.analytics_fingerprint : null,
      };
    }
    default:
      throw new TypeError(`ClickHouse row has an unsupported kind: ${String(row.kind)}`);
  }
}

/**
 * Environment factory. Returns null unless XBMAP_HISTORY_BACKEND=clickhouse,
 * letting callers fall back to the file adapter unchanged.
 */
export function clickHouseHistoryStoreFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ClickHouseHistoryStore | null {
  if ((environment.XBMAP_HISTORY_BACKEND ?? "").trim().toLowerCase() !== "clickhouse") return null;
  const timeout = Number(environment.XBMAP_CLICKHOUSE_TIMEOUT_MS);
  return new ClickHouseHistoryStore({
    url: environment.XBMAP_CLICKHOUSE_URL?.trim() || "http://127.0.0.1:8123",
    database: environment.XBMAP_CLICKHOUSE_DATABASE?.trim() || "liquidmap",
    user: environment.XBMAP_CLICKHOUSE_USER?.trim() || undefined,
    password: environment.XBMAP_CLICKHOUSE_PASSWORD?.trim() || undefined,
    requestTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000,
  });
}

const INSERT_COLUMNS: Record<HistoricalRecordKind, readonly string[]> = {
  trade: [
    "schema_version", "exchange", "symbol", "capture_id", "capture_sequence",
    "exchange_timestamp", "received_timestamp", "trade_id", "price_ticks",
    "tick_size", "quantity", "side",
  ],
  depth_snapshot: [
    "schema_version", "exchange", "symbol", "capture_id", "capture_sequence",
    "exchange_timestamp", "received_timestamp", "last_update_id", "tick_size",
    "bids_price_ticks", "bids_quantity", "asks_price_ticks", "asks_quantity",
    "state_fingerprint",
  ],
  depth_delta: [
    "schema_version", "exchange", "symbol", "capture_id", "capture_sequence",
    "exchange_timestamp", "received_timestamp", "sequence_start", "sequence_end",
    "previous_sequence", "tick_size", "bids_price_ticks", "bids_quantity",
    "asks_price_ticks", "asks_quantity",
  ],
  metric_frame: [
    "schema_version", "exchange", "symbol", "capture_id", "capture_sequence",
    "exchange_timestamp", "received_timestamp", "resolution_ms", "interval_start",
    "interval_end", "interval_buy_volume", "interval_sell_volume",
    "interval_trade_count", "last_price", "best_bid", "best_ask", "spread",
    "delta", "cvd", "buy_volume", "sell_volume", "buy_sell_ratio", "imbalance",
    "trade_rate", "volume_ratio", "momentum_short", "momentum_medium",
    "latency_ms", "stale", "trend_direction", "trend_score", "trend_confidence",
    "trend_active", "trend_strength", "trend_since", "trend_reasons",
    "book_fingerprint", "analytics_fingerprint",
  ],
};
function baseRow(record: HistoricalRecord): Record<string, unknown> {
  return {
    schema_version: HISTORY_SCHEMA_VERSION,
    exchange: record.exchange,
    symbol: record.symbol,
    capture_id: record.captureId,
    capture_sequence: record.captureSequence,
    exchange_timestamp: msToDt(record.exchangeTimestamp),
    received_timestamp: msToDt(record.receivedTimestamp),
  };
}

function levels(priceKey: string, quantityKey: string, rows: readonly [number, string][]) {
  return {
    [priceKey]: rows.map(([ticks]) => ticks),
    [quantityKey]: rows.map(([, quantity]) => quantity),
  };
}

function toRow(record: HistoricalRecord): Record<string, unknown> {
  switch (record.kind) {
    case "trade":
      return {
        ...baseRow(record),
        trade_id: record.tradeId,
        price_ticks: record.priceTicks,
        tick_size: String(record.tickSize),
        quantity: record.quantity,
        side: record.side,
      };
    case "depth_snapshot":
      return {
        ...baseRow(record),
        last_update_id: record.lastUpdateId,
        tick_size: String(record.tickSize),
        ...levels("bids_price_ticks", "bids_quantity", record.bids),
        ...levels("asks_price_ticks", "asks_quantity", record.asks),
        state_fingerprint: record.stateFingerprint,
      };
    case "depth_delta":
      return {
        ...baseRow(record),
        sequence_start: record.sequenceStart,
        sequence_end: record.sequenceEnd,
        previous_sequence: record.previousSequence ?? null,
        tick_size: String(record.tickSize),
        ...levels("bids_price_ticks", "bids_quantity", record.bids),
        ...levels("asks_price_ticks", "asks_quantity", record.asks),
      };
    case "metric_frame":
      return {
        ...baseRow(record),
        resolution_ms: record.resolutionMs,
        interval_start: msToDt(record.intervalStart),
        interval_end: msToDt(record.intervalEnd),
        interval_buy_volume: record.intervalBuyVolume,
        interval_sell_volume: record.intervalSellVolume,
        interval_trade_count: record.intervalTradeCount,
        last_price: record.metric.lastPrice,
        best_bid: record.metric.bestBid,
        best_ask: record.metric.bestAsk,
        spread: record.metric.spread,
        delta: record.metric.delta,
        cvd: record.metric.cvd,
        buy_volume: record.metric.buyVolume,
        sell_volume: record.metric.sellVolume,
        buy_sell_ratio: record.metric.buySellRatio,
        imbalance: record.metric.imbalance,
        trade_rate: record.metric.tradeRate,
        volume_ratio: record.metric.volumeRatio,
        momentum_short: record.metric.momentumShort,
        momentum_medium: record.metric.momentumMedium,
        latency_ms: record.metric.latencyMs,
        stale: record.metric.stale,
        trend_direction: record.trend.direction,
        trend_score: record.trend.score,
        trend_confidence: record.trend.confidence,
        trend_active: record.trend.active,
        trend_strength: record.trend.strength,
        trend_since: record.trend.since === null ? null : msToDt(record.trend.since),
        trend_reasons: record.trend.reasons,
        book_fingerprint: record.bookFingerprint,
        analytics_fingerprint: record.analyticsFingerprint,
      };
  }
}
// __PART_E__


