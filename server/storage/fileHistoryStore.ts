import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import {
  DEFAULT_HISTORY_QUERY_LIMITS,
  DEFAULT_HISTORY_RETENTION,
  HISTORY_SCHEMA_VERSION,
  HistoryQueryLimitError,
  HistoryStorageBusyError,
  HistoryValidationError,
  compareCursor,
  compareHistoryRecords,
  historyCursor,
  historyTimestamp,
  validateHistoricalRecord,
  type AppendResult,
  type BackupResult,
  type HistoricalRecord,
  type HistoricalRecordKind,
  type HistoryQuery,
  type HistoryQueryLimits,
  type HistoryQueryResult,
  type HistoryRetentionPolicy,
  type HistoryStore,
  type MaintenanceCheckpointStore,
  type RetentionResult,
} from "./types.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const STORE_FORMAT_VERSION = 1 as const;
const CATALOG_FILE = "catalog.json";
const SEGMENTS_DIRECTORY = "segments";
const BACKUP_MANIFEST_FILE = "backup.json";
const DEFAULT_MAX_BATCH_RECORDS = 10_000;
const DEFAULT_MAX_BATCH_BYTES = 16 * 1024 * 1024;

export interface FileHistoryStoreOptions {
  directory: string;
  limits?: Partial<HistoryQueryLimits>;
  maxBatchRecords?: number;
  maxBatchBytes?: number;
  compressionLevel?: number;
  now?: () => number;
}

export interface HistorySegmentMetadata {
  id: string;
  file: string;
  recordCount: number;
  minTimestamp: number;
  maxTimestamp: number;
  minCaptureSequence: number;
  maxCaptureSequence: number;
  exchanges: ["binance"];
  symbols: string[];
  captureIds: string[];
  kinds: HistoricalRecordKind[];
  uncompressedBytes: number;
  compressedBytes: number;
  compressedSha256: string;
  contentSha256: string;
}

interface HistoryCatalog {
  formatVersion: typeof STORE_FORMAT_VERSION;
  historySchemaVersion: typeof HISTORY_SCHEMA_VERSION;
  storeId: string;
  createdAt: number;
  revision: number;
  maintenanceCheckpoints: Record<string, number>;
  segments: HistorySegmentMetadata[];
}

interface BackupManifest {
  backupFormatVersion: 1;
  createdAt: number;
  catalog: HistoryCatalog;
  segments: Array<{
    file: string;
    compressedBytes: number;
    compressedSha256: string;
  }>;
}

interface SegmentLease {
  catalog: HistoryCatalog;
  segments: HistorySegmentMetadata[];
  release(): Promise<void>;
}

interface PreparedSegment {
  metadata: HistorySegmentMetadata;
  finalPath: string;
}

interface RetentionReplacement {
  original: HistorySegmentMetadata;
  replacement: PreparedSegment | null;
  removedRecords: number;
  retainedRecords: number;
}

/**
 * Dependency-free durable projection for development and deterministic tests.
 *
 * Batches become immutable gzip NDJSON segments. Only the small catalog commit
 * is serialized; compression, reads, backup copies, and retention rewrites run
 * outside that lock. The production ClickHouse adapter can implement the same
 * HistoryStore contract without changing ingestion or replay call sites.
 *
 * This adapter has one writer process by design. A production multi-process
 * deployment must use ClickHouse rather than sharing this directory.
 */
export class FileHistoryStore implements HistoryStore, MaintenanceCheckpointStore {
  readonly directory: string;
  readonly limits: Readonly<HistoryQueryLimits>;
  private readonly segmentsDirectory: string;
  private readonly catalogPath: string;
  private readonly maxBatchRecords: number;
  private readonly maxBatchBytes: number;
  private readonly compressionLevel: number;
  private readonly now: () => number;
  private readonly pinCounts = new Map<string, number>();
  private readonly pendingDeletes = new Set<string>();
  private catalog: HistoryCatalog | null = null;
  private openPromise: Promise<void> | null = null;
  private lockTail: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(options: FileHistoryStoreOptions) {
    if (!options.directory?.trim() || options.directory.includes("\0")) {
      throw new TypeError("History directory must be a non-empty path");
    }
    this.directory = resolve(options.directory);
    this.segmentsDirectory = join(this.directory, SEGMENTS_DIRECTORY);
    this.catalogPath = join(this.directory, CATALOG_FILE);
    this.maxBatchRecords = positiveInteger(
      options.maxBatchRecords,
      DEFAULT_MAX_BATCH_RECORDS,
      "maxBatchRecords",
    );
    this.maxBatchBytes = positiveInteger(
      options.maxBatchBytes,
      DEFAULT_MAX_BATCH_BYTES,
      "maxBatchBytes",
    );
    const level = options.compressionLevel ?? 6;
    if (!Number.isInteger(level) || level < 0 || level > 9) {
      throw new TypeError("compressionLevel must be an integer between 0 and 9");
    }
    this.compressionLevel = level;
    this.now = options.now ?? Date.now;
    this.limits = normalizeLimits(options.limits);
  }

  open(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = this.initialize().catch((error) => {
      this.openPromise = null;
      throw error;
    });
    return this.openPromise;
  }

  async appendBatch(records: readonly HistoricalRecord[]): Promise<AppendResult> {
    await this.open();
    if (records.length < 1) throw new HistoryValidationError("Batch cannot be empty");
    if (records.length > this.maxBatchRecords) {
      throw new HistoryValidationError(
        `Batch has ${records.length} records; maximum is ${this.maxBatchRecords}`,
      );
    }
    for (const record of records) validateHistoricalRecord(record);
    const ordered = [...records].sort(compareHistoryRecords);
    const generation = this.generation;
    const prepared = await this.prepareSegment(ordered);
    let committed = false;
    try {
      await this.withCatalogLock(async () => {
        if (generation !== this.generation) {
          throw new HistoryStorageBusyError("Store was restored while batch was being prepared");
        }
        const catalog = this.requireCatalog();
        const next = {
          ...catalog,
          revision: catalog.revision + 1,
          segments: sortSegments([...catalog.segments, prepared.metadata]),
        };
        await writeAtomicJson(this.catalogPath, next);
        this.catalog = next;
        committed = true;
      });
    } finally {
      if (!committed) await unlink(prepared.finalPath).catch(() => undefined);
    }
    return {
      segmentId: prepared.metadata.id,
      recordCount: prepared.metadata.recordCount,
      uncompressedBytes: prepared.metadata.uncompressedBytes,
      compressedBytes: prepared.metadata.compressedBytes,
    };
  }

  async query(query: HistoryQuery): Promise<HistoryQueryResult> {
    await this.open();
    const normalized = validateQuery(query, this.limits);
    const lease = await this.leaseSegments((segment) => segmentMatches(segment, normalized));
    try {
      if (lease.segments.length > this.limits.maxScannedSegments) {
        throw new HistoryQueryLimitError(
          `Query touches ${lease.segments.length} segments; maximum is ${this.limits.maxScannedSegments}`,
          "SEGMENT_LIMIT",
        );
      }
      const scannedCompressedBytes = lease.segments.reduce(
        (total, segment) => total + segment.compressedBytes,
        0,
      );
      if (scannedCompressedBytes > this.limits.maxScannedCompressedBytes) {
        throw new HistoryQueryLimitError(
          `Query scans ${scannedCompressedBytes} compressed bytes; maximum is ${this.limits.maxScannedCompressedBytes}`,
          "BYTE_LIMIT",
        );
      }

      const candidates: HistoricalRecord[] = [];
      for (const segment of lease.segments) {
        const records = await this.readSegment(segment);
        for (const record of records) {
          if (!recordMatches(record, normalized)) continue;
          candidates.push(record);
        }
        // Keep memory proportional to the response bound even if many records match.
        if (candidates.length > normalized.limit * 2) {
          candidates.sort(compareHistoryRecords);
          candidates.length = normalized.limit + 1;
        }
      }
      candidates.sort(compareHistoryRecords);
      const truncated = candidates.length > normalized.limit;
      const records = candidates.slice(0, normalized.limit);
      return {
        records,
        truncated,
        nextCursor: truncated && records.length > 0
          ? historyCursor(records[records.length - 1]!)
          : null,
        scannedSegments: lease.segments.length,
        scannedCompressedBytes,
      };
    } finally {
      await lease.release();
    }
  }

  async runRetention(
    policy: HistoryRetentionPolicy = cloneRetentionPolicy(DEFAULT_HISTORY_RETENTION),
    now = this.safeNow(),
  ): Promise<RetentionResult> {
    await this.open();
    validateRetentionPolicy(policy);
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new HistoryValidationError("Retention clock must be a non-negative safe integer");
    }

    const lease = await this.leaseSegments(() => true);
    const replacements: RetentionReplacement[] = [];
    const preparedPaths: string[] = [];
    try {
      for (const original of lease.segments) {
        const records = await this.readSegment(original);
        const retained = records.filter((record) => shouldRetain(record, policy, now));
        if (retained.length === records.length) continue;
        const replacement = retained.length > 0
          ? await this.prepareSegment(retained)
          : null;
        if (replacement) preparedPaths.push(replacement.finalPath);
        replacements.push({
          original,
          replacement,
          removedRecords: records.length - retained.length,
          retainedRecords: retained.length,
        });
      }

      const committedReplacementFiles = new Set<string>();
      const replacedOriginals: string[] = [];
      await this.withCatalogLock(async () => {
        const catalog = this.requireCatalog();
        const active = new Map(catalog.segments.map((segment) => [segment.file, segment]));
        const originalsToDelete: string[] = [];
        let changed = false;
        for (const item of replacements) {
          if (!active.has(item.original.file)) continue;
          active.delete(item.original.file);
          originalsToDelete.push(item.original.file);
          if (item.replacement) {
            active.set(item.replacement.metadata.file, item.replacement.metadata);
          }
          changed = true;
        }
        if (!changed) return;
        const next = {
          ...catalog,
          revision: catalog.revision + 1,
          segments: sortSegments([...active.values()]),
        };
        await writeAtomicJson(this.catalogPath, next);
        this.catalog = next;
        for (const file of originalsToDelete) {
          replacedOriginals.push(file);
          this.pendingDeletes.add(file);
        }
        for (const item of replacements) {
          if (originalsToDelete.includes(item.original.file) && item.replacement) {
            committedReplacementFiles.add(item.replacement.metadata.file);
          }
        }
      });

      for (const path of preparedPaths) {
        if (!committedReplacementFiles.has(basename(path))) {
          await unlink(path).catch(() => undefined);
        }
      }
      const committed = replacements.filter((item) =>
        replacedOriginals.includes(item.original.file));
      return {
        scannedSegments: lease.segments.length,
        rewrittenSegments: committed.filter((item) => item.replacement !== null).length,
        removedSegments: committed.filter((item) => item.replacement === null).length,
        removedRecords: committed.reduce((total, item) => total + item.removedRecords, 0),
        retainedRecords: committed.reduce((total, item) => total + item.retainedRecords, 0),
      };
    } catch (error) {
      await Promise.all(preparedPaths.map((path) => unlink(path).catch(() => undefined)));
      throw error;
    } finally {
      await lease.release();
    }
  }

  async createBackup(destination: string): Promise<BackupResult> {
    await this.open();
    const target = validateExternalDirectory(destination, this.directory, "Backup destination");
    await assertMissing(target, "Backup destination already exists");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(dirname(target), `.${basename(target)}.tmp-`));
    await chmod(staging, 0o700);
    const lease = await this.leaseSegments(() => true);
    try {
      const targetSegments = join(staging, SEGMENTS_DIRECTORY);
      await mkdir(targetSegments, { mode: 0o700 });
      for (const segment of lease.segments) {
        const source = this.segmentPath(segment.file);
        const copied = join(targetSegments, segment.file);
        await copyFile(source, copied, fsConstants.COPYFILE_EXCL);
        await chmod(copied, 0o600);
        const bytes = await readFile(copied);
        if (bytes.byteLength !== segment.compressedBytes || sha256(bytes) !== segment.compressedSha256) {
          throw new Error(`Backup verification failed for ${segment.file}`);
        }
      }
      const manifest: BackupManifest = {
        backupFormatVersion: 1,
        createdAt: this.safeNow(),
        catalog: lease.catalog,
        segments: lease.segments.map((segment) => ({
          file: segment.file,
          compressedBytes: segment.compressedBytes,
          compressedSha256: segment.compressedSha256,
        })),
      };
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeDurableFile(join(staging, BACKUP_MANIFEST_FILE), Buffer.from(manifestText));
      await rename(staging, target);
      return {
        destination: target,
        segmentCount: lease.segments.length,
        recordCount: lease.segments.reduce((total, segment) => total + segment.recordCount, 0),
        byteCount: lease.segments.reduce((total, segment) => total + segment.compressedBytes, 0),
        manifestSha256: sha256(manifestText),
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    } finally {
      await lease.release();
    }
  }

  async restoreBackup(source: string): Promise<void> {
    await this.open();
    const backupDirectory = validateExternalDirectory(source, this.directory, "Backup source");
    const sourceMetadata = await lstat(backupDirectory);
    if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
      throw new HistoryValidationError("Backup source must be a real directory");
    }
    const manifest = await readBackupManifest(backupDirectory);
    for (const segment of manifest.catalog.segments) {
      if (segment.recordCount > this.maxBatchRecords
        || segment.uncompressedBytes > this.maxBatchBytes) {
        throw new Error(`Backup segment exceeds configured safety bounds: ${segment.file}`);
      }
    }
    const parent = dirname(this.directory);
    const staging = await mkdtemp(join(parent, `.${basename(this.directory)}.restore-`));
    const stagingSegments = join(staging, SEGMENTS_DIRECTORY);
    await mkdir(stagingSegments, { mode: 0o700 });
    try {
      for (const segment of manifest.segments) {
        assertSafeSegmentFile(segment.file);
        const sourcePath = join(backupDirectory, SEGMENTS_DIRECTORY, segment.file);
        const metadata = await lstat(sourcePath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error(`Backup segment is not a regular file: ${segment.file}`);
        }
        const bytes = await readFile(sourcePath);
        if (bytes.byteLength !== segment.compressedBytes || sha256(bytes) !== segment.compressedSha256) {
          throw new Error(`Backup checksum mismatch: ${segment.file}`);
        }
        const destination = join(stagingSegments, segment.file);
        await writeDurableFile(destination, bytes);
      }
      await writeAtomicJson(join(staging, CATALOG_FILE), manifest.catalog);

      let previous: string | null = null;
      await this.withCatalogLock(async () => {
        if ([...this.pinCounts.values()].some((count) => count > 0)) {
          throw new HistoryStorageBusyError("Cannot restore while query, retention, or backup is active");
        }
        previous = join(parent, `.${basename(this.directory)}.previous-${randomUUID()}`);
        await rename(this.directory, previous);
        try {
          await rename(staging, this.directory);
        } catch (error) {
          await rename(previous, this.directory).catch(() => undefined);
          throw error;
        }
        this.catalog = manifest.catalog;
        this.generation += 1;
        this.pendingDeletes.clear();
      });
      if (previous) await rm(previous, { recursive: true, force: true });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async getMaintenanceCheckpoint(name: string): Promise<number | null> {
    await this.open();
    validateCheckpointName(name);
    return this.withCatalogLock(async () =>
      this.requireCatalog().maintenanceCheckpoints[name] ?? null);
  }

  async setMaintenanceCheckpoint(name: string, timestamp: number): Promise<void> {
    await this.open();
    validateCheckpointName(name);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new HistoryValidationError("Maintenance checkpoint must be a non-negative safe integer");
    }
    await this.withCatalogLock(async () => {
      const catalog = this.requireCatalog();
      const current = catalog.maintenanceCheckpoints[name];
      if (current !== undefined && timestamp < current) {
        throw new HistoryValidationError("Maintenance checkpoint cannot move backwards");
      }
      if (current === timestamp) return;
      const next = {
        ...catalog,
        revision: catalog.revision + 1,
        maintenanceCheckpoints: {
          ...catalog.maintenanceCheckpoints,
          [name]: timestamp,
        },
      };
      await writeAtomicJson(this.catalogPath, next);
      this.catalog = next;
    });
  }

  private async initialize(): Promise<void> {
    const created = await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(this.directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new HistoryValidationError("History directory must be a real directory");
    }
    if (created) await chmod(this.directory, 0o700);
    await mkdir(this.segmentsDirectory, { recursive: true, mode: 0o700 });

    let catalog: HistoryCatalog;
    try {
      catalog = parseCatalog(await readFile(this.catalogPath, "utf8"));
    } catch (error) {
      if (!isMissing(error)) throw error;
      catalog = {
        formatVersion: STORE_FORMAT_VERSION,
        historySchemaVersion: HISTORY_SCHEMA_VERSION,
        storeId: randomUUID(),
        createdAt: this.safeNow(),
        revision: 0,
        maintenanceCheckpoints: {},
        segments: [],
      };
      await writeAtomicJson(this.catalogPath, catalog);
    }
    for (const segment of catalog.segments) {
      assertSafeSegmentFile(segment.file);
      if (segment.recordCount > this.maxBatchRecords
        || segment.uncompressedBytes > this.maxBatchBytes) {
        throw new Error(`Catalog segment exceeds configured safety bounds: ${segment.file}`);
      }
      const metadata = await lstat(this.segmentPath(segment.file));
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Catalog segment is not a regular file: ${segment.file}`);
      }
      if (metadata.size !== segment.compressedBytes) {
        throw new Error(`Catalog segment size mismatch: ${segment.file}`);
      }
    }
    this.catalog = catalog;
    await this.cleanupOrphans(catalog);
  }

  private async cleanupOrphans(catalog: HistoryCatalog): Promise<void> {
    const active = new Set(catalog.segments.map((segment) => segment.file));
    const entries = await readdir(this.segmentsDirectory, { withFileTypes: true });
    await Promise.all(entries.flatMap((entry) => {
      if (active.has(entry.name)) return [];
      if (!entry.name.startsWith("segment-") && !entry.name.includes(".tmp-")) return [];
      if (!entry.isFile() && !entry.isSymbolicLink()) return [];
      return [unlink(this.segmentPath(entry.name)).catch(() => undefined)];
    }));
  }

  private async prepareSegment(records: readonly HistoricalRecord[]): Promise<PreparedSegment> {
    const content = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const uncompressedBytes = Buffer.byteLength(content);
    if (uncompressedBytes > this.maxBatchBytes) {
      throw new HistoryValidationError(
        `Batch serializes to ${uncompressedBytes} bytes; maximum is ${this.maxBatchBytes}`,
      );
    }
    const compressed = await gzipAsync(Buffer.from(content), { level: this.compressionLevel });
    const minTimestamp = Math.min(...records.map(historyTimestamp));
    const maxTimestamp = Math.max(...records.map(historyTimestamp));
    const id = randomUUID();
    const file = `segment-${String(minTimestamp).padStart(16, "0")}-${String(maxTimestamp).padStart(16, "0")}-${id}.ndjson.gz`;
    assertSafeSegmentFile(file);
    const finalPath = this.segmentPath(file);
    const temporary = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeDurableFile(temporary, compressed);
      await rename(temporary, finalPath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return {
      finalPath,
      metadata: {
        id,
        file,
        recordCount: records.length,
        minTimestamp,
        maxTimestamp,
        minCaptureSequence: Math.min(...records.map((record) => record.captureSequence)),
        maxCaptureSequence: Math.max(...records.map((record) => record.captureSequence)),
        exchanges: ["binance"],
        symbols: sortedUnique(records.map((record) => record.symbol)),
        captureIds: sortedUnique(records.map((record) => record.captureId)),
        kinds: sortedUnique(records.map((record) => record.kind)),
        uncompressedBytes,
        compressedBytes: compressed.byteLength,
        compressedSha256: sha256(compressed),
        contentSha256: sha256(content),
      },
    };
  }

  private async readSegment(segment: HistorySegmentMetadata): Promise<HistoricalRecord[]> {
    const compressed = await readFile(this.segmentPath(segment.file));
    if (compressed.byteLength !== segment.compressedBytes || sha256(compressed) !== segment.compressedSha256) {
      throw new Error(`History segment checksum mismatch: ${segment.file}`);
    }
    const content = await gunzipAsync(compressed, { maxOutputLength: this.maxBatchBytes });
    if (content.byteLength !== segment.uncompressedBytes || sha256(content) !== segment.contentSha256) {
      throw new Error(`History segment content checksum mismatch: ${segment.file}`);
    }
    const lines = content.toString("utf8").split("\n").filter(Boolean);
    if (lines.length !== segment.recordCount) {
      throw new Error(`History segment record count mismatch: ${segment.file}`);
    }
    return lines.map((line) => {
      const record = JSON.parse(line) as HistoricalRecord;
      validateHistoricalRecord(record);
      return record;
    });
  }

  private async leaseSegments(
    predicate: (segment: HistorySegmentMetadata) => boolean,
  ): Promise<SegmentLease> {
    return this.withCatalogLock(async () => {
      const catalog = cloneCatalog(this.requireCatalog());
      const segments = catalog.segments.filter(predicate);
      for (const segment of segments) {
        this.pinCounts.set(segment.file, (this.pinCounts.get(segment.file) ?? 0) + 1);
      }
      let released = false;
      return {
        catalog,
        segments,
        release: async () => {
          if (released) return;
          released = true;
          const deletable = await this.withCatalogLock(async () => {
            const result: string[] = [];
            for (const segment of segments) {
              const count = (this.pinCounts.get(segment.file) ?? 1) - 1;
              if (count > 0) this.pinCounts.set(segment.file, count);
              else {
                this.pinCounts.delete(segment.file);
                if (this.pendingDeletes.delete(segment.file)) result.push(segment.file);
              }
            }
            return result;
          });
          await Promise.all(deletable.map((file) => unlink(this.segmentPath(file)).catch(() => undefined)));
        },
      };
    });
  }

  private segmentPath(file: string): string {
    assertSafeSegmentFile(file);
    return join(this.segmentsDirectory, file);
  }

  private requireCatalog(): HistoryCatalog {
    if (!this.catalog) throw new Error("History store is not open");
    return this.catalog;
  }

  private safeNow(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new Error("History clock is invalid");
    return Math.trunc(value);
  }

  private async withCatalogLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

type NormalizedQuery = HistoryQuery & { limit: number };

function validateQuery(query: HistoryQuery, limits: Readonly<HistoryQueryLimits>): NormalizedQuery {
  if (!query || typeof query !== "object") throw new HistoryValidationError("Query is required");
  if (query.exchange !== "binance") throw new HistoryValidationError("Unsupported exchange");
  if (!/^[A-Z0-9_.-]{1,48}$/.test(query.symbol)) throw new HistoryValidationError("Invalid symbol");
  if (!Number.isSafeInteger(query.from) || query.from < 0
    || !Number.isSafeInteger(query.to) || query.to <= query.from) {
    throw new HistoryValidationError("Query must use a valid [from, to) range");
  }
  if (query.to - query.from > limits.maxRangeMs) {
    throw new HistoryQueryLimitError(
      `Query range exceeds ${limits.maxRangeMs} ms`,
      "RANGE_LIMIT",
    );
  }
  const limit = query.limit ?? limits.defaultRows;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new HistoryValidationError("Query limit must be a positive safe integer");
  }
  if (limit > limits.maxRows) {
    throw new HistoryQueryLimitError(`Query limit exceeds ${limits.maxRows}`, "ROW_LIMIT");
  }
  if (query.kinds && (query.kinds.length < 1 || query.kinds.some((kind) =>
    !["trade", "depth_snapshot", "depth_delta", "metric_frame"].includes(kind)))) {
    throw new HistoryValidationError("Query contains an invalid record kind");
  }
  if (query.captureId !== undefined && (!query.captureId || query.captureId.length > 128)) {
    throw new HistoryValidationError("Invalid captureId filter");
  }
  if (query.after) {
    if (!Number.isSafeInteger(query.after.timestamp) || query.after.timestamp < 0
      || !Number.isSafeInteger(query.after.captureSequence) || query.after.captureSequence < 1
      || !query.after.captureId
      || !query.after.recordKey) {
      throw new HistoryValidationError("Invalid history cursor");
    }
  }
  return { ...query, limit };
}

function segmentMatches(segment: HistorySegmentMetadata, query: NormalizedQuery): boolean {
  if (segment.maxTimestamp < query.from || segment.minTimestamp >= query.to) return false;
  if (!segment.symbols.includes(query.symbol)) return false;
  if (query.captureId && !segment.captureIds.includes(query.captureId)) return false;
  if (query.kinds && !query.kinds.some((kind) => segment.kinds.includes(kind))) return false;
  return true;
}

function recordMatches(record: HistoricalRecord, query: NormalizedQuery): boolean {
  const timestamp = historyTimestamp(record);
  return record.exchange === query.exchange
    && record.symbol === query.symbol
    && timestamp >= query.from
    && timestamp < query.to
    && (!query.kinds || query.kinds.includes(record.kind))
    && (!query.captureId || record.captureId === query.captureId)
    && (query.resolutionMs === undefined
      || (record.kind === "metric_frame" && record.resolutionMs === query.resolutionMs))
    && (!query.after || compareCursor(record, query.after) > 0);
}

function shouldRetain(
  record: HistoricalRecord,
  policy: HistoryRetentionPolicy,
  now: number,
): boolean {
  const retention = record.kind === "trade"
    ? policy.tradeMs
    : record.kind === "depth_snapshot"
      ? policy.depthSnapshotMs
      : record.kind === "depth_delta"
        ? policy.depthDeltaMs
        : policy.metricFrameMs[record.resolutionMs];
  return historyTimestamp(record) >= now - retention;
}

function validateRetentionPolicy(policy: HistoryRetentionPolicy): void {
  const values = [
    policy.tradeMs,
    policy.depthSnapshotMs,
    policy.depthDeltaMs,
    policy.metricFrameMs?.[1_000],
    policy.metricFrameMs?.[5_000],
    policy.metricFrameMs?.[60_000],
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value! < 0)) {
    throw new HistoryValidationError("Retention values must be non-negative safe integers");
  }
}

function cloneRetentionPolicy(policy: Readonly<HistoryRetentionPolicy>): HistoryRetentionPolicy {
  return { ...policy, metricFrameMs: { ...policy.metricFrameMs } };
}

function normalizeLimits(overrides: Partial<HistoryQueryLimits> | undefined): HistoryQueryLimits {
  const limits = { ...DEFAULT_HISTORY_QUERY_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) positiveInteger(value, value, name);
  if (limits.defaultRows > limits.maxRows) {
    throw new TypeError("defaultRows cannot exceed maxRows");
  }
  return limits;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return result;
}

function sortSegments(segments: HistorySegmentMetadata[]): HistorySegmentMetadata[] {
  return segments.sort((left, right) => left.minTimestamp - right.minTimestamp
    || left.maxTimestamp - right.maxTimestamp
    || compareText(left.id, right.id));
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneCatalog(catalog: HistoryCatalog): HistoryCatalog {
  return structuredClone(catalog);
}

function parseCatalog(text: string): HistoryCatalog {
  const value = JSON.parse(text) as HistoryCatalog;
  if (!value || value.formatVersion !== STORE_FORMAT_VERSION
    || value.historySchemaVersion !== HISTORY_SCHEMA_VERSION
    || typeof value.storeId !== "string"
    || !Number.isSafeInteger(value.revision)
    || !Array.isArray(value.segments)) {
    throw new Error("Unsupported or malformed history catalog");
  }
  if (value.maintenanceCheckpoints === undefined) value.maintenanceCheckpoints = {};
  if (!value.maintenanceCheckpoints || typeof value.maintenanceCheckpoints !== "object"
    || Array.isArray(value.maintenanceCheckpoints)) {
    throw new Error("Malformed maintenance checkpoints");
  }
  for (const [name, timestamp] of Object.entries(value.maintenanceCheckpoints)) {
    validateCheckpointName(name);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error(`Malformed maintenance checkpoint: ${name}`);
    }
  }
  const files = new Set<string>();
  for (const segment of value.segments) {
    validateSegmentMetadata(segment);
    if (files.has(segment.file)) throw new Error(`Duplicate catalog segment: ${segment.file}`);
    files.add(segment.file);
  }
  value.segments = sortSegments(value.segments);
  return value;
}

function validateSegmentMetadata(segment: HistorySegmentMetadata): void {
  if (!segment || typeof segment !== "object") throw new Error("Malformed segment metadata");
  assertSafeSegmentFile(segment.file);
  if (!segment.id || !Number.isSafeInteger(segment.recordCount) || segment.recordCount < 1
    || !Number.isSafeInteger(segment.minTimestamp) || segment.minTimestamp < 0
    || !Number.isSafeInteger(segment.maxTimestamp) || segment.maxTimestamp < segment.minTimestamp
    || !Number.isSafeInteger(segment.compressedBytes) || segment.compressedBytes < 1
    || !Number.isSafeInteger(segment.uncompressedBytes) || segment.uncompressedBytes < 1
    || !/^[a-f0-9]{64}$/.test(segment.compressedSha256)
    || !/^[a-f0-9]{64}$/.test(segment.contentSha256)
    || !Array.isArray(segment.symbols)
    || !Array.isArray(segment.captureIds)
    || !Array.isArray(segment.kinds)) {
    throw new Error(`Malformed segment metadata: ${segment.file}`);
  }
}

async function readBackupManifest(directory: string): Promise<BackupManifest> {
  const value = JSON.parse(await readFile(join(directory, BACKUP_MANIFEST_FILE), "utf8")) as BackupManifest;
  if (!value || value.backupFormatVersion !== 1 || !Array.isArray(value.segments)) {
    throw new Error("Unsupported or malformed history backup");
  }
  // Round-trip through the catalog validator rather than trusting backup JSON.
  value.catalog = parseCatalog(JSON.stringify(value.catalog));
  const catalogFiles = new Set(value.catalog.segments.map((segment) => segment.file));
  if (value.segments.length !== catalogFiles.size) throw new Error("Backup catalog mismatch");
  for (const segment of value.segments) {
    assertSafeSegmentFile(segment.file);
    const catalogSegment = value.catalog.segments.find((item) => item.file === segment.file);
    if (!catalogSegment
      || !Number.isSafeInteger(segment.compressedBytes) || segment.compressedBytes < 1
      || !/^[a-f0-9]{64}$/.test(segment.compressedSha256)
      || segment.compressedBytes !== catalogSegment.compressedBytes
      || segment.compressedSha256 !== catalogSegment.compressedSha256) {
      throw new Error(`Malformed backup segment: ${segment.file}`);
    }
  }
  return value;
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeDurableFile(temporary, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeDurableFile(path: string, content: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms do not permit fsync on directories; file+rename remains atomic.
  }
}

function validateExternalDirectory(path: string, store: string, label: string): string {
  if (!path?.trim() || path.includes("\0")) throw new HistoryValidationError(`${label} is invalid`);
  const resolved = resolve(path);
  if (isContained(resolved, store) || isContained(store, resolved) || resolved === store) {
    throw new HistoryValidationError(`${label} must be outside the history store`);
  }
  return resolved;
}

function isContained(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function assertMissing(path: string, message: string): Promise<void> {
  try {
    await stat(path);
    throw new HistoryValidationError(message);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function assertSafeSegmentFile(file: string): void {
  if (basename(file) !== file || !/^segment-[a-zA-Z0-9_.-]+\.ndjson\.gz$/.test(file)) {
    throw new Error(`Unsafe history segment path: ${file}`);
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateCheckpointName(name: string): void {
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(name)) {
    throw new HistoryValidationError("Invalid maintenance checkpoint name");
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
