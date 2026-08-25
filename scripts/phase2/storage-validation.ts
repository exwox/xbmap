import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BatchedHistoryWriter } from "../../server/storage/batchedWriter.js";
import { FileHistoryStore } from "../../server/storage/fileHistoryStore.js";
import {
  HistoryQueryLimitError,
  type HistoricalRecord,
  type HistoryRetentionPolicy,
} from "../../server/storage/types.js";
import { assertion, assertionAtLeast, measureCase } from "./case-utils.js";
import {
  SYNTHETIC_HOUR_START,
  SYNTHETIC_SYMBOL,
  syntheticHourRecords,
  syntheticTradeRecord,
} from "./synthetic.js";
import type { Phase2ValidationCase } from "./types.js";

const GENEROUS_LIMITS = {
  defaultRows: 20_000,
  maxRows: 20_000,
  maxRangeMs: 2 * 60 * 60_000,
};
const execFileAsync = promisify(execFile);
const RESTART_PROBE_PATH = fileURLToPath(new URL("./restart-probe.ts", import.meta.url));

export async function validatePersistenceAfterRestart(): Promise<Phase2ValidationCase> {
  return measureCase("history-persists-after-restart", async () => withTemporaryRoot(
    "liquidmap-phase2-restart-",
    async (root) => {
      const directory = join(root, "history");
      const expected = syntheticHourRecords().slice(0, 600);
      const firstProcess = new FileHistoryStore({ directory, limits: GENEROUS_LIMITS });
      await firstProcess.open();
      await appendChunks(firstProcess, expected, 250);
      const beforeRestart = await queryFixture(firstProcess);

      const beforeDigest = digestRecords(beforeRestart.records);
      const afterRestart = await queryFromFreshProcess(directory);

      return {
        assertions: [
          assertion("probe runs in a distinct OS process", afterRestart.processId === process.pid, false),
          assertion("record count survives process restart", afterRestart.records, expected.length),
          assertion("ordered history digest survives process restart", afterRestart.digest, beforeDigest),
          assertion("restart query is complete", afterRestart.truncated, false),
        ],
        observations: {
          parentProcessId: process.pid,
          restartProcessId: afterRestart.processId,
          records: afterRestart.records,
          segments: afterRestart.scannedSegments,
          compressedBytes: afterRestart.scannedCompressedBytes,
          digest: afterRestart.digest,
        },
        notes: ["The verification query is executed by a separately spawned Node.js process over the durable directory."],
      };
    },
  ));
}

export async function validateBoundedQueries(): Promise<Phase2ValidationCase> {
  return measureCase("bounded-history-query", async () => withTemporaryRoot(
    "liquidmap-phase2-query-",
    async (root) => {
      const store = new FileHistoryStore({
        directory: join(root, "history"),
        limits: { defaultRows: 20, maxRows: 50, maxRangeMs: 60_000 },
      });
      await store.open();
      await appendChunks(store, syntheticHourRecords().slice(0, 100), 34);

      const rangeCode = await queryLimitCode(() => store.query({
        exchange: "binance",
        symbol: SYNTHETIC_SYMBOL,
        from: SYNTHETIC_HOUR_START,
        to: SYNTHETIC_HOUR_START + 60_001,
      }));
      const rowCode = await queryLimitCode(() => store.query({
        exchange: "binance",
        symbol: SYNTHETIC_SYMBOL,
        from: SYNTHETIC_HOUR_START,
        to: SYNTHETIC_HOUR_START + 60_000,
        limit: 51,
      }));
      const bounded = await store.query({
        exchange: "binance",
        symbol: SYNTHETIC_SYMBOL,
        from: SYNTHETIC_HOUR_START,
        to: SYNTHETIC_HOUR_START + 60_000,
        limit: 10,
      });
      const segmentLimitedStore = new FileHistoryStore({
        directory: join(root, "history"),
        limits: {
          defaultRows: 20,
          maxRows: 50,
          maxRangeMs: 60_000,
          maxScannedSegments: 2,
          maxScannedCompressedBytes: 256 * 1024 * 1024,
        },
      });
      const segmentCode = await queryLimitCode(() => segmentLimitedStore.query({
        exchange: "binance",
        symbol: SYNTHETIC_SYMBOL,
        from: SYNTHETIC_HOUR_START,
        to: SYNTHETIC_HOUR_START + 60_000,
      }));
      const byteLimitedStore = new FileHistoryStore({
        directory: join(root, "history"),
        limits: {
          defaultRows: 20,
          maxRows: 50,
          maxRangeMs: 60_000,
          maxScannedSegments: 10,
          maxScannedCompressedBytes: 1,
        },
      });
      const byteCode = await queryLimitCode(() => byteLimitedStore.query({
        exchange: "binance",
        symbol: SYNTHETIC_SYMBOL,
        from: SYNTHETIC_HOUR_START,
        to: SYNTHETIC_HOUR_START + 60_000,
      }));

      return {
        assertions: [
          assertion("oversized time range is rejected", rangeCode, "RANGE_LIMIT"),
          assertion("oversized row request is rejected", rowCode, "ROW_LIMIT"),
          assertion("oversized segment scan is rejected", segmentCode, "SEGMENT_LIMIT"),
          assertion("oversized compressed-byte scan is rejected", byteCode, "BYTE_LIMIT"),
          assertion("bounded result obeys row limit", bounded.records.length, 10),
          assertion("bounded result advertises truncation", bounded.truncated, true),
          assertion("bounded result supplies pagination cursor", bounded.nextCursor !== null, true),
        ],
        observations: {
          maxRangeMs: 60_000,
          maxRows: 50,
          storedSegments: 3,
          returnedRows: bounded.records.length,
        },
        notes: [],
      };
    },
  ));
}

export async function validateBackupRestore(): Promise<Phase2ValidationCase> {
  return measureCase("history-backup-restore", async () => withTemporaryRoot(
    "liquidmap-phase2-backup-",
    async (root) => {
      const expected = syntheticHourRecords().slice(0, 750);
      const source = new FileHistoryStore({
        directory: join(root, "source"),
        limits: GENEROUS_LIMITS,
      });
      await source.open();
      await appendChunks(source, expected, 250);
      const original = await queryFixture(source);
      const backup = await source.createBackup(join(root, "backup"));

      const restored = new FileHistoryStore({
        directory: join(root, "restored"),
        limits: GENEROUS_LIMITS,
      });
      await restored.open();
      await restored.restoreBackup(backup.destination);
      const recovered = await queryFixture(restored);
      const originalDigest = digestRecords(original.records);
      const recoveredDigest = digestRecords(recovered.records);

      return {
        assertions: [
          assertion("backup records every source row", backup.recordCount, expected.length),
          assertion("restore recovers every source row", recovered.records.length, expected.length),
          assertion("restore preserves ordered history digest", recoveredDigest, originalDigest),
          assertion("backup manifest is checksummed", /^[a-f0-9]{64}$/.test(backup.manifestSha256), true),
        ],
        observations: {
          records: recovered.records.length,
          segments: backup.segmentCount,
          compressedBytes: backup.byteCount,
          digest: recoveredDigest,
        },
        notes: ["Restore uses a separate empty store and verifies every compressed segment checksum."],
      };
    },
  ));
}

export async function validateRetentionDuringIngestion(): Promise<Phase2ValidationCase> {
  return measureCase("retention-concurrent-with-ingestion", async () => withTemporaryRoot(
    "liquidmap-phase2-retention-",
    async (root) => {
      const store = new FileHistoryStore({ directory: join(root, "history") });
      await store.open();
      const oldRecords = Array.from({ length: 500 }, (_, index) =>
        syntheticTradeRecord(index + 1, SYNTHETIC_HOUR_START + index, "expired-capture"));
      const retentionNow = SYNTHETIC_HOUR_START + 10_000;
      const liveRecords = Array.from({ length: 500 }, (_, index) =>
        syntheticTradeRecord(index + 1, retentionNow + index, "live-capture"));
      await store.appendBatch(oldRecords);

      const policy: HistoryRetentionPolicy = {
        tradeMs: 5_000,
        depthSnapshotMs: 5_000,
        depthDeltaMs: 5_000,
        metricFrameMs: { 1_000: 5_000, 5_000: 5_000, 60_000: 5_000 },
      };
      const writer = new BatchedHistoryWriter(store, {
        batchRecords: 100,
        flushIntervalMs: 1_000,
        queueRecords: 1_000,
        queueBytes: 4 * 1024 * 1024,
      });
      const accepted = writer.enqueueMany(liveRecords);
      const appendStarted = performance.now();
      const [retention, appended] = await Promise.all([
        store.runRetention(policy, retentionNow),
        writer.flush().then(() => ({
          stats: writer.stats,
          durationMs: performance.now() - appendStarted,
        })),
      ]);
      await writer.close();
      const remaining = await store.query({
        exchange: "binance",
        symbol: SYNTHETIC_SYMBOL,
        from: SYNTHETIC_HOUR_START,
        to: retentionNow + 1_000,
        limit: 2_000,
      });
      const onlyLive = remaining.records.every((record) => record.captureId === "live-capture");
      const ingestionRecordsPerSecond = liveRecords.length / (appended.durationMs / 1_000);

      return {
        assertions: [
          assertion("retention removes all expired rows", retention.removedRecords, oldRecords.length),
          assertion("bounded writer accepts the live batch", accepted, liveRecords.length),
          assertion("concurrent live append commits fully", appended.stats.persistedRecords, liveRecords.length),
          assertion("live ingestion uses multiple storage batches", appended.stats.batches > 1, true),
          assertion("live rows remain queryable", remaining.records.length, liveRecords.length),
          assertion("retention does not remove concurrent live rows", onlyLive, true),
          assertion("concurrent ingestion has no queue overflow", appended.stats.queueOverflows, 0),
          assertionAtLeast(
            "concurrent persistence sustains the Phase 1 burst event rate",
            ingestionRecordsPerSecond,
            1_200,
          ),
        ],
        observations: {
          expiredRowsRemoved: retention.removedRecords,
          liveRowsCommitted: appended.stats.persistedRecords,
          ingestionBatches: appended.stats.batches,
          appendDurationMs: Math.round(appended.durationMs * 1_000) / 1_000,
          ingestionRecordsPerSecond: Math.round(ingestionRecordsPerSecond * 1_000) / 1_000,
        },
        notes: [
          "Retention and ingestion start in the same Promise.all; immutable segment leases protect each operation.",
          "This is a short synthetic concurrency qualification, not a production-duration latency/throughput proof.",
        ],
      };
    },
  ));
}

async function appendChunks(
  store: FileHistoryStore,
  records: readonly HistoricalRecord[],
  chunkSize: number,
): Promise<void> {
  for (let index = 0; index < records.length; index += chunkSize) {
    await store.appendBatch(records.slice(index, index + chunkSize));
  }
}

function queryFixture(store: FileHistoryStore) {
  return store.query({
    exchange: "binance",
    symbol: SYNTHETIC_SYMBOL,
    from: SYNTHETIC_HOUR_START,
    to: SYNTHETIC_HOUR_START + 60 * 60_000,
    limit: 20_000,
  });
}

function digestRecords(records: readonly HistoricalRecord[]): string {
  const hash = createHash("sha256");
  for (const record of records) hash.update(`${JSON.stringify(record)}\n`);
  return hash.digest("hex");
}

async function queryLimitCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "NOT_REJECTED";
  } catch (error) {
    return error instanceof HistoryQueryLimitError ? error.code : "WRONG_ERROR";
  }
}

interface RestartProbeResult {
  processId: number;
  records: number;
  truncated: boolean;
  scannedSegments: number;
  scannedCompressedBytes: number;
  digest: string;
}

async function queryFromFreshProcess(directory: string): Promise<RestartProbeResult> {
  const { stdout } = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    RESTART_PROBE_PATH,
    directory,
    String(SYNTHETIC_HOUR_START),
    String(SYNTHETIC_HOUR_START + 60 * 60_000),
    "20000",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const value = JSON.parse(stdout.trim()) as Partial<RestartProbeResult>;
  if (!Number.isSafeInteger(value.processId)
    || !Number.isSafeInteger(value.records)
    || typeof value.truncated !== "boolean"
    || !Number.isSafeInteger(value.scannedSegments)
    || !Number.isSafeInteger(value.scannedCompressedBytes)
    || typeof value.digest !== "string") {
    throw new Error("Fresh-process history probe returned a malformed result");
  }
  return value as RestartProbeResult;
}

async function withTemporaryRoot<T>(
  prefix: string,
  run: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
