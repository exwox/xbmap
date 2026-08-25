import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RawCaptureRecorder,
  type RawCaptureEnvelope,
  type RawCaptureRecord,
} from "../recording/rawCapture.js";
import {
  RawReplayRuntime,
  RawReplayValidationError,
} from "../replayRuntime.js";
import { FileReplaySessionRepository } from "./fileSessionRepository.js";
import { RawCaptureCatalog, verifyCaptureSegment } from "./rawCaptureCatalog.js";
import { projectRawCapture } from "./rawProjection.js";
import type {
  ReplayFrameSource,
  ReplayRange,
  ReplaySourceFrame,
  ReplaySourcePage,
  ReplaySourceQuery,
} from "./replaySource.js";
import { ReplaySessionManager } from "./sessionManager.js";

describe("persistent raw replay", () => {
  it("catalogs, authenticates, and projects a buffered capture deterministically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-replay-catalog-"));
    try {
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "catalog-test",
        now: () => 1_700_000_000_100,
      });
      // A live depth delta can reach the recorder before its REST snapshot.
      expect(recorder.record(raw("depth", DEPTH, 1_700_000_000_010))).toBe(true);
      expect(recorder.record(raw("snapshot", SNAPSHOT, 1_700_000_000_020))).toBe(true);
      expect(recorder.record(raw("trade", TRADE, 1_700_000_000_030))).toBe(true);
      await recorder.close();

      const catalog = new RawCaptureCatalog(directory);
      const snapshot = await catalog.refresh();
      expect(snapshot.problems).toEqual([]);
      expect(snapshot.segments).toHaveLength(1);
      expect(snapshot.checksum).toMatch(/^[a-f0-9]{64}$/);
      await expect(verifyCaptureSegment(snapshot.segments[0]!)).resolves.toMatchObject({
        records: 3,
        firstSequence: 1,
        lastSequence: 3,
      });

      const first = await projectRawCapture(catalog.read({ symbol: "BTCUSDT" }), {
        symbol: "BTCUSDT",
        tickSize: 0.1,
      });
      const second = await projectRawCapture(catalog.read({ symbol: "BTCUSDT" }), {
        symbol: "BTCUSDT",
        tickSize: 0.1,
      });
      expect(second).toEqual(first);
      expect(first).toMatchObject({
        records: 3,
        snapshots: 1,
        depthApplied: 1,
        trades: 1,
        buyVolume: 0.4,
        sellVolume: 0,
        checkpoint: { lastUpdateId: 101, bestBid: 100, bestAsk: 100.1 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects capture bytes changed after catalog refresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-replay-corrupt-"));
    try {
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "corrupt-test",
      });
      recorder.record(raw("snapshot", SNAPSHOT, Date.now()));
      await recorder.close();
      const catalog = new RawCaptureCatalog(directory);
      const segment = (await catalog.refresh()).segments[0]!;
      await appendFile(segment.dataPath, Buffer.from([0x00]));
      await expect(verifyCaptureSegment(segment)).rejects.toThrow(/byte length mismatch|checksum mismatch/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pins supported producer metadata into the catalog fingerprint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-replay-version-"));
    try {
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "version-test",
      });
      recorder.record(raw("snapshot", SNAPSHOT, Date.now()));
      await recorder.close();

      const catalog = new RawCaptureCatalog(directory);
      const first = await catalog.refresh();
      expect(first).toMatchObject({ problems: [], segments: [{ captureId: "version-test" }] });
      const manifestPath = first.segments[0]!.manifestPath;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.endpoints.depth = "btcusdt@depth@250ms";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const metadataChanged = await catalog.refresh();
      expect(metadataChanged.problems).toEqual([]);
      expect(metadataChanged.checksum).not.toBe(first.checksum);

      manifest.adapterVersion = "unsupported-adapter-v2";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const unsupported = await catalog.refresh();
      expect(unsupported.segments).toEqual([]);
      expect(unsupported.problems).toHaveLength(1);
      expect(unsupported.problems[0]!.message).toMatch(/integrity validation/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the catalog fingerprint stable when an identical capture is stored elsewhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "liquidmap-replay-portable-"));
    try {
      const capturedAt = 1_700_000_000_100;
      const checksums: string[] = [];
      const dataChecksums: string[] = [];
      for (const name of ["source", "restored"]) {
        const directory = join(root, name);
        const recorder = new RawCaptureRecorder({
          directory,
          symbol: "BTCUSDT",
          id: "portable-test",
          now: () => capturedAt,
        });
        recorder.record(raw("snapshot", SNAPSHOT, capturedAt));
        await recorder.close();
        const snapshot = await new RawCaptureCatalog(directory).refresh();
        expect(snapshot.problems).toEqual([]);
        checksums.push(snapshot.checksum);
        dataChecksums.push(snapshot.segments[0]!.dataSha256);
      }
      expect(new Set(dataChecksums).size).toBe(1);
      expect(new Set(checksums).size).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ReplaySessionManager", () => {
  it("supports pause, seek, speed changes, and batch-invariant checkpoints", async () => {
    const source = new FakeSource();
    let clock = 10_000;
    const manager = new ReplaySessionManager(source, { now: () => clock });
    const created = await manager.create({
      symbol: "BTCUSDT",
      from: 1_000,
      to: 2_000,
      autoplay: true,
    });

    clock = 10_500;
    const first = await manager.read(created.id, { limit: 1 });
    const second = await manager.read(created.id, { limit: 10 });
    expect([...first.frames, ...second.frames].map((frame) => frame.data)).toEqual(["a", "b"]);
    const paused = await manager.pause(created.id);
    expect(paused).toMatchObject({ status: "paused", playheadAt: 1_500 });
    clock = 19_000;
    expect((await manager.read(created.id)).frames).toEqual([]);

    const seeked = await manager.seek(created.id, 1_500);
    expect(seeked.checkpoint).toMatchObject({ cursor: null, deliveredFrames: 0, seekTimestamp: 1_500 });
    await manager.setSpeed(created.id, 2);
    await manager.resume(created.id, 20_000);
    const completed = await manager.read(created.id, { now: 20_250 });
    expect(completed.frames.map((frame) => frame.data)).toEqual(["b", "c"]);
    expect(completed.session.status).toBe("completed");

    const oneBatch = new ReplaySessionManager(source, { now: () => 30_000 });
    const reference = await oneBatch.create({
      symbol: "BTCUSDT", from: 1_000, to: 2_000, autoplay: true,
    });
    await oneBatch.seek(reference.id, 1_500, 30_000);
    const all = await oneBatch.read(reference.id, { now: 31_000, limit: 10 });
    expect(all.checkpoint.rollingChecksum).toBe(completed.checkpoint.rollingChecksum);
  });

  it("persists a checkpoint and restores a playing session as paused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-replay-session-"));
    try {
      const path = join(directory, "sessions.json");
      const source = new FakeSource();
      let clock = 40_000;
      const firstManager = new ReplaySessionManager(source, {
        now: () => clock,
        repository: new FileReplaySessionRepository(path),
      });
      const created = await firstManager.create({
        symbol: "BTCUSDT", from: 1_000, to: 2_000, autoplay: true,
      });
      clock = 40_500;
      const beforeRestart = await firstManager.read(created.id);
      expect(beforeRestart.checkpoint.deliveredFrames).toBe(2);

      const secondManager = new ReplaySessionManager(source, {
        now: () => clock,
        repository: new FileReplaySessionRepository(path),
      });
      await expect(secondManager.restore()).resolves.toEqual({ restored: 1, discarded: 0 });
      const restored = await secondManager.get(created.id);
      expect(restored).toMatchObject({
        status: "paused",
        playheadAt: 1_500,
        checkpoint: {
          cursor: "0002",
          deliveredFrames: 2,
          rollingChecksum: beforeRestart.checkpoint.rollingChecksum,
        },
      });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("RawReplayRuntime", () => {
  it("classifies an authenticated but empty capture as not replayable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-replay-empty-"));
    let runtime: RawReplayRuntime | null = null;
    try {
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "empty-test",
      });
      await recorder.close();
      runtime = await RawReplayRuntime.open({
        captureDirectory: directory,
        sessionRepositoryPath: join(directory, "sessions.json"),
        tickSize: 0.1,
      });
      await expect(runtime.verify("empty-test")).rejects.toBeInstanceOf(
        RawReplayValidationError,
      );
    } finally {
      runtime?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class FakeSource implements ReplayFrameSource<string> {
  private readonly frames: ReplaySourceFrame<string>[] = [
    frame("0001", 1_000, "a"),
    frame("0002", 1_500, "b"),
    frame("0003", 2_000, "c"),
  ];

  async fingerprint(_range: ReplayRange): Promise<string> {
    return "a".repeat(64);
  }

  async page(query: ReplaySourceQuery): Promise<ReplaySourcePage<string>> {
    const cursor = query.after
      ? this.frames.findIndex((candidate) => candidate.sequence === query.after) + 1
      : 0;
    const startAt = query.startAt ?? query.from;
    const through = query.through ?? query.to;
    const eligible = this.frames
      .slice(cursor)
      .filter((candidate) => candidate.timestamp >= startAt && candidate.timestamp <= through);
    return {
      frames: eligible.slice(0, query.limit),
      hasMore: eligible.length > query.limit || through < query.to,
      sourceChecksum: "a".repeat(64),
    };
  }
}

function frame(sequence: string, timestamp: number, data: string): ReplaySourceFrame<string> {
  return { sequence, timestamp, data, checksum: sequence.repeat(16) };
}

function raw(
  stream: RawCaptureRecord["stream"],
  payload: string,
  capturedAt: number,
): RawCaptureRecord {
  return {
    capturedAt,
    exchange: "binance",
    symbol: "BTCUSDT",
    source: "binance",
    stream,
    connectionId: "binance-1",
    payload,
  };
}

const SNAPSHOT = JSON.stringify({
  lastUpdateId: 100,
  bids: [["100.0", "1"]],
  asks: [["100.1", "1"]],
});

const DEPTH = JSON.stringify({
  e: "depthUpdate",
  E: 1_700_000_000_010,
  T: 1_700_000_000_009,
  s: "BTCUSDT",
  U: 101,
  u: 101,
  pu: 100,
  b: [["100.0", "2"]],
  a: [],
});

const TRADE = JSON.stringify({
  e: "aggTrade",
  E: 1_700_000_000_030,
  T: 1_700_000_000_029,
  s: "BTCUSDT",
  a: 42,
  p: "100.1",
  q: "0.4",
  m: false,
});
