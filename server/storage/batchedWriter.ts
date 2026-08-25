import {
  validateHistoricalRecord,
  type AppendResult,
  type HistoricalRecord,
  type HistoryStore,
} from "./types.js";

export interface BatchedHistoryWriterOptions {
  batchRecords?: number;
  batchBytes?: number;
  flushIntervalMs?: number;
  queueRecords?: number;
  queueBytes?: number;
}

export interface BatchedHistoryWriterStats {
  acceptedRecords: number;
  persistedRecords: number;
  rejectedRecords: number;
  queueOverflows: number;
  pendingRecords: number;
  pendingBytes: number;
  batches: number;
  compressedBytes: number;
  failed: boolean;
  failure: string | null;
}

interface QueuedRecord {
  record: HistoricalRecord;
  bytes: number;
}

type WriterState = "open" | "closing" | "closed";

/**
 * Bounded, non-blocking ingestion front for any HistoryStore implementation.
 * enqueue() never waits for storage. Overflow and terminal write failures are
 * explicit; failed batches remain bounded in memory rather than being dropped.
 */
export class BatchedHistoryWriter {
  private readonly batchRecords: number;
  private readonly batchBytes: number;
  private readonly flushIntervalMs: number;
  private readonly queueRecords: number;
  private readonly queueBytes: number;
  private readonly queue: QueuedRecord[] = [];
  private state: WriterState = "open";
  private pendingBytes = 0;
  private acceptedRecords = 0;
  private persistedRecords = 0;
  private rejectedRecords = 0;
  private queueOverflows = 0;
  private batches = 0;
  private compressedBytes = 0;
  private failure: Error | null = null;
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly store: HistoryStore,
    options: BatchedHistoryWriterOptions = {},
  ) {
    this.batchRecords = positiveInteger(options.batchRecords, 2_000, "batchRecords");
    this.flushIntervalMs = positiveInteger(options.flushIntervalMs, 250, "flushIntervalMs");
    this.queueRecords = positiveInteger(options.queueRecords, 50_000, "queueRecords");
    this.queueBytes = positiveInteger(options.queueBytes, 64 * 1024 * 1024, "queueBytes");
    this.batchBytes = positiveInteger(
      options.batchBytes,
      Math.min(8 * 1024 * 1024, this.queueBytes),
      "batchBytes",
    );
    if (this.batchRecords > this.queueRecords) {
      throw new TypeError("batchRecords cannot exceed queueRecords");
    }
    if (this.batchBytes > this.queueBytes) {
      throw new TypeError("batchBytes cannot exceed queueBytes");
    }
  }

  get stats(): BatchedHistoryWriterStats {
    return {
      acceptedRecords: this.acceptedRecords,
      persistedRecords: this.persistedRecords,
      rejectedRecords: this.rejectedRecords,
      queueOverflows: this.queueOverflows,
      pendingRecords: this.queue.length,
      pendingBytes: this.pendingBytes,
      batches: this.batches,
      compressedBytes: this.compressedBytes,
      failed: this.failure !== null,
      failure: this.failure?.message ?? null,
    };
  }

  enqueue(record: HistoricalRecord): boolean {
    if (this.state !== "open" || this.failure) return false;
    try {
      validateHistoricalRecord(record);
    } catch {
      this.rejectedRecords += 1;
      return false;
    }
    const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (bytes > this.batchBytes
      || bytes > this.queueBytes
      || this.queue.length >= this.queueRecords
      || this.pendingBytes + bytes > this.queueBytes) {
      this.rejectedRecords += 1;
      this.queueOverflows += 1;
      return false;
    }
    this.queue.push({ record, bytes });
    this.pendingBytes += bytes;
    this.acceptedRecords += 1;
    if (this.queue.length >= this.batchRecords) this.scheduleImmediateDrain();
    else this.scheduleTimedDrain();
    return true;
  }

  enqueueMany(records: readonly HistoricalRecord[]): number {
    let accepted = 0;
    for (const record of records) {
      if (this.enqueue(record)) accepted += 1;
    }
    return accepted;
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.failure) throw this.failure;
    await this.drain();
    if (this.failure) throw this.failure;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    this.closePromise = (async () => {
      try {
        await this.flush();
      } finally {
        this.state = "closed";
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
      }
    })();
    return this.closePromise;
  }

  private scheduleTimedDrain(): void {
    if (this.timer || this.drainPromise || this.failure) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain().catch(() => undefined);
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  private scheduleImmediateDrain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.drainPromise || this.failure) return;
    queueMicrotask(() => {
      void this.drain().catch(() => undefined);
    });
  }

  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.runDrain()
      .catch((error) => {
        this.failure ??= error instanceof Error ? error : new Error(String(error));
        throw this.failure;
      })
      .finally(() => {
        this.drainPromise = null;
        if (this.queue.length > 0 && !this.failure && this.state === "open") {
          this.scheduleTimedDrain();
        }
      });
    return this.drainPromise;
  }

  private async runDrain(): Promise<void> {
    await this.store.open();
    while (this.queue.length > 0 && !this.failure) {
      const queued: QueuedRecord[] = [];
      let batchBytes = 0;
      while (queued.length < this.batchRecords && this.queue.length > 0) {
        const next = this.queue[0]!;
        if (queued.length > 0 && batchBytes + next.bytes > this.batchBytes) break;
        queued.push(this.queue.shift()!);
        batchBytes += next.bytes;
      }
      const bytes = queued.reduce((total, item) => total + item.bytes, 0);
      this.pendingBytes -= bytes;
      let result: AppendResult;
      try {
        result = await this.store.appendBatch(queued.map((item) => item.record));
      } catch (error) {
        this.queue.unshift(...queued);
        this.pendingBytes += bytes;
        this.failure = error instanceof Error ? error : new Error(String(error));
        throw this.failure;
      }
      this.persistedRecords += result.recordCount;
      this.batches += 1;
      this.compressedBytes += result.compressedBytes;
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return result;
}
