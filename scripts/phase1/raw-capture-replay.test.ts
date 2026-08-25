import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { describe, expect, it } from "vitest";
import { OrderBook } from "../../server/core/orderBook.js";
import {
  RawCaptureRecorder,
  type RawCaptureEnvelope,
  type RawCaptureManifest,
  type RawCaptureRecord,
} from "../../server/recording/rawCapture.js";
import type {
  BookCheckpoint,
  DepthSnapshot,
  DepthUpdate,
  WirePriceLevel,
} from "../../server/types.js";

const GOLDEN_CHECKPOINT: BookCheckpoint = {
  algorithm: "sha256",
  fingerprint: "2e07027bc6fc75bfd4d7820ec3e9386dc5ce96f1398b2726ff5d78780cf377e2",
  lastUpdateId: 104,
  bidLevelCount: 3,
  askLevelCount: 3,
  bestBid: 100,
  bestAsk: 100.2,
};

const RAW_SNAPSHOT = JSON.stringify({
  lastUpdateId: 100,
  bids: [["100.0", "1.5"], ["99.9", "2"], ["99.8", "3"]],
  asks: [["100.1", "1"], ["100.2", "2.5"], ["100.3", "4"]],
});

const RAW_DEPTH_ONE = JSON.stringify({
  e: "depthUpdate",
  E: 1_700_000_000_010,
  T: 1_700_000_000_009,
  s: "BTCUSDT",
  U: 101,
  u: 102,
  pu: 100,
  b: [["100.0", "2.25"], ["99.9", "0"], ["99.7", "5"]],
  a: [["100.1", "0.75"], ["100.2", "0"], ["100.4", "1.2"]],
});

const RAW_DEPTH_TWO = JSON.stringify({
  e: "depthUpdate",
  E: 1_700_000_000_020,
  T: 1_700_000_000_019,
  s: "BTCUSDT",
  U: 103,
  u: 104,
  pu: 102,
  b: [["99.8", "0"], ["99.9", "1.1"]],
  a: [["100.1", "0"], ["100.2", "3.2"]],
});

describe("Phase 1 raw-capture production replay", () => {
  it("replays gzip NDJSON by captureSequence to the same golden OrderBook twice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-raw-replay-"));
    try {
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "deterministic-replay",
        now: () => 1_700_000_001_000,
      });
      const records: RawCaptureRecord[] = [
        captureRecord("snapshot", RAW_SNAPSHOT, 1_700_000_000_003),
        captureRecord("depth", RAW_DEPTH_ONE, 1_700_000_000_002),
        captureRecord("depth", RAW_DEPTH_TWO, 1_700_000_000_001),
      ];
      for (const record of records) expect(recorder.record(record)).toBe(true);

      const stats = await recorder.close();
      const manifest = JSON.parse(
        await readFile(stats.manifestPath, "utf8"),
      ) as RawCaptureManifest;
      const compressedBytes = await readFile(stats.dataPath);
      expect([...compressedBytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
      expect(manifest).toMatchObject({
        captureSchemaVersion: 1,
        complete: true,
        compression: "gzip",
        sequence: {
          field: "captureSequence",
          first: 1,
          lastWritten: 3,
          contiguous: true,
        },
      });

      const first = await replayRawDepthCapture(stats.dataPath, 0.1);
      const second = await replayRawDepthCapture(stats.dataPath, 0.1);

      expect(first).toEqual(second);
      expect(first.captureSequences).toEqual([1, 2, 3]);
      // capturedAt is deliberately descending: replay order must come from
      // captureSequence, never wall-clock arrival timestamps.
      expect(first.capturedAt).toEqual([
        1_700_000_000_003,
        1_700_000_000_002,
        1_700_000_000_001,
      ]);
      expect(first.appliedRanges).toEqual([[101, 102, 100], [103, 104, 102]]);
      expect(first.checkpoint).toEqual(GOLDEN_CHECKPOINT);
      expect(first.levels).toEqual({
        bids: [[100, 2.25], [99.9, 1.1], [99.7, 5]],
        asks: [[100.2, 3.2], [100.3, 4], [100.4, 1.2]],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

interface ReplayResult {
  captureSequences: number[];
  capturedAt: number[];
  appliedRanges: Array<[start: number, end: number, previous: number | undefined]>;
  checkpoint: BookCheckpoint;
  levels: ReturnType<OrderBook["getLevels"]>;
}

async function replayRawDepthCapture(path: string, tickSize: number): Promise<ReplayResult> {
  const book = new OrderBook(tickSize);
  const captureSequences: number[] = [];
  const capturedAt: number[] = [];
  const appliedRanges: ReplayResult["appliedRanges"] = [];
  let expectedCaptureSequence = 1;

  for await (const envelope of readCaptureEnvelopes(path)) {
    if (envelope.captureSequence !== expectedCaptureSequence) {
      throw new Error(
        `Non-contiguous captureSequence: expected ${expectedCaptureSequence}, got ${envelope.captureSequence}`,
      );
    }
    expectedCaptureSequence += 1;
    captureSequences.push(envelope.captureSequence);
    capturedAt.push(envelope.capturedAt);

    if (envelope.stream === "snapshot") {
      book.loadSnapshot(parseSnapshot(envelope.payload));
      continue;
    }
    if (envelope.stream !== "depth") continue;

    const update = parseBinanceDepth(envelope);
    const result = book.applyUpdate(update);
    if (result.status !== "applied") {
      throw new Error(
        `Depth ${update.sequenceStart}-${update.sequenceEnd} was ${result.status}: ${result.reason ?? "unknown"}`,
      );
    }
    appliedRanges.push([
      update.sequenceStart,
      update.sequenceEnd,
      update.previousSequence,
    ]);
  }

  if (!book.isSynchronized || captureSequences.length === 0) {
    throw new Error("Capture did not produce a synchronized order book");
  }
  return {
    captureSequences,
    capturedAt,
    appliedRanges,
    checkpoint: book.checkpoint(),
    levels: book.getLevels(1_000),
  };
}

async function* readCaptureEnvelopes(path: string): AsyncGenerator<RawCaptureEnvelope> {
  const gzip = createReadStream(path).pipe(createGunzip());
  const lines = createInterface({ input: gzip, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (!isRawCaptureEnvelope(value)) throw new Error("Malformed raw-capture envelope");
      yield value;
    }
  } finally {
    lines.close();
    gzip.destroy();
  }
}

function parseSnapshot(payload: string): DepthSnapshot {
  const value: unknown = JSON.parse(payload);
  if (!isObject(value) || !Number.isSafeInteger(value.lastUpdateId)) {
    throw new Error("Malformed raw REST snapshot");
  }
  return {
    lastUpdateId: value.lastUpdateId as number,
    bids: parseLevels(value.bids),
    asks: parseLevels(value.asks),
  };
}

function parseBinanceDepth(envelope: RawCaptureEnvelope): DepthUpdate {
  const value: unknown = JSON.parse(envelope.payload);
  if (
    !isObject(value)
    || value.e !== "depthUpdate"
    || value.s !== envelope.symbol
    || !Number.isSafeInteger(value.E)
    || !Number.isSafeInteger(value.U)
    || !Number.isSafeInteger(value.u)
    || (value.pu !== undefined && !Number.isSafeInteger(value.pu))
  ) {
    throw new Error("Malformed raw Binance depth payload");
  }
  const exchangeTimestamp = Number.isSafeInteger(value.T) ? value.T : value.E;
  return {
    exchangeTimestamp: exchangeTimestamp as number,
    receivedTimestamp: envelope.capturedAt,
    sequenceStart: value.U as number,
    sequenceEnd: value.u as number,
    ...(value.pu !== undefined ? { previousSequence: value.pu as number } : {}),
    bids: parseLevels(value.b),
    asks: parseLevels(value.a),
  };
}

function parseLevels(value: unknown): WirePriceLevel[] {
  if (!Array.isArray(value)) throw new Error("Depth levels must be an array");
  return value.map((level) => {
    if (
      !Array.isArray(level)
      || level.length < 2
      || !isWireNumber(level[0])
      || !isWireNumber(level[1])
    ) {
      throw new Error("Malformed raw depth level");
    }
    return [level[0], level[1]];
  });
}

function isRawCaptureEnvelope(value: unknown): value is RawCaptureEnvelope {
  if (!isObject(value)) return false;
  return Number.isSafeInteger(value.captureSequence)
    && (value.captureSequence as number) > 0
    && Number.isFinite(value.capturedAt)
    && value.exchange === "binance"
    && typeof value.symbol === "string"
    && (value.source === "binance" || value.source === "demo")
    && ["depth", "trade", "snapshot", "status"].includes(String(value.stream))
    && typeof value.connectionId === "string"
    && typeof value.payload === "string";
}

function captureRecord(
  stream: "snapshot" | "depth",
  payload: string,
  capturedAt: number,
): RawCaptureRecord {
  return {
    capturedAt,
    exchange: "binance",
    symbol: "BTCUSDT",
    source: "binance",
    stream,
    connectionId: "binance-42",
    payload,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWireNumber(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}
