import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RawCaptureRecorder } from "../recording/rawCapture.js";
import { RawReplayRuntime } from "../replayRuntime.js";
import { RawCaptureCatalog } from "./rawCaptureCatalog.js";
import { RawCaptureReplaySource } from "./replaySource.js";

function raw(stream: "snapshot" | "depth" | "trade", payload: string, capturedAt: number) {
  return {
    capturedAt,
    exchange: "binance",
    symbol: "BTCUSDT",
    source: "binance",
    stream,
    connectionId: "binance-1",
    payload,
  } as const;
}

const SNAPSHOT = JSON.stringify({
  lastUpdateId: 100,
  bids: [["100.0", "1"]],
  asks: [["100.1", "1"]],
});

const DEPTH_101 = JSON.stringify({
  e: "depthUpdate", E: 1, T: 1, s: "BTCUSDT",
  U: 101, u: 101, pu: 100,
  b: [["100.0", "2"]], a: [],
});

const TRADE = JSON.stringify({
  e: "aggTrade", E: 1, T: 1, s: "BTCUSDT",
  a: 42, p: "100.1", q: "0.4", m: false,
});

const DEPTH_102 = JSON.stringify({
  e: "depthUpdate", E: 1, T: 1, s: "BTCUSDT",
  U: 102, u: 102, pu: 101,
  b: [], a: [["100.1", "3"]],
});

// Fixture timestamps anchor on the real clock so RawReplayRuntime's default
// Date.now-based session anchors line up with the recorded capture window.
const BASE = Date.now();

async function writeCapture(directory: string): Promise<void> {
  const recorder = new RawCaptureRecorder({
    directory,
    symbol: "BTCUSDT",
    id: "preroll-test",
    // Pin the segment wall clock inside the queried replay range.
    now: () => BASE + 150,
  });
  expect(recorder.record(raw("snapshot", SNAPSHOT, BASE + 100))).toBe(true);
  expect(recorder.record(raw("depth", DEPTH_101, BASE + 200))).toBe(true);
  expect(recorder.record(raw("trade", TRADE, BASE + 250))).toBe(true);
  expect(recorder.record(raw("depth", DEPTH_102, BASE + 300))).toBe(true);
  await recorder.close();
}

describe("raw capture seek pre-roll", () => {
  it("opens a post-seek page with the anchoring snapshot plus its deltas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-preroll-source-"));
    try {
      await writeCapture(directory);
      const catalog = new RawCaptureCatalog(directory);
      await catalog.refresh();
      const source = new RawCaptureReplaySource(catalog);

      const page = await source.page({
        symbol: "BTCUSDT",
        from: BASE,
        to: BASE + 1_000,
        startAt: BASE + 260,
        limit: 10,
        includePreRoll: true,
      });

      // Snapshot@+100 and delta@+200 anchor the book; trade@+250 never
      // pre-rolls; delta@+300 is the first live frame after the watermark.
      expect(page.frames.map((frame) => [frame.data.stream, frame.preroll === true])).toEqual([
        ["snapshot", true],
        ["depth", true],
        ["depth", false],
      ]);
      expect(page.hasMore).toBe(false);

      // Without the flag the behavior is unchanged (audit-style paging).
      const plain = await source.page({
        symbol: "BTCUSDT",
        from: BASE,
        to: BASE + 1_000,
        startAt: BASE + 260,
        limit: 10,
      });
      expect(plain.frames.map((frame) => frame.preroll)).toEqual([undefined]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("delivers a full-book first page after seeking a durable session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-preroll-session-"));
    let runtime: RawReplayRuntime | null = null;
    try {
      await writeCapture(directory);
      runtime = await RawReplayRuntime.open({
        captureDirectory: directory,
        sessionRepositoryPath: join(directory, "sessions.json"),
        tickSize: 0.1,
      });

      const created = await runtime.manager.create(
        { symbol: "BTCUSDT", from: BASE + 50, to: BASE + 900, autoplay: true },
      );
      await runtime.manager.seek(created.id, BASE + 260, BASE + 10);

      // First read: playhead barely advanced past the watermark, so the page
      // carries only the pre-roll book state and reports more to come.
      const first = await runtime.manager.read(created.id, {
        now: BASE + 15,
        limit: 10,
        preRoll: true,
      });
      expect(first.frames.map((frame) => [frame.data.stream, frame.preroll === true])).toEqual([
        ["snapshot", true],
        ["depth", true],
      ]);
      expect(first.hasMore).toBe(true);
      expect(first.checkpoint.deliveredFrames).toBe(2);
      expect(first.checkpoint.cursor).not.toBeNull();

      // Later reads continue from the cursor without repeating the pre-roll.
      // The pre-seek trade stays excluded by design: `startAt` is a hard
      // watermark and only book state is re-anchored, never point events.
      const second = await runtime.manager.read(created.id, {
        now: BASE + 400,
        limit: 10,
        preRoll: true,
      });
      expect(second.frames.map((frame) => [frame.data.stream, frame.preroll === true])).toEqual([
        ["depth", false],
      ]);
      expect(second.checkpoint.deliveredFrames).toBe(3);
    } finally {
      runtime?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
