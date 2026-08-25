import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { createGzip, constants as zlibConstants } from "node:zlib";
import { SCHEMA_VERSION, type MarketSource } from "../types.js";

export type RawCaptureStream = "depth" | "trade" | "snapshot" | "status";

export const RAW_CAPTURE_ADAPTER_VERSION = "binance-usdm-adapter-v1";
export const RAW_CAPTURE_ANALYTICS_VERSION = "liquidmap-analytics-v1";

export interface RawCaptureRecord {
  capturedAt: number;
  exchange: "binance";
  symbol: string;
  source: MarketSource;
  stream: RawCaptureStream;
  connectionId: string;
  payload: string;
}

/** The on-disk envelope; captureSequence is assigned by the recorder. */
export interface RawCaptureEnvelope extends RawCaptureRecord {
  captureSequence: number;
}

export interface RawCaptureOptions {
  directory: string;
  symbol: string;
  queueCapacity?: number;
  queueByteCapacity?: number;
  maxCaptureBytes?: number;
  maxDurationMs?: number;
  retentionMs?: number;
  now?: () => number;
  id?: string;
  adapterVersion?: string;
  analyticsVersion?: string;
  endpoints?: Partial<Record<"snapshot" | "depth" | "trade", string>>;
}

export type RawCaptureCloseReason =
  | "manual"
  | "gateway_shutdown"
  | "duration_limit"
  | "size_limit"
  | "storage_failure";

export interface RawCaptureStats {
  enabled: true;
  captureId: string;
  startedAt: number;
  closedAt: number | null;
  acceptedRecords: number;
  writtenRecords: number;
  droppedRecords: number;
  invalidRecords: number;
  rawBytes: number;
  queuedRecords: number;
  queuedBytes: number;
  queueOverflows: number;
  captureLimitReached: boolean;
  expired: boolean;
  failed: boolean;
  failure: string | null;
  maxDurationMs: number;
  retentionMs: number;
  dataPath: string;
  manifestPath: string;
}

export interface RawCaptureManifest {
  captureSchemaVersion: 1;
  /** Producer versions pin how an immutable capture must be interpreted. */
  eventSchemaVersion?: typeof SCHEMA_VERSION;
  adapterVersion?: string;
  analyticsVersion?: string;
  endpoints?: Partial<Record<"snapshot" | "depth" | "trade", string>>;
  captureId: string;
  symbol: string;
  startedAt: number;
  closedAt: number;
  complete: boolean;
  closeReason?: RawCaptureCloseReason;
  dataFile: string;
  compression: "gzip";
  dataBytes: number | null;
  /** SHA-256 of the exact compressed bytes stored in dataFile. */
  sha256: string | null;
  checksum: {
    algorithm: "sha256";
    scope: "compressed-file";
    value: string;
  } | null;
  /** SHA-256 of the uncompressed NDJSON records, including newlines. */
  contentChecksum: {
    algorithm: "sha256";
    scope: "uncompressed-ndjson";
    value: string;
  };
  stats: RawCaptureStats;
  retentionMs: number;
  maxDurationMs: number;
  sequence: {
    field: "captureSequence";
    first: 1 | null;
    lastWritten: number | null;
    contiguous: true;
  };
}

interface QueuedLine {
  line: string;
  bytes: number;
}

type RecorderState = "open" | "closing" | "closed";

const DEFAULT_QUEUE_CAPACITY = 8_192;
const DEFAULT_QUEUE_BYTES = 16 * 1024 * 1024;
const DEFAULT_CAPTURE_BYTES = 512 * 1024 * 1024;
export const MAX_RAW_CAPTURE_DURATION_MS = 24 * 60 * 60 * 1_000;
export const MAX_RAW_CAPTURE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const CAPTURE_PREFIX = "liquidmap-market-";
const VALID_STREAMS = new Set<RawCaptureStream>([
  "depth",
  "trade",
  "snapshot",
  "status",
]);
const VALID_SOURCES = new Set<MarketSource>(["binance", "demo"]);

/**
 * Opt-in public-market recorder. Ingestion only enqueues bounded strings; gzip
 * I/O is drained asynchronously so storage backpressure never silently grows
 * process memory. A rejected record increments explicit drop/overflow stats.
 */
export class RawCaptureRecorder {
  private readonly now: () => number;
  private readonly queueCapacity: number;
  private readonly queueByteCapacity: number;
  private readonly maxCaptureBytes: number;
  private readonly maxDurationMs: number;
  private readonly retentionMs: number;
  private readonly queue: QueuedLine[] = [];
  private readonly contentHash = createHash("sha256");
  private readonly captureId: string;
  private readonly symbol: string;
  private readonly adapterVersion: string;
  private readonly analyticsVersion: string;
  private readonly endpoints: Partial<Record<"snapshot" | "depth" | "trade", string>>;
  private readonly startedAt: number;
  private readonly directory: string;
  private readonly dataPath: string;
  private readonly manifestPath: string;
  private readonly expiryTimer: NodeJS.Timeout;
  private gzip: ReturnType<typeof createGzip> | null = null;
  /** Always settles; failures are reflected through markFailed(). */
  private pipelinePromise: Promise<void> | null = null;
  private initializePromise: Promise<void> | null = null;
  private flushPromise: Promise<void> | null = null;
  private state: RecorderState = "open";
  private accepting = true;
  private ownsDataFile = false;
  private closePromise: Promise<RawCaptureStats> | null = null;
  private closedAt: number | null = null;
  private acceptedRecords = 0;
  private writtenRecords = 0;
  private droppedRecords = 0;
  private invalidRecords = 0;
  private rawBytes = 0;
  private queuedBytes = 0;
  private queueOverflows = 0;
  private captureLimitReached = false;
  private failed = false;
  private failure: string | null = null;
  private closeReason: RawCaptureCloseReason = "manual";

  constructor(options: RawCaptureOptions) {
    if (!options.directory.trim() || options.directory.includes("\0")) {
      throw new TypeError("Raw capture directory must be a non-empty path");
    }
    this.directory = resolve(options.directory);
    this.now = options.now ?? Date.now;
    this.startedAt = validTimestamp(this.now(), "Raw capture clock");
    this.captureId = sanitizeSegment(options.id ?? randomUUID(), 64, randomUUID());
    this.symbol = sanitizeSegment(options.symbol.toUpperCase(), 48, "UNKNOWN");
    this.adapterVersion = boundedVersion(options.adapterVersion, RAW_CAPTURE_ADAPTER_VERSION);
    this.analyticsVersion = boundedVersion(options.analyticsVersion, RAW_CAPTURE_ANALYTICS_VERSION);
    const streamSymbol = this.symbol.toLowerCase();
    this.endpoints = normalizeEndpoints(options.endpoints ?? {
      snapshot: `/fapi/v1/depth?symbol=${this.symbol}`,
      depth: `${streamSymbol}@depth@100ms`,
      trade: `${streamSymbol}@aggTrade`,
    });
    this.queueCapacity = positiveInteger(options.queueCapacity, DEFAULT_QUEUE_CAPACITY);
    this.queueByteCapacity = positiveInteger(options.queueByteCapacity, DEFAULT_QUEUE_BYTES);
    this.maxCaptureBytes = positiveInteger(options.maxCaptureBytes, DEFAULT_CAPTURE_BYTES);
    this.maxDurationMs = Math.min(
      MAX_RAW_CAPTURE_DURATION_MS,
      positiveInteger(options.maxDurationMs, MAX_RAW_CAPTURE_DURATION_MS),
    );
    this.retentionMs = Math.min(
      MAX_RAW_CAPTURE_RETENTION_MS,
      positiveInteger(options.retentionMs, MAX_RAW_CAPTURE_RETENTION_MS),
    );
    const stem = `${CAPTURE_PREFIX}${this.symbol}-${this.startedAt}-${this.captureId}`;
    this.dataPath = join(this.directory, `${stem}.ndjson.gz`);
    this.manifestPath = join(this.directory, `${stem}.manifest.json`);
    this.expiryTimer = setTimeout(() => {
      if (this.state !== "open") return;
      this.captureLimitReached = true;
      this.closeReason = "duration_limit";
      this.accepting = false;
      void this.close().catch(() => undefined);
    }, this.maxDurationMs);
    this.expiryTimer.unref();
  }

  get stats(): RawCaptureStats {
    return {
      enabled: true,
      captureId: this.captureId,
      startedAt: this.startedAt,
      closedAt: this.closedAt,
      acceptedRecords: this.acceptedRecords,
      writtenRecords: this.writtenRecords,
      droppedRecords: this.droppedRecords,
      invalidRecords: this.invalidRecords,
      rawBytes: this.rawBytes,
      queuedRecords: this.queue.length,
      queuedBytes: this.queuedBytes,
      queueOverflows: this.queueOverflows,
      captureLimitReached: this.captureLimitReached,
      expired: (this.closedAt === null
        ? this.elapsedMs()
        : Math.max(0, this.closedAt - this.startedAt)) >= this.maxDurationMs,
      failed: this.failed,
      failure: this.failure,
      maxDurationMs: this.maxDurationMs,
      retentionMs: this.retentionMs,
      dataPath: this.dataPath,
      manifestPath: this.manifestPath,
    };
  }

  record(record: RawCaptureRecord): boolean {
    // Closing/finalized statistics are immutable, including late rejected calls.
    if (this.state !== "open") return false;
    if (!this.accepting || this.failed) return this.drop(false);
    if (this.elapsedMs() >= this.maxDurationMs) {
      this.closeReason = "duration_limit";
      return this.reachCaptureLimit();
    }
    if (!this.isValidRecord(record)) {
      this.invalidRecords += 1;
      return this.drop(false);
    }

    // This cheap check bounds the allocation performed by JSON.stringify even
    // when an untrusted caller supplies an unexpectedly huge string.
    const maximumLineBytes = Math.min(this.queueByteCapacity, this.maxCaptureBytes);
    const minimumSerializedBytes = recordCharacterCount(record);
    if (minimumSerializedBytes > maximumLineBytes) {
      return this.rejectOversizedRecord(minimumSerializedBytes > this.maxCaptureBytes);
    }

    let line: string;
    try {
      line = `${JSON.stringify({
        captureSequence: this.acceptedRecords + 1,
        capturedAt: record.capturedAt,
        exchange: record.exchange,
        symbol: this.symbol,
        source: record.source,
        stream: record.stream,
        connectionId: record.connectionId,
        payload: record.payload,
      })}\n`;
    } catch {
      this.invalidRecords += 1;
      return this.drop(false);
    }
    const bytes = Buffer.byteLength(line);
    if (this.rawBytes + this.queuedBytes + bytes > this.maxCaptureBytes) {
      return this.reachCaptureLimit();
    }
    if (
      bytes > this.queueByteCapacity ||
      this.queue.length >= this.queueCapacity ||
      this.queuedBytes + bytes > this.queueByteCapacity
    ) {
      return this.drop(true);
    }
    this.queue.push({ line, bytes });
    this.queuedBytes += bytes;
    this.acceptedRecords += 1;
    this.scheduleFlush();
    return true;
  }

  close(reason: RawCaptureCloseReason = "manual"): Promise<RawCaptureStats> {
    if (this.closePromise) return this.closePromise;
    if (this.closeReason === "manual") this.closeReason = reason;
    this.state = "closing";
    this.accepting = false;
    clearTimeout(this.expiryTimer);
    this.closePromise = this.finish();
    return this.closePromise;
  }

  private isValidRecord(record: RawCaptureRecord): boolean {
    return record !== null
      && typeof record === "object"
      && Number.isFinite(record.capturedAt)
      && record.exchange === "binance"
      && typeof record.symbol === "string"
      && sanitizeSegment(record.symbol.toUpperCase(), 48, "UNKNOWN") === this.symbol
      && VALID_SOURCES.has(record.source)
      && VALID_STREAMS.has(record.stream)
      && typeof record.connectionId === "string"
      && typeof record.payload === "string";
  }

  private rejectOversizedRecord(exceedsCaptureLimit: boolean): false {
    if (exceedsCaptureLimit) return this.reachCaptureLimit();
    return this.drop(true);
  }

  private reachCaptureLimit(): false {
    this.captureLimitReached = true;
    if (this.closeReason === "manual") this.closeReason = "size_limit";
    this.accepting = false;
    const result = this.drop(false);
    void this.close().catch(() => undefined);
    return result;
  }

  private drop(overflow: boolean): false {
    this.droppedRecords += 1;
    if (overflow) this.queueOverflows += 1;
    return false;
  }

  private scheduleFlush(): void {
    if (this.flushPromise || this.failed) return;
    this.flushPromise = this.flushQueue()
      .catch((error) => this.markFailed(error))
      .finally(() => {
        this.flushPromise = null;
        if (this.queue.length > 0 && !this.failed) this.scheduleFlush();
      });
  }

  private async flushQueue(): Promise<void> {
    await this.initialize();
    while (this.queue.length > 0 && !this.failed) {
      const queued = this.queue.shift()!;
      this.queuedBytes -= queued.bytes;
      let canContinue: boolean;
      try {
        canContinue = this.gzip!.write(queued.line, "utf8");
      } catch (error) {
        this.droppedRecords += 1;
        throw error;
      }
      this.contentHash.update(queued.line);
      this.rawBytes += queued.bytes;
      this.writtenRecords += 1;
      if (!canContinue) await once(this.gzip!, "drain");
    }
  }

  private initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      const createdDirectory = await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directoryMetadata = await lstat(this.directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        throw new Error("Raw capture directory must be a real directory, not a symbolic link");
      }
      // Do not chmod a pre-existing configured directory (for example /tmp).
      if (createdDirectory) await chmod(this.directory, 0o700);
      await purgeExpiredCaptures(this.directory, this.retentionMs, this.safeNow());

      const output = createWriteStream(this.dataPath, { flags: "wx", mode: 0o600 });
      this.gzip = createGzip({
        level: 6,
        flush: zlibConstants.Z_SYNC_FLUSH,
      });
      this.pipelinePromise = pipeline(this.gzip, output).catch((error) => {
        this.markFailed(error);
      });
      await once(output, "open");
      this.ownsDataFile = true;
    })();
    return this.initializePromise;
  }

  private async finish(): Promise<RawCaptureStats> {
    try {
      if (this.queue.length > 0) this.scheduleFlush();
      while (this.flushPromise) await this.flushPromise;
      if (!this.initializePromise && this.acceptedRecords === 0) {
        try {
          await this.initialize();
        } catch (error) {
          this.markFailed(error);
        }
      } else if (this.initializePromise) {
        try {
          await this.initializePromise;
        } catch (error) {
          this.markFailed(error);
        }
      }

      if (this.gzip && !this.gzip.destroyed) {
        if (this.failed) this.gzip.destroy(new Error(this.failure ?? "Raw capture failed"));
        else this.gzip.end();
      }
      if (this.pipelinePromise) await this.pipelinePromise;
      this.closedAt = this.safeNow();

      if (!this.ownsDataFile) {
        throw new Error(this.failure ?? "Raw capture data file could not be created");
      }

      let dataBytes: number | null = null;
      let dataSha256: string | null = null;
      try {
        const metadata = await stat(this.dataPath);
        dataBytes = metadata.size;
        dataSha256 = await sha256File(this.dataPath);
      } catch (error) {
        this.markFailed(error);
      }

      const contentSha256 = this.contentHash.digest("hex");
      const manifest: RawCaptureManifest = {
        captureSchemaVersion: 1,
        eventSchemaVersion: SCHEMA_VERSION,
        adapterVersion: this.adapterVersion,
        analyticsVersion: this.analyticsVersion,
        endpoints: this.endpoints,
        captureId: this.captureId,
        symbol: this.symbol,
        startedAt: this.startedAt,
        closedAt: this.closedAt,
        complete: !this.failed
          && this.droppedRecords === 0
          && this.acceptedRecords === this.writtenRecords
          && dataSha256 !== null,
        closeReason: this.closeReason,
        dataFile: basename(this.dataPath),
        compression: "gzip",
        dataBytes,
        sha256: dataSha256,
        checksum: dataSha256 === null ? null : {
          algorithm: "sha256",
          scope: "compressed-file",
          value: dataSha256,
        },
        contentChecksum: {
          algorithm: "sha256",
          scope: "uncompressed-ndjson",
          value: contentSha256,
        },
        stats: this.stats,
        retentionMs: this.retentionMs,
        maxDurationMs: this.maxDurationMs,
        sequence: {
          field: "captureSequence",
          first: this.writtenRecords > 0 ? 1 : null,
          lastWritten: this.writtenRecords > 0 ? this.writtenRecords : null,
          contiguous: true,
        },
      };
      try {
        await writeManifestExclusive(this.manifestPath, manifest);
      } catch (error) {
        this.markFailed(error);
        throw error;
      }
      return this.stats;
    } finally {
      clearTimeout(this.expiryTimer);
      if (this.closedAt === null) this.closedAt = this.safeNow();
      this.state = "closed";
    }
  }

  private markFailed(error: unknown): void {
    const normalized = toError(error);
    const shouldFinalize = this.state === "open";
    this.failed = true;
    this.accepting = false;
    this.failure ??= normalized.message;
    this.closeReason = "storage_failure";
    this.droppedRecords += this.queue.length;
    this.queue.length = 0;
    this.queuedBytes = 0;
    if (this.gzip && !this.gzip.destroyed) this.gzip.destroy(normalized);
    if (shouldFinalize) {
      queueMicrotask(() => {
        if (this.state === "open") void this.close().catch(() => undefined);
      });
    }
  }

  private safeNow(): number {
    const value = this.now();
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : this.startedAt;
  }

  private elapsedMs(): number {
    return Math.max(0, this.safeNow() - this.startedAt);
  }
}

export function rawCaptureOptionsFromEnvironment(
  symbol: string,
  environment: NodeJS.ProcessEnv = process.env,
): RawCaptureOptions | null {
  const directory = environment.XBMAP_CAPTURE_DIR?.trim();
  if (!directory) return null;
  return {
    directory,
    symbol,
    queueCapacity: optionalInteger(environment.XBMAP_CAPTURE_QUEUE_RECORDS),
    queueByteCapacity: optionalInteger(environment.XBMAP_CAPTURE_QUEUE_BYTES),
    maxCaptureBytes: optionalInteger(environment.XBMAP_CAPTURE_MAX_BYTES),
    maxDurationMs: optionalInteger(environment.XBMAP_CAPTURE_MAX_DURATION_MS),
    retentionMs: optionalInteger(environment.XBMAP_CAPTURE_RETENTION_MS),
  };
}

async function purgeExpiredCaptures(directory: string, retentionMs: number, now: number) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.flatMap((entry) => {
    if (!entry.isFile() || !isCaptureArtifact(entry.name)) return [];
    const path = join(directory, entry.name);
    return [(async () => {
      try {
        const metadata = await stat(path);
        if (now - metadata.mtimeMs >= retentionMs) await unlink(path);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    })()];
  }));
}

async function writeManifestExclusive(
  manifestPath: string,
  manifest: RawCaptureManifest,
): Promise<void> {
  const temporary = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    // link() is an atomic, no-replace publish on the same filesystem.
    await link(temporary, manifestPath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function isCaptureArtifact(name: string): boolean {
  if (!name.startsWith(CAPTURE_PREFIX)) return false;
  return name.endsWith(".ndjson.gz")
    || name.endsWith(".manifest.json")
    || name.includes(".manifest.json.tmp-");
}

function recordCharacterCount(record: RawCaptureRecord): number {
  // A lower bound: JSON escaping can only increase this number.
  return record.symbol.length
    + record.connectionId.length
    + record.payload.length;
}

function optionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  const integer = Math.floor(parsed);
  return Number.isSafeInteger(integer) ? integer : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value! < 1) return fallback;
  const integer = Math.floor(value!);
  return Number.isSafeInteger(integer) ? integer : fallback;
}

function sanitizeSegment(value: string, maximumLength: number, fallback: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maximumLength);
  return sanitized || fallback;
}

function boundedVersion(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length <= 96 && /^[A-Za-z0-9._-]+$/.test(normalized)
    ? normalized
    : fallback;
}

function normalizeEndpoints(
  value: RawCaptureOptions["endpoints"],
): Partial<Record<"snapshot" | "depth" | "trade", string>> {
  const result: Partial<Record<"snapshot" | "depth" | "trade", string>> = {};
  for (const key of ["snapshot", "depth", "trade"] as const) {
    const endpoint = value?.[key]?.trim();
    if (endpoint && endpoint.length <= 512 && !endpoint.includes("\0")) result[key] = endpoint;
  }
  return result;
}

function validTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must return a finite non-negative timestamp`);
  }
  return Math.trunc(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
