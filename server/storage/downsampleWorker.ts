import { createHash } from "node:crypto";
import {
  downsampleMetricFrames,
  metricFrames,
} from "./downsample.js";
import type {
  HistoricalRecord,
  HistoryCursor,
  HistoryResolutionMs,
  HistoryStore,
  MaintenanceCheckpointStore,
  StoredMetricFrame,
} from "./types.js";

export interface DownsampleJob {
  exchange: "binance";
  symbol: string;
  captureId: string;
  sourceResolutionMs: HistoryResolutionMs;
  targetResolutionMs: Exclude<HistoryResolutionMs, 1_000>;
}

export interface DownsampleRunOptions {
  from: number;
  to: number;
  /** Leaves recent buckets untouched so late source frames can settle. */
  settleDelayMs?: number;
}

export interface DownsampleWorkerOptions {
  windowMs?: number;
  pageRows?: number;
  appendBatchRecords?: number;
}

export interface DownsampleRunResult {
  checkpointName: string;
  startedAt: number;
  completedThrough: number;
  sourceFrames: number;
  writtenFrames: number;
  existingFrames: number;
  incompleteBuckets: number;
}

type DownsampleStore = HistoryStore & MaintenanceCheckpointStore;

/**
 * Restart-safe and idempotent roll-up worker. Its high-water mark lives in the
 * store catalog and advances only after target frames are durable. A rerun also
 * queries target identities before append, covering a crash after append but
 * before checkpoint commit.
 */
export class DownsampleWorker {
  private readonly windowMs: number;
  private readonly pageRows: number;
  private readonly appendBatchRecords: number;

  constructor(
    private readonly store: DownsampleStore,
    options: DownsampleWorkerOptions = {},
  ) {
    this.windowMs = positiveInteger(options.windowMs, 60 * 60 * 1_000, "windowMs");
    this.pageRows = positiveInteger(options.pageRows, 10_000, "pageRows");
    this.appendBatchRecords = positiveInteger(
      options.appendBatchRecords,
      2_000,
      "appendBatchRecords",
    );
  }

  async run(job: DownsampleJob, options: DownsampleRunOptions): Promise<DownsampleRunResult> {
    validateJob(job);
    if (!Number.isSafeInteger(options.from) || options.from < 0
      || !Number.isSafeInteger(options.to) || options.to <= options.from) {
      throw new TypeError("Downsample run requires a valid [from, to) range");
    }
    const settleDelayMs = options.settleDelayMs ?? job.targetResolutionMs;
    if (!Number.isSafeInteger(settleDelayMs) || settleDelayMs < 0) {
      throw new TypeError("settleDelayMs must be a non-negative safe integer");
    }
    if (this.windowMs % job.targetResolutionMs !== 0) {
      throw new TypeError("windowMs must be a multiple of targetResolutionMs");
    }

    await this.store.open();
    const checkpointName = downsampleCheckpointName(job);
    const saved = await this.store.getMaintenanceCheckpoint(checkpointName);
    const alignedFrom = Math.ceil(options.from / job.targetResolutionMs) * job.targetResolutionMs;
    let cursor = Math.max(alignedFrom, saved ?? alignedFrom);
    const safeTo = Math.floor(
      (options.to - settleDelayMs) / job.targetResolutionMs,
    ) * job.targetResolutionMs;
    const startedAt = cursor;
    let sourceFrames = 0;
    let writtenFrames = 0;
    let existingFrames = 0;
    let incompleteBuckets = 0;

    while (cursor < safeTo) {
      const windowEnd = Math.min(cursor + this.windowMs, safeTo);
      const source = deduplicateSource(await this.fetchMetricFrames(
        job,
        cursor,
        windowEnd,
        job.sourceResolutionMs,
      ));
      sourceFrames += source.length;
      const expectedPerBucket = job.targetResolutionMs / job.sourceResolutionMs;
      const byBucket = groupByBucket(source, job.targetResolutionMs);
      let completeThrough = cursor;
      const completeSource: StoredMetricFrame[] = [];
      for (let bucket = cursor; bucket < windowEnd; bucket += job.targetResolutionMs) {
        const frames = byBucket.get(bucket) ?? [];
        if (!isCompleteBucket(frames, bucket, expectedPerBucket, job.sourceResolutionMs)) {
          incompleteBuckets += 1;
          break;
        }
        completeSource.push(...frames);
        completeThrough = bucket + job.targetResolutionMs;
      }
      if (completeThrough === cursor) break;

      const aggregates = downsampleMetricFrames(completeSource, job.targetResolutionMs);
      const existing = await this.fetchMetricFrames(
        job,
        cursor,
        completeThrough,
        job.targetResolutionMs,
      );
      const existingKeys = new Set(existing.map(targetIdentity));
      existingFrames += existing.length;
      const missing = aggregates.filter((record) => !existingKeys.has(targetIdentity(record)));
      for (let offset = 0; offset < missing.length; offset += this.appendBatchRecords) {
        const batch = missing.slice(offset, offset + this.appendBatchRecords);
        if (batch.length > 0) {
          await this.store.appendBatch(batch);
          writtenFrames += batch.length;
        }
      }
      // The target append is durable before this high-water mark is published.
      await this.store.setMaintenanceCheckpoint(checkpointName, completeThrough);
      cursor = completeThrough;
      if (completeThrough < windowEnd) break;
    }

    return {
      checkpointName,
      startedAt,
      completedThrough: cursor,
      sourceFrames,
      writtenFrames,
      existingFrames,
      incompleteBuckets,
    };
  }

  private async fetchMetricFrames(
    job: DownsampleJob,
    from: number,
    to: number,
    resolutionMs: HistoryResolutionMs,
  ): Promise<StoredMetricFrame[]> {
    const result: HistoricalRecord[] = [];
    let after: HistoryCursor | undefined;
    do {
      const page = await this.store.query({
        exchange: job.exchange,
        symbol: job.symbol,
        captureId: job.captureId,
        from,
        to,
        kinds: ["metric_frame"],
        resolutionMs,
        after,
        limit: this.pageRows,
      });
      result.push(...page.records);
      after = page.nextCursor ?? undefined;
      if (!page.truncated) break;
      if (!after) throw new Error("History query truncated without a continuation cursor");
    } while (true);
    return metricFrames(result);
  }
}

export function downsampleCheckpointName(job: DownsampleJob): string {
  const identity = JSON.stringify([
    job.exchange,
    job.symbol,
    job.captureId,
    job.sourceResolutionMs,
    job.targetResolutionMs,
  ]);
  return `downsample:${createHash("sha256").update(identity).digest("hex")}`;
}

function validateJob(job: DownsampleJob): void {
  if (job.exchange !== "binance" || !/^[A-Z0-9_.-]{1,48}$/.test(job.symbol)
    || !job.captureId || job.captureId.length > 128) {
    throw new TypeError("Invalid downsample job identity");
  }
  if (job.sourceResolutionMs >= job.targetResolutionMs
    || job.targetResolutionMs % job.sourceResolutionMs !== 0) {
    throw new TypeError("Target resolution must be a larger multiple of source resolution");
  }
}

function deduplicateSource(records: StoredMetricFrame[]): StoredMetricFrame[] {
  const byInterval = new Map<number, StoredMetricFrame>();
  for (const record of records) {
    const previous = byInterval.get(record.intervalStart);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
      throw new Error(`Conflicting source metric frame at ${record.intervalStart}`);
    }
    byInterval.set(record.intervalStart, record);
  }
  return [...byInterval.values()].sort((left, right) => left.intervalStart - right.intervalStart);
}

function groupByBucket(
  records: StoredMetricFrame[],
  targetResolutionMs: number,
): Map<number, StoredMetricFrame[]> {
  const result = new Map<number, StoredMetricFrame[]>();
  for (const record of records) {
    const bucket = Math.floor(record.intervalStart / targetResolutionMs) * targetResolutionMs;
    const group = result.get(bucket);
    if (group) group.push(record);
    else result.set(bucket, [record]);
  }
  return result;
}

function isCompleteBucket(
  records: StoredMetricFrame[],
  bucketStart: number,
  expectedCount: number,
  sourceResolutionMs: number,
): boolean {
  if (records.length !== expectedCount) return false;
  const starts = new Set(records.map((record) => record.intervalStart));
  for (let index = 0; index < expectedCount; index += 1) {
    if (!starts.has(bucketStart + index * sourceResolutionMs)) return false;
  }
  return true;
}

function targetIdentity(record: StoredMetricFrame): string {
  return `${record.captureId}\0${record.resolutionMs}\0${record.intervalStart}`;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return result;
}
