import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  MAX_RAW_CAPTURE_DURATION_MS,
  MAX_RAW_CAPTURE_RETENTION_MS,
  RawCaptureRecorder,
  rawCaptureOptionsFromEnvironment,
  type RawCaptureManifest,
} from "../recording/rawCapture.js";

describe("RawCaptureRecorder", () => {
  it("writes gzip NDJSON, checksum metadata, and flushes on close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-capture-test-"));
    try {
      let clock = 1_700_000_000_000;
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "test",
        now: () => clock,
      });
      expect(recorder.record(record(clock, "depth", '{"e":"depthUpdate"}'))).toBe(true);
      clock += 1;
      expect(recorder.record(record(clock, "trade", '{"e":"aggTrade"}'))).toBe(true);

      const stats = await recorder.close();
      expect(stats).toMatchObject({
        acceptedRecords: 2,
        writtenRecords: 2,
        droppedRecords: 0,
        failed: false,
      });
      const uncompressed = await gunzipText(stats.dataPath);
      const lines = uncompressed.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        captureSequence: 1,
        stream: "depth",
      });
      expect(JSON.parse(lines[1]!)).toMatchObject({
        captureSequence: 2,
        stream: "trade",
      });
      const manifest = JSON.parse(
        await readFile(stats.manifestPath, "utf8"),
      ) as RawCaptureManifest;
      expect(manifest).toMatchObject({
        complete: true,
        eventSchemaVersion: 1,
        adapterVersion: "binance-usdm-adapter-v1",
        analyticsVersion: "liquidmap-analytics-v1",
        endpoints: {
          snapshot: "/fapi/v1/depth?symbol=BTCUSDT",
          depth: "btcusdt@depth@100ms",
          trade: "btcusdt@aggTrade",
        },
        closeReason: "manual",
      });
      expect(manifest.sequence).toEqual({
        field: "captureSequence",
        first: 1,
        lastWritten: 2,
        contiguous: true,
      });
      const compressed = await readFile(stats.dataPath);
      expect(manifest.dataBytes).toBe(compressed.byteLength);
      expect(manifest.sha256).toBe(sha256(compressed));
      expect(manifest.checksum).toEqual({
        algorithm: "sha256",
        scope: "compressed-file",
        value: sha256(compressed),
      });
      expect(manifest.contentChecksum).toEqual({
        algorithm: "sha256",
        scope: "uncompressed-ndjson",
        value: sha256(uncompressed),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects overflow instead of growing the in-memory queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-capture-test-"));
    try {
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "bounded",
        queueCapacity: 1,
        queueByteCapacity: 1_024,
      });
      expect(recorder.record(record(Date.now(), "depth", "first"))).toBe(true);
      expect(recorder.record(record(Date.now(), "depth", "second"))).toBe(false);
      const stats = await recorder.close();
      expect(stats.queueOverflows).toBe(1);
      expect(stats.droppedRecords).toBe(1);
      expect(stats.writtenRecords).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drains a busy queue in order when close races the scheduled flush", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-capture-test-"));
    try {
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "flush-race",
        queueCapacity: 2_000,
        queueByteCapacity: 2 * 1024 * 1024,
      });
      for (let index = 0; index < 1_000; index += 1) {
        expect(recorder.record(record(index, "depth", `payload-${index}`))).toBe(true);
      }

      const stats = await recorder.close();
      expect(stats).toMatchObject({
        acceptedRecords: 1_000,
        writtenRecords: 1_000,
        droppedRecords: 0,
        queuedRecords: 0,
        queuedBytes: 0,
        failed: false,
      });
      const lines = (await gunzipText(stats.dataPath)).trim().split("\n");
      expect(lines).toHaveLength(1_000);
      expect(lines.map((line) => JSON.parse(line).captureSequence)).toEqual(
        Array.from({ length: 1_000 }, (_, index) => index + 1),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps queue byte/record accounting bounded for oversized input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-capture-test-"));
    try {
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "byte-bounded",
        queueCapacity: 2,
        queueByteCapacity: 512,
      });
      expect(recorder.record(record(Date.now(), "depth", "a".repeat(2_000)))).toBe(false);
      expect(recorder.stats).toMatchObject({
        acceptedRecords: 0,
        queuedRecords: 0,
        queuedBytes: 0,
        queueOverflows: 1,
        droppedRecords: 1,
      });
      await recorder.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("caps capture duration and retention at 24 hours", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-capture-test-"));
    try {
      let clock = 1_700_000_000_000;
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "duration-cap",
        maxDurationMs: 48 * 60 * 60 * 1_000,
        retentionMs: 72 * 60 * 60 * 1_000,
        now: () => clock,
      });
      expect(recorder.stats).toMatchObject({
        maxDurationMs: MAX_RAW_CAPTURE_DURATION_MS,
        retentionMs: MAX_RAW_CAPTURE_RETENTION_MS,
      });

      clock += MAX_RAW_CAPTURE_DURATION_MS;
      expect(recorder.record(record(clock, "depth", "expired"))).toBe(false);
      const stats = await recorder.close();
      expect(stats).toMatchObject({
        captureLimitReached: true,
        expired: true,
        droppedRecords: 1,
      });
      const manifest = JSON.parse(
        await readFile(stats.manifestPath, "utf8"),
      ) as RawCaptureManifest;
      expect(manifest.maxDurationMs).toBe(MAX_RAW_CAPTURE_DURATION_MS);
      expect(manifest.retentionMs).toBe(MAX_RAW_CAPTURE_RETENTION_MS);
      expect(manifest.complete).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps paths inside the configured directory and creates private files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-capture-test-"));
    try {
      await chmod(directory, 0o755);
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "../../btc/usdt with a deliberately long suffix".repeat(4),
        id: "../../manifest-target",
      });
      expect(dirname(recorder.stats.dataPath)).toBe(resolve(directory));
      expect(dirname(recorder.stats.manifestPath)).toBe(resolve(directory));
      expect(basename(recorder.stats.dataPath)).not.toContain("/");
      expect(basename(recorder.stats.manifestPath)).not.toContain("/");
      expect(recorder.record({
        ...record(Date.now(), "depth", "safe"),
        symbol: "../../btc/usdt with a deliberately long suffix".repeat(4),
      })).toBe(true);

      const stats = await recorder.close();
      expect((await stat(stats.dataPath)).mode & 0o777).toBe(0o600);
      expect((await stat(stats.manifestPath)).mode & 0o777).toBe(0o600);
      // An existing configured directory must never be chmod'ed as a side effect.
      expect((await stat(directory)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing data path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-capture-test-"));
    try {
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "collision",
        now: () => 1_700_000_000_000,
      });
      await writeFile(recorder.stats.dataPath, "sentinel", { mode: 0o600 });
      expect(recorder.record(record(1_700_000_000_000, "depth", "payload"))).toBe(true);

      await expect(recorder.close()).rejects.toThrow();
      expect(await readFile(recorder.stats.dataPath, "utf8")).toBe("sentinel");
      expect(recorder.stats).toMatchObject({ failed: true, writtenRecords: 0 });
      await expect(access(recorder.stats.manifestPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a symlink as the configured capture directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "liquidmap-capture-test-"));
    try {
      const target = join(parent, "target");
      const alias = join(parent, "alias");
      await mkdir(target, { mode: 0o755 });
      await symlink(target, alias, "dir");
      const recorder = new RawCaptureRecorder({
        directory: alias,
        symbol: "BTCUSDT",
        id: "symlink",
      });

      await expect(recorder.close()).rejects.toThrow(/real directory|could not be created/);
      expect(await readdir(target)).toEqual([]);
      expect((await stat(target)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("publishes the manifest atomically without replacing an existing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-capture-test-"));
    try {
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "manifest-collision",
        now: () => 1_700_000_000_000,
      });
      await writeFile(recorder.stats.manifestPath, "sentinel", { mode: 0o600 });
      expect(recorder.record(record(1_700_000_000_000, "depth", "payload"))).toBe(true);

      await expect(recorder.close()).rejects.toThrow();
      expect(await readFile(recorder.stats.manifestPath, "utf8")).toBe("sentinel");
      expect(recorder.stats.failed).toBe(true);
      expect((await readdir(directory)).some((name) => name.includes(".tmp-"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not mutate finalized stats when record is called after close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-capture-test-"));
    try {
      let clock = 1_700_000_000_000;
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "closed",
        now: () => clock,
      });
      expect(recorder.record(record(clock, "trade", "payload"))).toBe(true);
      const firstClose = recorder.close();
      expect(recorder.close()).toBe(firstClose);
      await firstClose;
      const finalized = recorder.stats;

      clock += MAX_RAW_CAPTURE_DURATION_MS * 2;
      expect(recorder.record(record(clock, "trade", "late"))).toBe(false);
      expect(recorder.stats).toEqual(finalized);
      expect(await recorder.close()).toEqual(finalized);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("purges capture artifacts at the capped retention boundary only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-capture-test-"));
    try {
      const now = Date.now();
      const expiredData = join(directory, "liquidmap-market-old.ndjson.gz");
      const expiredManifest = join(directory, "liquidmap-market-old.manifest.json");
      const unrelated = join(directory, "do-not-delete.txt");
      await Promise.all([
        writeFile(expiredData, "old"),
        writeFile(expiredManifest, "old"),
        writeFile(unrelated, "keep"),
      ]);
      const boundary = new Date(now - MAX_RAW_CAPTURE_RETENTION_MS);
      await Promise.all([
        utimes(expiredData, boundary, boundary),
        utimes(expiredManifest, boundary, boundary),
        utimes(unrelated, boundary, boundary),
      ]);
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "retention",
        retentionMs: 48 * 60 * 60 * 1_000,
        now: () => now,
      });
      await recorder.close();

      await expect(access(expiredData)).rejects.toThrow();
      await expect(access(expiredManifest)).rejects.toThrow();
      expect(await readFile(unrelated, "utf8")).toBe("keep");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("is disabled unless an explicit capture directory is configured", () => {
    expect(rawCaptureOptionsFromEnvironment("BTCUSDT", {})).toBeNull();
    expect(rawCaptureOptionsFromEnvironment("BTCUSDT", {
      XBMAP_CAPTURE_DIR: "/tmp/liquidmap-explicit",
      XBMAP_CAPTURE_RETENTION_MS: String(48 * 60 * 60 * 1_000),
    })).toMatchObject({
      directory: "/tmp/liquidmap-explicit",
      symbol: "BTCUSDT",
      retentionMs: 48 * 60 * 60 * 1_000,
    });
  });
});

function record(
  capturedAt: number,
  stream: "depth" | "trade",
  payload: string,
) {
  return {
    capturedAt,
    exchange: "binance" as const,
    symbol: "BTCUSDT",
    source: "binance" as const,
    stream,
    connectionId: "test-connection",
    payload,
  };
}

async function gunzipText(path: string): Promise<string> {
  let output = "";
  await pipeline(
    createReadStream(path),
    createGunzip(),
    new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
  );
  return output;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
