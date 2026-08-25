import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BatchedHistoryWriter } from "../storage/batchedWriter.js";
import { DownsampleWorker } from "../storage/downsampleWorker.js";
import { FileHistoryStore } from "../storage/fileHistoryStore.js";
import {
  HistoryQueryLimitError,
  type HistoricalRecord,
  type HistoryRetentionPolicy,
  type StoredMetricFrame,
  type StoredTrade,
} from "../storage/types.js";

const BASE_TIME = 1_700_000_000_000;

describe("FileHistoryStore", () => {
  it("persists compressed typed history across restart and paginates deterministically", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "liquidmap-history-"));
    try {
      const directory = join(temporary, "history");
      const first = new FileHistoryStore({ directory });
      await first.appendBatch(fourRecordKinds());
      const files = await readdir(join(directory, "segments"));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.ndjson\.gz$/);

      const restarted = new FileHistoryStore({ directory });
      const pageOne = await restarted.query({
        exchange: "binance",
        symbol: "BTCUSDT",
        from: BASE_TIME,
        to: BASE_TIME + 1,
        limit: 2,
      });
      expect(pageOne.records.map((record) => record.kind)).toEqual([
        "depth_snapshot",
        "depth_delta",
      ]);
      expect(pageOne.truncated).toBe(true);
      expect(pageOne.nextCursor).toMatchObject({ captureId: "capture-a" });

      const pageTwo = await restarted.query({
        exchange: "binance",
        symbol: "BTCUSDT",
        from: BASE_TIME,
        to: BASE_TIME + 1,
        after: pageOne.nextCursor!,
        limit: 2,
      });
      expect(pageTwo.records.map((record) => record.kind)).toEqual([
        "trade",
        "metric_frame",
      ]);
      expect(pageTwo.truncated).toBe(false);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects oversized range, row, segment, and byte scans before materializing them", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "liquidmap-history-limits-"));
    try {
      const store = new FileHistoryStore({
        directory: join(temporary, "history"),
        limits: {
          maxRangeMs: 10_000,
          maxRows: 2,
          defaultRows: 2,
          maxScannedSegments: 1,
          maxScannedCompressedBytes: 1_000_000,
        },
      });
      await store.appendBatch([trade(1, BASE_TIME)]);
      await expect(store.query({
        exchange: "binance",
        symbol: "BTCUSDT",
        from: BASE_TIME,
        to: BASE_TIME + 10_001,
      })).rejects.toMatchObject({ code: "RANGE_LIMIT" } satisfies Partial<HistoryQueryLimitError>);
      await expect(store.query({
        exchange: "binance",
        symbol: "BTCUSDT",
        from: BASE_TIME,
        to: BASE_TIME + 1,
        limit: 3,
      })).rejects.toMatchObject({ code: "ROW_LIMIT" } satisfies Partial<HistoryQueryLimitError>);
      await store.appendBatch([trade(2, BASE_TIME)]);
      await expect(store.query({
        exchange: "binance",
        symbol: "BTCUSDT",
        from: BASE_TIME,
        to: BASE_TIME + 1,
      })).rejects.toMatchObject({ code: "SEGMENT_LIMIT" } satisfies Partial<HistoryQueryLimitError>);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("creates a verified atomic backup and restores catalog, data, and checkpoints", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "liquidmap-history-backup-"));
    try {
      const directory = join(temporary, "history");
      const backup = join(temporary, "backup-1");
      const store = new FileHistoryStore({ directory });
      await store.appendBatch([trade(1, BASE_TIME)]);
      await store.setMaintenanceCheckpoint("test:checkpoint", BASE_TIME + 1);
      const backupResult = await store.createBackup(backup);
      expect(backupResult).toMatchObject({ segmentCount: 1, recordCount: 1 });
      expect(backupResult.manifestSha256).toMatch(/^[a-f0-9]{64}$/);

      await store.appendBatch([trade(2, BASE_TIME + 1)]);
      await store.setMaintenanceCheckpoint("test:checkpoint", BASE_TIME + 2);
      await store.restoreBackup(backup);

      const restarted = new FileHistoryStore({ directory });
      const restored = await restarted.query({
        exchange: "binance",
        symbol: "BTCUSDT",
        from: BASE_TIME,
        to: BASE_TIME + 10,
      });
      expect(restored.records.map((record) => record.captureSequence)).toEqual([1]);
      expect(await restarted.getMaintenanceCheckpoint("test:checkpoint")).toBe(BASE_TIME + 1);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rewrites expired mixed segments while preserving concurrent ingestion", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "liquidmap-history-retention-"));
    try {
      const now = BASE_TIME + 100_000;
      const store = new FileHistoryStore({ directory: join(temporary, "history") });
      await store.appendBatch([
        trade(1, BASE_TIME),
        trade(2, now - 1_000),
      ]);
      const policy: HistoryRetentionPolicy = {
        tradeMs: 5_000,
        depthSnapshotMs: 5_000,
        depthDeltaMs: 5_000,
        metricFrameMs: { 1_000: 5_000, 5_000: 5_000, 60_000: 5_000 },
      };
      const [retention] = await Promise.all([
        store.runRetention(policy, now),
        store.appendBatch([trade(3, now)]),
      ]);
      expect(retention).toMatchObject({ removedRecords: 1, retainedRecords: 1 });

      const result = await store.query({
        exchange: "binance",
        symbol: "BTCUSDT",
        from: BASE_TIME,
        to: now + 1,
      });
      expect(result.records.map((record) => record.captureSequence)).toEqual([2, 3]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("BatchedHistoryWriter", () => {
  it("drains bounded batches and exposes overload without per-event writes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "liquidmap-history-batch-"));
    try {
      const store = new FileHistoryStore({ directory: join(temporary, "history") });
      const writer = new BatchedHistoryWriter(store, {
        batchRecords: 2,
        queueRecords: 10,
        queueBytes: 1_000_000,
        flushIntervalMs: 60_000,
      });
      expect(writer.enqueueMany(Array.from({ length: 5 }, (_, index) =>
        trade(index + 1, BASE_TIME + index)))).toBe(5);
      await writer.close();
      expect(writer.stats).toMatchObject({
        acceptedRecords: 5,
        persistedRecords: 5,
        rejectedRecords: 0,
        batches: 3,
        pendingRecords: 0,
      });

      const bounded = new BatchedHistoryWriter(store, {
        batchRecords: 1,
        queueRecords: 1,
        queueBytes: 1_000_000,
        flushIntervalMs: 60_000,
      });
      expect(bounded.enqueue(trade(10, BASE_TIME + 10))).toBe(true);
      expect(bounded.enqueue(trade(11, BASE_TIME + 11))).toBe(false);
      expect(bounded.stats.queueOverflows).toBe(1);
      await bounded.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("DownsampleWorker", () => {
  it("sums interval facts, keeps the latest rolling metric, and is restart-idempotent", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "liquidmap-history-downsample-"));
    try {
      const directory = join(temporary, "history");
      const store = new FileHistoryStore({ directory });
      await store.appendBatch(Array.from({ length: 5 }, (_, index) =>
        metric(index + 1, BASE_TIME + index * 1_000, index + 1)));
      const job = {
        exchange: "binance" as const,
        symbol: "BTCUSDT",
        captureId: "capture-a",
        sourceResolutionMs: 1_000 as const,
        targetResolutionMs: 5_000 as const,
      };
      const first = await new DownsampleWorker(store).run(job, {
        from: BASE_TIME,
        to: BASE_TIME + 5_000,
        settleDelayMs: 0,
      });
      expect(first).toMatchObject({ writtenFrames: 1, completedThrough: BASE_TIME + 5_000 });

      const result = await store.query({
        exchange: "binance",
        symbol: "BTCUSDT",
        captureId: "capture-a",
        from: BASE_TIME,
        to: BASE_TIME + 5_000,
        kinds: ["metric_frame"],
        resolutionMs: 5_000,
      });
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        intervalBuyVolume: 15,
        intervalSellVolume: 7.5,
        intervalTradeCount: 15,
        metric: { delta: 5, cvd: 50 },
      });

      const restarted = new FileHistoryStore({ directory });
      const second = await new DownsampleWorker(restarted).run(job, {
        from: BASE_TIME,
        to: BASE_TIME + 5_000,
        settleDelayMs: 0,
      });
      expect(second.writtenFrames).toBe(0);
      const afterRestart = await restarted.query({
        exchange: "binance",
        symbol: "BTCUSDT",
        captureId: "capture-a",
        from: BASE_TIME,
        to: BASE_TIME + 5_000,
        kinds: ["metric_frame"],
        resolutionMs: 5_000,
      });
      expect(afterRestart.records).toHaveLength(1);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("cascades complete 1s buckets through 5s into one deterministic 1m frame", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "liquidmap-history-one-minute-"));
    try {
      const directory = join(temporary, "history");
      const store = new FileHistoryStore({ directory });
      const minuteStart = Math.floor(BASE_TIME / 60_000) * 60_000;
      await store.appendBatch(Array.from({ length: 60 }, (_, index) =>
        metric(index + 1, minuteStart + index * 1_000, index + 1)));
      const worker = new DownsampleWorker(store);

      await expect(worker.run({
        exchange: "binance",
        symbol: "BTCUSDT",
        captureId: "capture-a",
        sourceResolutionMs: 1_000,
        targetResolutionMs: 5_000,
      }, {
        from: minuteStart,
        to: minuteStart + 60_000,
        settleDelayMs: 0,
      })).resolves.toMatchObject({ writtenFrames: 12 });

      await expect(worker.run({
        exchange: "binance",
        symbol: "BTCUSDT",
        captureId: "capture-a",
        sourceResolutionMs: 5_000,
        targetResolutionMs: 60_000,
      }, {
        from: minuteStart,
        to: minuteStart + 60_000,
        settleDelayMs: 0,
      })).resolves.toMatchObject({ writtenFrames: 1 });

      const minute = await store.query({
        exchange: "binance",
        symbol: "BTCUSDT",
        captureId: "capture-a",
        from: minuteStart,
        to: minuteStart + 60_000,
        kinds: ["metric_frame"],
        resolutionMs: 60_000,
      });
      expect(minute.records).toHaveLength(1);
      expect(minute.records[0]).toMatchObject({
        intervalBuyVolume: 1_830,
        intervalSellVolume: 915,
        intervalTradeCount: 1_830,
        metric: { delta: 60, cvd: 600 },
      });

      const restarted = new FileHistoryStore({ directory });
      await expect(new DownsampleWorker(restarted).run({
        exchange: "binance",
        symbol: "BTCUSDT",
        captureId: "capture-a",
        sourceResolutionMs: 5_000,
        targetResolutionMs: 60_000,
      }, {
        from: minuteStart,
        to: minuteStart + 60_000,
        settleDelayMs: 0,
      })).resolves.toMatchObject({ writtenFrames: 0 });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

function fourRecordKinds(): HistoricalRecord[] {
  return [
    {
      schemaVersion: 1,
      kind: "trade",
      exchange: "binance",
      symbol: "BTCUSDT",
      captureId: "capture-a",
      captureSequence: 3,
      exchangeTimestamp: BASE_TIME,
      receivedTimestamp: BASE_TIME,
      tradeId: "trade-3",
      priceTicks: 1_000,
      tickSize: 0.1,
      quantity: "1",
      side: "buy",
    },
    {
      schemaVersion: 1,
      kind: "depth_snapshot",
      exchange: "binance",
      symbol: "BTCUSDT",
      captureId: "capture-a",
      captureSequence: 1,
      exchangeTimestamp: BASE_TIME,
      receivedTimestamp: BASE_TIME,
      lastUpdateId: 100,
      tickSize: 0.1,
      bids: [[999, "2"]],
      asks: [[1_001, "2"]],
      stateFingerprint: "a".repeat(64),
    },
    {
      schemaVersion: 1,
      kind: "depth_delta",
      exchange: "binance",
      symbol: "BTCUSDT",
      captureId: "capture-a",
      captureSequence: 2,
      exchangeTimestamp: BASE_TIME,
      receivedTimestamp: BASE_TIME,
      sequenceStart: 101,
      sequenceEnd: 101,
      previousSequence: 100,
      tickSize: 0.1,
      bids: [[999, "3"]],
      asks: [[1_001, "0"]],
    },
    metric(4, BASE_TIME, 1),
  ];
}

function trade(captureSequence: number, timestamp: number): StoredTrade {
  return {
    schemaVersion: 1,
    kind: "trade",
    exchange: "binance",
    symbol: "BTCUSDT",
    captureId: "capture-a",
    captureSequence,
    exchangeTimestamp: timestamp,
    receivedTimestamp: timestamp + 1,
    tradeId: `trade-${captureSequence}`,
    priceTicks: 1_000 + captureSequence,
    tickSize: 0.1,
    quantity: "1",
    side: captureSequence % 2 ? "buy" : "sell",
  };
}

function metric(
  captureSequence: number,
  intervalStart: number,
  intervalValue: number,
): StoredMetricFrame {
  return {
    schemaVersion: 1,
    kind: "metric_frame",
    exchange: "binance",
    symbol: "BTCUSDT",
    captureId: "capture-a",
    captureSequence,
    exchangeTimestamp: intervalStart,
    receivedTimestamp: intervalStart + 900,
    resolutionMs: 1_000,
    intervalStart,
    intervalEnd: intervalStart + 1_000,
    intervalBuyVolume: intervalValue,
    intervalSellVolume: intervalValue / 2,
    intervalTradeCount: intervalValue,
    metric: {
      lastPrice: 100 + intervalValue,
      bestBid: 100,
      bestAsk: 100.1,
      spread: 0.1,
      delta: intervalValue,
      cvd: intervalValue * 10,
      buyVolume: intervalValue * 10,
      sellVolume: intervalValue * 5,
      buySellRatio: 2,
      imbalance: 0.2,
      tradeRate: intervalValue,
      volumeRatio: 1,
      momentumShort: 0.1,
      momentumMedium: 0.05,
      latencyMs: 2,
      stale: false,
    },
    trend: {
      direction: "up",
      score: 70,
      upScore: 70,
      downScore: 10,
      confidence: 0.8,
      active: true,
      strength: "strong",
      reasons: ["test"],
      since: BASE_TIME,
    },
    bookFingerprint: "b".repeat(64),
    analyticsFingerprint: "c".repeat(64),
  };
}
