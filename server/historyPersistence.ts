import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  BatchedHistoryWriter,
  DEFAULT_HISTORY_RETENTION,
  DownsampleWorker,
  FileHistoryStore,
  HISTORY_RESOLUTIONS_MS,
  HISTORY_SCHEMA_VERSION,
  canonicalQuantity,
  clickHouseHistoryStoreFromEnvironment,
  type BackupResult,
  type BatchedHistoryWriterStats,
  type HistoryCursor,
  type HistoryResolutionMs,
  type HistoryRetentionPolicy,
  type HistoryStore,
  type MaintenanceCheckpointStore,
  type RetentionResult,
  type StoredDepthDelta,
  type StoredDepthSnapshot,
  type StoredMetricFrame,
  type StoredPriceLevel,
  type StoredTrade,
} from "./storage/index.js";
import type {
  DepthSnapshot,
  DepthUpdate,
  HistoryPoint,
  MetricFrame,
  NormalizedTrade,
  TrendSignal,
  WirePriceLevel,
} from "./types.js";

export interface HistoryPersistenceOptions {
  /** File backend root; required unless a `store` is injected. */
  directory?: string;
  symbol: string;
  tickSize: number;
  /** Injected backend (e.g. ClickHouse); defaults to the file adapter. */
  store?: HistoryStore & MaintenanceCheckpointStore;
  queueRecords?: number;
  queueBytes?: number;
  batchRecords?: number;
  flushIntervalMs?: number;
  segmentRecords?: number;
  segmentBytes?: number;
  queryDefaultRows?: number;
  queryMaxRows?: number;
  queryMaxRangeMs?: number;
  retentionPolicy?: HistoryRetentionPolicy;
  retentionIntervalMs?: number;
  backupDirectory?: string;
  backupIntervalMs?: number;
  backupKeep?: number;
  now?: () => number;
}

export interface MetricIntervalFacts {
  intervalStart: number;
  intervalEnd: number;
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
}

export interface PersistentHistoryResult {
  items: HistoryPoint[];
  resolutionMs: HistoryResolutionMs;
  truncated: boolean;
  nextCursor: HistoryCursor | null;
  scannedSegments: number;
  scannedCompressedBytes: number;
}

export interface HistoryPersistenceStats {
  enabled: true;
  writer: BatchedHistoryWriterStats;
  maintenance: {
    running: boolean;
    failures: number;
    lastFailure: string | null;
    lastRetentionAt: number | null;
    lastBackupAt: number | null;
    lastBackupManifestSha256: string | null;
  };
}

interface CaptureBounds {
  from: number;
  to: number;
}

/**
 * Gateway-facing durable history runtime. Ingestion only calls enqueue(), while
 * compression, rollups, retention, and backups execute asynchronously.
 */
export class HistoryPersistence {
  readonly store: HistoryStore & MaintenanceCheckpointStore;
  readonly writer: BatchedHistoryWriter;
  readonly symbol: string;
  readonly tickSize: number;

  private readonly now: () => number;
  private readonly downsample: DownsampleWorker;
  private readonly captureSequence = new Map<string, number>();
  private readonly captureBounds = new Map<string, CaptureBounds>();
  private readonly retentionPolicy: HistoryRetentionPolicy;
  private readonly retentionIntervalMs: number;
  private readonly backupDirectory: string | null;
  private readonly backupIntervalMs: number;
  private readonly backupKeep: number;
  private retentionTimer: NodeJS.Timeout | null = null;
  private backupTimer: NodeJS.Timeout | null = null;
  private maintenanceTail: Promise<void> = Promise.resolve();
  private maintenanceRunning = false;
  private maintenanceFailures = 0;
  private lastMaintenanceFailure: string | null = null;
  private lastRetentionAt: number | null = null;
  private lastBackupAt: number | null = null;
  private lastBackupManifestSha256: string | null = null;
  private closing = false;

  private constructor(options: HistoryPersistenceOptions) {
    if (!/^[A-Z0-9_.-]{1,48}$/.test(options.symbol.toUpperCase())) {
      throw new TypeError("History symbol is invalid");
    }
    if (!Number.isFinite(options.tickSize) || options.tickSize <= 0) {
      throw new TypeError("History tick size must be positive");
    }
    this.symbol = options.symbol.toUpperCase();
    this.tickSize = options.tickSize;
    this.now = options.now ?? Date.now;
    // Backend injection keeps ingestion/replay call sites unchanged while
    // letting XBMAP_HISTORY_BACKEND select a production store.
    this.store = options.store ?? new FileHistoryStore({
      directory: options.directory ?? "",
      maxBatchRecords: options.segmentRecords,
      maxBatchBytes: options.segmentBytes,
      now: this.now,
      limits: {
        ...(options.queryDefaultRows ? { defaultRows: options.queryDefaultRows } : {}),
        ...(options.queryMaxRows ? { maxRows: options.queryMaxRows } : {}),
        ...(options.queryMaxRangeMs ? { maxRangeMs: options.queryMaxRangeMs } : {}),
      },
    });
    this.writer = new BatchedHistoryWriter(this.store, {
      batchRecords: options.batchRecords,
      batchBytes: options.segmentBytes,
      flushIntervalMs: options.flushIntervalMs,
      queueRecords: options.queueRecords,
      queueBytes: options.queueBytes,
    });
    this.downsample = new DownsampleWorker(this.store);
    this.retentionPolicy = cloneRetention(options.retentionPolicy ?? DEFAULT_HISTORY_RETENTION);
    this.retentionIntervalMs = positiveInteger(
      options.retentionIntervalMs,
      60 * 60_000,
      "retentionIntervalMs",
    );
    this.backupDirectory = options.backupDirectory?.trim()
      ? resolve(options.backupDirectory)
      : null;
    this.backupIntervalMs = positiveInteger(
      options.backupIntervalMs,
      24 * 60 * 60_000,
      "backupIntervalMs",
    );
    this.backupKeep = positiveInteger(options.backupKeep, 7, "backupKeep");
  }

  static async open(options: HistoryPersistenceOptions): Promise<HistoryPersistence> {
    const runtime = new HistoryPersistence(options);
    await runtime.store.open();
    if (runtime.backupDirectory) await mkdir(runtime.backupDirectory, { recursive: true, mode: 0o700 });
    runtime.startMaintenanceTimers();
    return runtime;
  }

  get stats() {
    return {
      enabled: true as const,
      writer: this.writer.stats,
      maintenance: {
        running: this.maintenanceRunning,
        failures: this.maintenanceFailures,
        lastFailure: this.lastMaintenanceFailure,
        lastRetentionAt: this.lastRetentionAt,
        lastBackupAt: this.lastBackupAt,
        lastBackupManifestSha256: this.lastBackupManifestSha256,
      },
    };
  }

  recordSnapshot(
    captureId: string,
    snapshot: DepthSnapshot,
    stateFingerprint: string,
    receivedTimestamp: number,
  ): boolean {
    const record: StoredDepthSnapshot = {
      ...this.common(captureId, snapshot.exchangeTimestamp ?? receivedTimestamp, receivedTimestamp),
      kind: "depth_snapshot",
      lastUpdateId: snapshot.lastUpdateId,
      tickSize: this.tickSize,
      bids: storedLevels(snapshot.bids, this.tickSize),
      asks: storedLevels(snapshot.asks, this.tickSize),
      stateFingerprint,
    };
    return this.writer.enqueue(record);
  }

  recordDepth(captureId: string, update: DepthUpdate): boolean {
    const record: StoredDepthDelta = {
      ...this.common(captureId, update.exchangeTimestamp, update.receivedTimestamp),
      kind: "depth_delta",
      sequenceStart: update.sequenceStart,
      sequenceEnd: update.sequenceEnd,
      ...(update.previousSequence !== undefined
        ? { previousSequence: update.previousSequence }
        : {}),
      tickSize: this.tickSize,
      bids: storedLevels(update.bids, this.tickSize),
      asks: storedLevels(update.asks, this.tickSize),
    };
    return this.writer.enqueue(record);
  }

  recordTrade(captureId: string, trade: NormalizedTrade): boolean {
    const record: StoredTrade = {
      ...this.common(captureId, trade.exchangeTimestamp, trade.receivedTimestamp),
      kind: "trade",
      tradeId: trade.id,
      priceTicks: priceTicks(trade.price, this.tickSize),
      tickSize: this.tickSize,
      quantity: quantityText(trade.quantity),
      side: trade.side,
    };
    return this.writer.enqueue(record);
  }

  recordMetric(
    captureId: string,
    metric: MetricFrame,
    trend: TrendSignal,
    facts: MetricIntervalFacts,
    bookFingerprint: string | null,
  ): boolean {
    const analyticsFingerprint = createHash("sha256").update(JSON.stringify({
      algorithm: "liquidmap-analytics-frame-v1",
      metric,
      trend,
      facts,
    })).digest("hex");
    const record: StoredMetricFrame = {
      // Index metric facts by their interval start so rollup queries align.
      ...this.common(captureId, facts.intervalStart, facts.intervalEnd),
      kind: "metric_frame",
      resolutionMs: 1_000,
      intervalStart: facts.intervalStart,
      intervalEnd: facts.intervalEnd,
      intervalBuyVolume: finiteNonNegative(facts.buyVolume),
      intervalSellVolume: finiteNonNegative(facts.sellVolume),
      intervalTradeCount: nonNegativeInteger(facts.tradeCount),
      metric: structuredClone(metric),
      trend: structuredClone(trend),
      bookFingerprint,
      analyticsFingerprint,
    };
    const accepted = this.writer.enqueue(record);
    if (accepted) {
      const bounds = this.captureBounds.get(captureId);
      this.captureBounds.set(captureId, {
        from: Math.min(bounds?.from ?? facts.intervalStart, facts.intervalStart),
        to: Math.max(bounds?.to ?? facts.intervalEnd, facts.intervalEnd),
      });
      if (facts.intervalEnd % 5_000 === 0) this.queueDownsample(captureId);
    }
    return accepted;
  }

  async queryHistory(
    from: number,
    to: number,
    requestedResolutionMs: number,
    limit: number,
  ): Promise<PersistentHistoryResult> {
    const resolutionMs = nearestHistoryResolution(requestedResolutionMs);
    await this.writer.flush();
    const result = await this.store.query({
      exchange: "binance",
      symbol: this.symbol,
      from: Math.trunc(from),
      to: Math.trunc(to) + 1,
      kinds: ["metric_frame"],
      resolutionMs,
      limit,
    });
    return {
      items: result.records
        .filter((record): record is StoredMetricFrame => record.kind === "metric_frame")
        .map(historyPoint),
      resolutionMs,
      truncated: result.truncated,
      nextCursor: result.nextCursor,
      scannedSegments: result.scannedSegments,
      scannedCompressedBytes: result.scannedCompressedBytes,
    };
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  runRetention(now = this.safeNow()): Promise<RetentionResult> {
    return this.enqueueMaintenance(async () => {
      await this.writer.flush();
      const result = await this.store.runRetention(this.retentionPolicy, now);
      this.lastRetentionAt = now;
      return result;
    });
  }

  createBackup(destination?: string): Promise<BackupResult> {
    return this.enqueueMaintenance(async () => {
      await this.writer.flush();
      const target = destination ?? this.nextBackupPath();
      const result = await this.store.createBackup(target);
      this.lastBackupAt = this.safeNow();
      this.lastBackupManifestSha256 = result.manifestSha256;
      if (!destination) await this.pruneBackups();
      return result;
    });
  }

  async restoreBackup(source: string): Promise<void> {
    if (this.writer.stats.pendingRecords > 0) {
      throw new Error("History restore requires an idle persistence queue");
    }
    await this.store.restoreBackup(source);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.backupTimer) clearInterval(this.backupTimer);
    this.retentionTimer = null;
    this.backupTimer = null;
    await this.writer.flush();
    await this.maintenanceTail;
    await this.writer.close();
  }

  private common(captureId: string, exchangeTimestamp: number, receivedTimestamp: number) {
    const normalizedCaptureId = captureId.trim();
    if (!normalizedCaptureId || normalizedCaptureId.length > 128) {
      throw new TypeError("History capture id is invalid");
    }
    const next = (this.captureSequence.get(normalizedCaptureId) ?? 0) + 1;
    if (!Number.isSafeInteger(next)) throw new Error("History capture sequence exhausted");
    this.captureSequence.set(normalizedCaptureId, next);
    return {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      exchange: "binance" as const,
      symbol: this.symbol,
      captureId: normalizedCaptureId,
      captureSequence: next,
      exchangeTimestamp: safeTimestamp(exchangeTimestamp),
      receivedTimestamp: safeTimestamp(receivedTimestamp),
    };
  }

  private queueDownsample(captureId: string): void {
    const bounds = this.captureBounds.get(captureId);
    if (!bounds || this.closing) return;
    void this.enqueueMaintenance(async () => {
      await this.writer.flush();
      await this.downsample.run({
        exchange: "binance",
        symbol: this.symbol,
        captureId,
        sourceResolutionMs: 1_000,
        targetResolutionMs: 5_000,
      }, { from: bounds.from, to: bounds.to, settleDelayMs: 0 });
      await this.downsample.run({
        exchange: "binance",
        symbol: this.symbol,
        captureId,
        sourceResolutionMs: 5_000,
        targetResolutionMs: 60_000,
      }, { from: bounds.from, to: bounds.to, settleDelayMs: 0 });
    }).catch(() => undefined);
  }

  private enqueueMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    });
    this.maintenanceTail = this.maintenanceTail.then(async () => {
      this.maintenanceRunning = true;
      try {
        const value = await operation();
        this.lastMaintenanceFailure = null;
        resolveResult(value);
      } catch (error) {
        this.maintenanceFailures += 1;
        this.lastMaintenanceFailure = error instanceof Error ? error.message : String(error);
        rejectResult(error);
      } finally {
        this.maintenanceRunning = false;
      }
    });
    return result;
  }

  private startMaintenanceTimers(): void {
    this.retentionTimer = setInterval(() => {
      void this.runRetention().catch(() => undefined);
    }, this.retentionIntervalMs);
    this.retentionTimer.unref?.();
    if (this.backupDirectory) {
      this.backupTimer = setInterval(() => {
        void this.createBackup().catch(() => undefined);
      }, this.backupIntervalMs);
      this.backupTimer.unref?.();
    }
  }

  private nextBackupPath(): string {
    if (!this.backupDirectory) {
      throw new Error("Automatic history backup directory is not configured");
    }
    return join(this.backupDirectory, `history-backup-${this.safeNow()}`);
  }

  private async pruneBackups(): Promise<void> {
    if (!this.backupDirectory) return;
    const entries = (await readdir(this.backupDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^history-backup-\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const obsolete = entries.slice(0, Math.max(0, entries.length - this.backupKeep));
    for (const entry of obsolete) {
      const path = join(this.backupDirectory, basename(entry));
      await rm(path, { recursive: true, force: true });
    }
  }

  private safeNow(): number {
    return safeTimestamp(this.now());
  }
}

export async function historyPersistenceFromEnvironment(
  symbol: string,
  tickSize: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<HistoryPersistence | null> {
  const queryMaxRows = envInteger(environment.XBMAP_HISTORY_QUERY_MAX_POINTS, 10_000);
  const commonOptions = {
    symbol,
    tickSize,
    queueRecords: envInteger(environment.XBMAP_HISTORY_QUEUE_RECORDS, 20_000),
    queueBytes: envInteger(environment.XBMAP_HISTORY_QUEUE_BYTES, 32 * 1024 * 1024),
    batchRecords: envInteger(environment.XBMAP_HISTORY_BATCH_RECORDS, 1_000),
    flushIntervalMs: envInteger(environment.XBMAP_HISTORY_FLUSH_MS, 250),
    segmentRecords: envInteger(environment.XBMAP_HISTORY_SEGMENT_RECORDS, 10_000),
    segmentBytes: envInteger(environment.XBMAP_HISTORY_SEGMENT_BYTES, 16 * 1024 * 1024),
    queryDefaultRows: Math.min(10_000, queryMaxRows),
    queryMaxRows,
    queryMaxRangeMs: envInteger(environment.XBMAP_HISTORY_QUERY_MAX_RANGE_MS, 24 * 60 * 60_000),
    retentionIntervalMs: envInteger(environment.XBMAP_HISTORY_RETENTION_INTERVAL_MS, 60 * 60_000),
    backupDirectory: environment.XBMAP_HISTORY_BACKUP_DIR,
    backupIntervalMs: envInteger(environment.XBMAP_HISTORY_BACKUP_INTERVAL_MS, 24 * 60 * 60_000),
    backupKeep: envInteger(environment.XBMAP_HISTORY_BACKUP_KEEP, 7),
    retentionPolicy: retentionFromEnvironment(environment),
  };

  const backend = (environment.XBMAP_HISTORY_BACKEND ?? "").trim().toLowerCase();
  if (backend === "" || backend === "file") {
    const directory = environment.XBMAP_HISTORY_DIR?.trim();
    if (!directory) return null;
    return HistoryPersistence.open({ ...commonOptions, directory });
  }
  if (backend === "clickhouse") {
    const store = clickHouseHistoryStoreFromEnvironment(environment);
    if (!store) throw new TypeError("XBMAP_HISTORY_BACKEND=clickhouse requires ClickHouse configuration");
    return HistoryPersistence.open({ ...commonOptions, store });
  }
  throw new TypeError(`Unsupported XBMAP_HISTORY_BACKEND: ${backend}`);
}

export function nearestHistoryResolution(value: number): HistoryResolutionMs {
  const candidate = Number.isFinite(value) ? value : 1_000;
  return HISTORY_RESOLUTIONS_MS.reduce((closest, resolution) =>
    Math.abs(resolution - candidate) < Math.abs(closest - candidate) ? resolution : closest);
}

function historyPoint(record: StoredMetricFrame): HistoryPoint {
  const volume = record.intervalBuyVolume + record.intervalSellVolume;
  return {
    timestamp: record.intervalStart,
    price: record.metric.lastPrice,
    volume,
    delta: record.intervalBuyVolume - record.intervalSellVolume,
    cvd: record.metric.cvd,
    imbalance: record.metric.imbalance,
    trendScore: record.trend.score,
    trendDirection: record.trend.direction,
  };
}

function storedLevels(levels: WirePriceLevel[], tickSize: number): StoredPriceLevel[] {
  return levels.map(([price, quantity]) => [
    priceTicks(Number(price), tickSize),
    typeof quantity === "string" ? canonicalQuantity(quantity.trim()) : quantityText(quantity),
  ]);
}

function priceTicks(price: number, tickSize: number): number {
  const ticks = Math.round(price / tickSize);
  if (!Number.isSafeInteger(ticks) || ticks <= 0) throw new TypeError("Historical price is invalid");
  return ticks;
}

function quantityText(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Historical quantity is invalid");
  const plain = String(value).includes("e")
    ? value.toFixed(16).replace(/0+$/, "").replace(/\.$/, "")
    : String(value);
  return canonicalQuantity(plain || "0");
}

function finiteNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Metric interval volume is invalid");
  return value;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Metric trade count is invalid");
  return value;
}

function safeTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Historical timestamp is invalid");
  const timestamp = Math.trunc(value);
  if (!Number.isSafeInteger(timestamp)) throw new TypeError("Historical timestamp is unsafe");
  return timestamp;
}

function envInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function retentionFromEnvironment(environment: NodeJS.ProcessEnv): HistoryRetentionPolicy {
  return {
    tradeMs: envInteger(environment.XBMAP_HISTORY_RETENTION_TRADE_MS, DEFAULT_HISTORY_RETENTION.tradeMs),
    depthSnapshotMs: envInteger(
      environment.XBMAP_HISTORY_RETENTION_SNAPSHOT_MS,
      DEFAULT_HISTORY_RETENTION.depthSnapshotMs,
    ),
    depthDeltaMs: envInteger(
      environment.XBMAP_HISTORY_RETENTION_DELTA_MS,
      DEFAULT_HISTORY_RETENTION.depthDeltaMs,
    ),
    metricFrameMs: {
      1_000: envInteger(
        environment.XBMAP_HISTORY_RETENTION_METRIC_1S_MS,
        DEFAULT_HISTORY_RETENTION.metricFrameMs[1_000],
      ),
      5_000: envInteger(
        environment.XBMAP_HISTORY_RETENTION_METRIC_5S_MS,
        DEFAULT_HISTORY_RETENTION.metricFrameMs[5_000],
      ),
      60_000: envInteger(
        environment.XBMAP_HISTORY_RETENTION_METRIC_1M_MS,
        DEFAULT_HISTORY_RETENTION.metricFrameMs[60_000],
      ),
    },
  };
}

function cloneRetention(policy: Readonly<HistoryRetentionPolicy>): HistoryRetentionPolicy {
  return { ...policy, metricFrameMs: { ...policy.metricFrameMs } };
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return result;
}
