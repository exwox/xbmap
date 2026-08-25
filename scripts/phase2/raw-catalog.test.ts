import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RawCaptureCatalog,
  verifyCaptureSegment,
} from "../../server/replay/rawCaptureCatalog.js";
import { projectRawCapture } from "../../server/replay/rawProjection.js";
import { RawCaptureReplaySource } from "../../server/replay/replaySource.js";
import type { RawCaptureEnvelope } from "../../server/recording/rawCapture.js";
import { createSyntheticRawHour } from "./raw-fixture.js";
import { SYNTHETIC_CAPTURE_ID, SYNTHETIC_SYMBOL } from "./synthetic.js";

describe("Phase 2 immutable raw-capture catalog", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "liquidmap-phase2-catalog-"));
    await createSyntheticRawHour(directory);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("rediscovers the same complete capture and checksums after a catalog restart", async () => {
    const firstCatalog = new RawCaptureCatalog(directory);
    const first = await firstCatalog.refresh();
    const secondCatalog = new RawCaptureCatalog(directory);
    const second = await secondCatalog.refresh();

    expect(first.problems).toEqual([]);
    expect(second.problems).toEqual([]);
    expect(first.checksum).toBe(second.checksum);
    expect(first.segments).toHaveLength(1);
    expect(secondCatalog.get(SYNTHETIC_CAPTURE_ID)).toMatchObject({
      captureId: SYNTHETIC_CAPTURE_ID,
      symbol: SYNTHETIC_SYMBOL,
      complete: true,
      recordCount: 7_201,
    });

    const segment = secondCatalog.get(SYNTHETIC_CAPTURE_ID)!;
    await expect(verifyCaptureSegment(segment)).resolves.toMatchObject({
      captureId: SYNTHETIC_CAPTURE_ID,
      records: 7_201,
      firstSequence: 1,
      lastSequence: 7_201,
    });
  });

  it("returns byte-identical replay ordering on repeated reads", async () => {
    const catalog = new RawCaptureCatalog(directory);
    await catalog.refresh();

    const first = await digestReplay(catalog);
    const second = await digestReplay(catalog);
    expect(first).toEqual(second);
    expect(first.records).toBe(7_201);
  });

  it("produces the same production OrderBook state and replay checksum twice", async () => {
    const catalog = new RawCaptureCatalog(directory);
    await catalog.refresh();

    const replay = async () => projectRawCapture(
      catalog.read({}, { verifyChecksums: true }),
      { symbol: SYNTHETIC_SYMBOL, tickSize: 0.1 },
    );
    const first = await replay();
    const second = await replay();

    expect(first.replayChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(first.replayChecksum).toBe(second.replayChecksum);
    expect(first.checkpoint).toEqual(second.checkpoint);
    expect(first.levels).toEqual(second.levels);
    expect(first).toMatchObject({
      records: 7_201,
      snapshots: 1,
      depthApplied: 3_600,
      trades: 3_600,
    });
  });

  it("rejects a raw replay that exceeds its record budget", async () => {
    const catalog = new RawCaptureCatalog(directory);
    await catalog.refresh();
    await expect(collect(catalog.read({}, { maxRecords: 10 }))).rejects.toThrow(
      /record query limit|record limit/i,
    );
  });

  it("opens the synthetic one-hour replay and returns its first page in under three seconds", async () => {
    const catalog = new RawCaptureCatalog(directory);
    const source = new RawCaptureReplaySource(catalog, { maxPageSize: 1_000 });
    const started = performance.now();
    const fingerprint = await source.fingerprint({
      symbol: SYNTHETIC_SYMBOL,
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
    });
    const firstPage = await source.page({
      symbol: SYNTHETIC_SYMBOL,
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
      limit: 512,
    });
    const startupMs = performance.now() - started;

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(firstPage.frames).toHaveLength(512);
    expect(firstPage.hasMore).toBe(true);
    expect(startupMs).toBeLessThan(3_000);
  });
});

async function digestReplay(
  catalog: RawCaptureCatalog,
): Promise<{ records: number; checksum: string }> {
  const hash = createHash("sha256");
  let records = 0;
  for await (const envelope of catalog.read({}, { verifyChecksums: true })) {
    records += 1;
    hash.update(JSON.stringify(envelope));
    hash.update("\n");
  }
  return { records, checksum: hash.digest("hex") };
}

async function collect(
  records: AsyncIterable<RawCaptureEnvelope>,
): Promise<RawCaptureEnvelope[]> {
  const result: RawCaptureEnvelope[] = [];
  for await (const record of records) result.push(record);
  return result;
}
