import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ClickHouseHistoryStore,
  clickHouseHistoryStoreFromEnvironment,
} from "./clickHouseHistoryStore.js";
import type { HistoricalRecord } from "./types.js";

interface CapturedCall { url: string; body: string }

function makeStore(respond: (body: string) => string) {
  const calls: CapturedCall[] = [];
  const decode = (input: unknown): string => {
    if (typeof input === "string") return input;
    if (input instanceof Uint8Array) {
      const buffer = Buffer.from(input);
      return buffer[0] === 0x1f && buffer[1] === 0x8b
        ? gunzipSync(buffer).toString("utf8")
        : buffer.toString("utf8");
    }
    return "";
  };
  const fetcher = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: decode(init?.body) });
    return { ok: true, status: 200, text: async () => respond(decode(init?.body)) } as Response;
  }) as typeof fetch;
  const store = new ClickHouseHistoryStore({
    url: "http://127.0.0.1:8123",
    database: "liquidmap",
    fetcher,
  });
  return { store, calls };
}

const BASE = 1_700_000_000_000;

const TRADE: HistoricalRecord = {
  schemaVersion: 1, exchange: "binance", symbol: "BTCUSDT", captureId: "cap-1",
  captureSequence: 7, exchangeTimestamp: BASE + 5, receivedTimestamp: BASE + 6,
  kind: "trade", tradeId: "42", priceTicks: 1000, tickSize: 0.1,
  quantity: "0.400000000", side: "buy",
};

const METRIC_ROW = JSON.stringify({
  kind: "metric_frame", schema_version: 1, exchange: "binance",
  symbol: "BTCUSDT", capture_id: "cap-1", capture_sequence: 8,
  exchange_ts_ms: BASE + 1000, received_ms: BASE + 1001,
  interval_start_ms: BASE, interval_end_ms: BASE + 1000,
  resolution_ms: 1000, interval_buy_volume: 1.5, interval_sell_volume: 0.5,
  interval_trade_count: 12, last_price: 100, best_bid: 99.9, best_ask: 100.1,
  spread: 0.2, delta: 1, cvd: 3, buy_volume: 10, sell_volume: 9,
  buy_sell_ratio: 1.1, imbalance: 0.05, trade_rate: 4, volume_ratio: 0.9,
  momentum_short: 0.2, momentum_medium: -0.1, latency_ms: 12, stale: false,
  trend_direction: "up", trend_score: 72, trend_confidence: 0.8,
  trend_active: true, trend_strength: "strong", trend_since_ms: BASE,
  trend_reasons: ["cvd slope"], book_fingerprint: "a".repeat(64),
  analytics_fingerprint: null,
});

describe("ClickHouse history store", () => {
  it("pings and creates the checkpoint table on open", async () => {
    const statements: string[] = [];
    const fetcher = (async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).includes("/ping")) {
        return { ok: true, status: 200, text: async () => "Ok.\n" } as Response;
      }
      const body = init?.body instanceof Uint8Array
        ? Buffer.from(init.body).toString("utf8")
        : String(init?.body ?? "");
      statements.push(body);
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as typeof fetch;
    const store = new ClickHouseHistoryStore({
      url: "http://127.0.0.1:8123", database: "liquidmap", fetcher,
    });
    await store.open();
    expect(statements.some((statement) => statement.includes("CREATE DATABASE IF NOT EXISTS"))).toBe(true);
    expect(statements.some((statement) => statement.includes("history_checkpoints_v1"))).toBe(true);
  });

  it("routes appended records to kind tables with JSONEachRow payloads", async () => {
    const { store, calls } = makeStore(() => "");
    const metric = JSON.parse(JSON.stringify({
      schemaVersion: 1, exchange: "binance", symbol: "BTCUSDT", captureId: "cap-1",
      captureSequence: 8, exchangeTimestamp: BASE + 1000, receivedTimestamp: BASE + 1001,
      kind: "metric_frame", resolutionMs: 1000, intervalStart: BASE,
      intervalEnd: BASE + 1000, intervalBuyVolume: 1.5, intervalSellVolume: 0.5,
      intervalTradeCount: 12,
      metric: { lastPrice: 100, bestBid: 99.9, bestAsk: 100.1, spread: 0.2, delta: 1, cvd: 3, buyVolume: 10, sellVolume: 9, buySellRatio: 1.1, imbalance: 0.05, tradeRate: 4, volumeRatio: 0.9, momentumShort: 0.2, momentumMedium: -0.1, latencyMs: 12, stale: false },
      trend: { direction: "up", score: 72, upScore: 72, downScore: 0, confidence: 0.8, active: true, strength: "strong", reasons: ["cvd slope"], since: BASE },
      bookFingerprint: "a".repeat(64), analyticsFingerprint: null,
    })) as HistoricalRecord;
    await store.appendBatch([TRADE, metric]);
    const inserts = calls.filter((call) => call.body.startsWith("INSERT INTO"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.body).toContain("raw_trades_v1");
    expect(inserts[0]!.body).toContain('"trade_id":"42"');
    expect(inserts[1]!.body).toContain("metric_frames_v1");
    expect(inserts[1]!.body).toContain('"trend_direction":"up"');
  });

  it("queries across kinds and restores typed records with a cursor", async () => {
    const row = JSON.stringify({
      kind: "trade", schema_version: 1, exchange: "binance", symbol: "BTCUSDT",
      capture_id: "cap-1", capture_sequence: 7,
      exchange_ts_ms: TRADE.exchangeTimestamp, received_ms: TRADE.receivedTimestamp,
      trade_id: "42", price_ticks: 1000, tick_size: "0.1", quantity: "0.400000000",
      side: "buy",
    });
    const { store } = makeStore(() => row);
    const result = await store.query({
      exchange: "binance", symbol: "BTCUSDT", from: BASE, to: BASE + 60_000, limit: 10,
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ kind: "trade", tradeId: "42", priceTicks: 1000 });
    expect(result.nextCursor).toMatchObject({ captureSequence: 7, captureId: "cap-1" });
    expect(result.truncated).toBe(false);
  });
  it("round-trips maintenance checkpoints through argMax and inserts", async () => {
    let checkpointResponse = "{\"data\":[{\"value\":\"0\"}]}";
    const { store, calls } = makeStore((body) =>
      body.includes("argMax") ? checkpointResponse : "");
    await store.setMaintenanceCheckpoint("downsample-1s", BASE);
    expect(calls.at(-1)!.body).toContain('"checkpoint":' + BASE);
    checkpointResponse = "{\"data\":[{\"value\":" + BASE + "}]}";
    await expect(store.getMaintenanceCheckpoint("downsample-1s")).resolves.toBe(BASE);
  });

  it("counts then deletes expired rows during retention", async () => {
    const { store, calls } = makeStore((body) =>
      body.includes("count()") ? "{\"data\":[{\"n\":3}]}" : "");
    const result = await store.runRetention(undefined, BASE);
    expect(result.removedRecords).toBe(18); // 6 targets x 3 counted rows each
    const deletes = calls.filter((call) => call.body.startsWith("DELETE FROM"));
    expect(deletes).toHaveLength(6);
    expect(deletes[0]!.body).toContain("raw_trades_v1");
  });

  it("backs up all kinds to a gzipped manifest and restores them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-ch-backup-"));
    try {
      let mode: "backup" | "restore" = "backup";
      const { store, calls } = makeStore(() => (mode === "backup" ? METRIC_ROW : ""));
      const destination = join(directory, "backup.ndjson.gz");
      const result = await store.createBackup(destination);
      expect(result.recordCount).toBeGreaterThan(0);
      expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);

      const compressed = await readFile(destination);
      expect(gunzipSync(compressed).toString("utf8")).toContain('"kind":"metric_frame"');

      mode = "restore";
      await store.restoreBackup(destination);
      const restoreInsert = calls.filter((call) => call.body.startsWith("INSERT INTO")).at(-1)!;
      expect(restoreInsert.body).toContain("metric_frames_v1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("is selected only when XBMAP_HISTORY_BACKEND=clickhouse", () => {
    expect(clickHouseHistoryStoreFromEnvironment({})).toBeNull();
    expect(clickHouseHistoryStoreFromEnvironment({ XBMAP_HISTORY_BACKEND: "file" })).toBeNull();
    const selected = clickHouseHistoryStoreFromEnvironment({
      XBMAP_HISTORY_BACKEND: "clickhouse",
      XBMAP_CLICKHOUSE_URL: "http://ch:8123",
    });
    expect(selected).toBeInstanceOf(ClickHouseHistoryStore);
  });
});
