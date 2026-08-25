import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
import type {
  RawCaptureEnvelope,
  RawCaptureManifest,
  RawCaptureStream,
} from "../recording/rawCapture.js";
import {
  RAW_CAPTURE_ADAPTER_VERSION,
  RAW_CAPTURE_ANALYTICS_VERSION,
} from "../recording/rawCapture.js";
import { SCHEMA_VERSION } from "../types.js";

const MANIFEST_SUFFIX = ".manifest.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 1_000_000;

export interface CaptureSegment {
  captureId: string;
  symbol: string;
  startedAt: number;
  closedAt: number;
  recordCount: number;
  complete: boolean;
  dataBytes: number;
  dataSha256: string;
  contentSha256: string;
  dataPath: string;
  manifestPath: string;
  manifest: RawCaptureManifest;
}

export interface CaptureCatalogProblem {
  manifestPath: string;
  message: string;
}

export interface CaptureCatalogSnapshot {
  scannedAt: number;
  segments: CaptureSegment[];
  problems: CaptureCatalogProblem[];
  checksum: string;
}

export interface CaptureCatalogQuery {
  symbol?: string;
  captureId?: string;
  from?: number;
  to?: number;
  includeIncomplete?: boolean;
}

export interface ReadCaptureOptions {
  from?: number;
  to?: number;
  streams?: readonly RawCaptureStream[];
  verifyChecksums?: boolean;
  maxLineBytes?: number;
  maxRecords?: number;
}

export interface CaptureVerification {
  captureId: string;
  records: number;
  firstSequence: number | null;
  lastSequence: number | null;
  compressedSha256: string;
  contentSha256: string;
}

/**
 * Discovers immutable Phase-1 capture segments without trusting paths contained
 * in a manifest. Catalog refresh is metadata-only; bytes are authenticated when
 * a segment is opened for replay.
 */
export class RawCaptureCatalog {
  readonly directory: string;
  private snapshotValue: CaptureCatalogSnapshot = {
    scannedAt: 0,
    segments: [],
    problems: [],
    checksum: sha256Text("empty-capture-catalog\n"),
  };

  constructor(directory: string) {
    if (!directory.trim() || directory.includes("\0")) {
      throw new TypeError("Capture catalog directory must be a non-empty path");
    }
    this.directory = resolve(directory);
  }

  get snapshot(): CaptureCatalogSnapshot {
    return cloneSnapshot(this.snapshotValue);
  }

  async refresh(): Promise<CaptureCatalogSnapshot> {
    const directoryMetadata = await lstat(this.directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error("Capture catalog path must be a real directory");
    }

    const entries = await readdir(this.directory, { withFileTypes: true });
    const manifestNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(MANIFEST_SUFFIX))
      .map((entry) => entry.name)
      .sort();
    const segments: CaptureSegment[] = [];
    const problems: CaptureCatalogProblem[] = [];

    for (const manifestName of manifestNames) {
      const manifestPath = join(this.directory, manifestName);
      try {
        segments.push(await loadCaptureSegment(this.directory, manifestPath));
      } catch (error) {
        problems.push({ manifestPath, message: errorMessage(error) });
      }
    }

    segments.sort(compareSegments);
    this.snapshotValue = {
      scannedAt: Date.now(),
      segments,
      problems,
      checksum: catalogChecksum(segments),
    };
    return this.snapshot;
  }

  list(query: CaptureCatalogQuery = {}): CaptureSegment[] {
    const normalized = normalizeCatalogQuery(query);
    return this.snapshotValue.segments
      .filter((segment) => normalized.includeIncomplete || segment.complete)
      .filter((segment) => !normalized.symbol || segment.symbol === normalized.symbol)
      .filter((segment) => !normalized.captureId || segment.captureId === normalized.captureId)
      .filter((segment) => segment.closedAt >= normalized.from && segment.startedAt <= normalized.to)
      .map(cloneSegment);
  }

  get(captureId: string): CaptureSegment | undefined {
    const segment = this.snapshotValue.segments.find((candidate) => candidate.captureId === captureId);
    return segment ? cloneSegment(segment) : undefined;
  }

  checksum(query: CaptureCatalogQuery = {}): string {
    const normalized = normalizeCatalogQuery(query);
    const segments = this.list(normalized);
    const hash = createHash("sha256");
    hash.update(`raw-capture-catalog-v1\n${normalized.symbol ?? "*"}\n`);
    hash.update(`${normalized.captureId ?? "*"}\n`);
    hash.update(`${normalized.from}\n${normalized.to}\n`);
    for (const segment of segments) {
      hash.update(`${segment.startedAt}\0${segment.captureId}\0${segment.dataSha256}\0`);
      hash.update(`${segment.contentSha256}\0${segment.recordCount}\0`);
      hash.update(`${manifestDigest(segment.manifest)}\n`);
    }
    return hash.digest("hex");
  }

  async *read(
    query: CaptureCatalogQuery = {},
    options: ReadCaptureOptions = {},
  ): AsyncGenerator<RawCaptureEnvelope> {
    let records = 0;
    const maxRecords = positiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS);
    const from = finiteTimestamp(options.from, finiteTimestamp(query.from, 0));
    const to = finiteTimestamp(options.to, finiteTimestamp(query.to, Number.MAX_SAFE_INTEGER));
    if (to < from) throw new RangeError("Capture replay `to` must be >= `from`");

    for (const segment of this.list(query)) {
      for await (const envelope of readCaptureSegment(segment, options)) {
        if (envelope.capturedAt < from || envelope.capturedAt > to) continue;
        records += 1;
        if (records > maxRecords) {
          throw new Error(`Capture replay exceeded the ${maxRecords} record query limit`);
        }
        yield envelope;
      }
    }
  }
}

/** Reads one gzip segment in captureSequence order and authenticates both layers. */
export async function* readCaptureSegment(
  segment: CaptureSegment,
  options: ReadCaptureOptions = {},
): AsyncGenerator<RawCaptureEnvelope> {
  const maxLineBytes = positiveInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES);
  const maxRecords = positiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS);
  const streams = options.streams ? new Set(options.streams) : null;
  const verifyChecksums = options.verifyChecksums !== false;

  const segmentDirectory = dirname(segment.manifestPath);
  await assertRegularContainedFile(segment.manifestPath, segmentDirectory);
  await assertRegularContainedFile(segment.dataPath, segmentDirectory);
  if (verifyChecksums) {
    const compressed = await hashFile(segment.dataPath);
    if (compressed.bytes !== segment.dataBytes) {
      throw new Error(
        `Capture ${segment.captureId} byte length mismatch: expected ${segment.dataBytes}, got ${compressed.bytes}`,
      );
    }
    if (compressed.sha256 !== segment.dataSha256) {
      throw new Error(`Capture ${segment.captureId} compressed checksum mismatch`);
    }
  }

  const contentHash = createHash("sha256");
  const gzipInput = createReadStream(segment.dataPath);
  const uncompressed = gzipInput.pipe(createGunzip());
  let pending = Buffer.alloc(0);
  let expectedSequence = 1;
  let records = 0;

  try {
    for await (const rawChunk of uncompressed) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      contentHash.update(chunk);
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      if (pending.length > maxLineBytes && pending.indexOf(0x0a) < 0) {
        throw new Error(`Capture ${segment.captureId} contains an oversized NDJSON record`);
      }

      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (line.length > maxLineBytes) {
          throw new Error(`Capture ${segment.captureId} contains an oversized NDJSON record`);
        }
        if (line.length > 0) {
          const envelope = parseCaptureEnvelope(line, segment, expectedSequence);
          expectedSequence += 1;
          records += 1;
          if (records > maxRecords) {
            throw new Error(`Capture ${segment.captureId} exceeded the ${maxRecords} record limit`);
          }
          if (!streams || streams.has(envelope.stream)) yield envelope;
        }
        newline = pending.indexOf(0x0a);
      }
    }

    if (pending.length > 0) {
      if (pending.length > maxLineBytes) {
        throw new Error(`Capture ${segment.captureId} contains an oversized NDJSON record`);
      }
      const envelope = parseCaptureEnvelope(pending, segment, expectedSequence);
      records += 1;
      if (records > maxRecords) {
        throw new Error(`Capture ${segment.captureId} exceeded the ${maxRecords} record limit`);
      }
      if (!streams || streams.has(envelope.stream)) yield envelope;
    }
  } finally {
    uncompressed.destroy();
    gzipInput.destroy();
  }

  const contentSha256 = contentHash.digest("hex");
  if (verifyChecksums && contentSha256 !== segment.contentSha256) {
    throw new Error(`Capture ${segment.captureId} content checksum mismatch`);
  }
  if (records !== segment.recordCount) {
    throw new Error(
      `Capture ${segment.captureId} record count mismatch: expected ${segment.recordCount}, got ${records}`,
    );
  }
}

export async function verifyCaptureSegment(segment: CaptureSegment): Promise<CaptureVerification> {
  let records = 0;
  let firstSequence: number | null = null;
  let lastSequence: number | null = null;
  for await (const envelope of readCaptureSegment(segment, { verifyChecksums: true })) {
    records += 1;
    firstSequence ??= envelope.captureSequence;
    lastSequence = envelope.captureSequence;
  }
  return {
    captureId: segment.captureId,
    records,
    firstSequence,
    lastSequence,
    compressedSha256: segment.dataSha256,
    contentSha256: segment.contentSha256,
  };
}

async function loadCaptureSegment(directory: string, manifestPath: string): Promise<CaptureSegment> {
  await assertRegularContainedFile(manifestPath, directory);
  const manifestMetadata = await stat(manifestPath);
  if (manifestMetadata.size > MAX_MANIFEST_BYTES) {
    throw new Error("Capture manifest exceeds the 1 MiB limit");
  }
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = parseManifest(parsed);
  if (manifest.dataFile !== basename(manifest.dataFile) || manifest.dataFile.includes("\0")) {
    throw new Error("Capture manifest dataFile must be a local basename");
  }
  const dataPath = join(directory, manifest.dataFile);
  await assertRegularContainedFile(dataPath, directory);
  return {
    captureId: manifest.captureId,
    symbol: manifest.symbol.toUpperCase(),
    startedAt: manifest.startedAt,
    closedAt: manifest.closedAt,
    recordCount: manifest.stats.writtenRecords,
    complete: manifest.complete,
    dataBytes: manifest.dataBytes!,
    dataSha256: manifest.sha256!,
    contentSha256: manifest.contentChecksum.value,
    dataPath,
    manifestPath,
    manifest,
  };
}

function parseManifest(value: unknown): RawCaptureManifest {
  if (!isObject(value) || value.captureSchemaVersion !== 1) {
    throw new Error("Unsupported or malformed capture manifest");
  }
  const stats = value.stats;
  const sequence = value.sequence;
  const checksum = value.checksum;
  const contentChecksum = value.contentChecksum;
  if (
    typeof value.captureId !== "string" || !value.captureId
    || typeof value.symbol !== "string" || !value.symbol
    || !nonNegativeInteger(value.startedAt)
    || !nonNegativeInteger(value.closedAt)
    || value.closedAt < value.startedAt
    || typeof value.complete !== "boolean"
    || value.eventSchemaVersion !== SCHEMA_VERSION
    || value.adapterVersion !== RAW_CAPTURE_ADAPTER_VERSION
    || value.analyticsVersion !== RAW_CAPTURE_ANALYTICS_VERSION
    || !validEndpoints(value.endpoints)
    || !isCloseReason(value.closeReason)
    || typeof value.dataFile !== "string"
    || value.compression !== "gzip"
    || !nonNegativeInteger(value.dataBytes)
    || !isSha256(value.sha256)
    || !isObject(checksum)
    || checksum.algorithm !== "sha256"
    || checksum.scope !== "compressed-file"
    || checksum.value !== value.sha256
    || !isObject(contentChecksum)
    || contentChecksum.algorithm !== "sha256"
    || contentChecksum.scope !== "uncompressed-ndjson"
    || !isSha256(contentChecksum.value)
    || !isObject(stats)
    || !nonNegativeInteger(stats.writtenRecords)
    || !isObject(sequence)
    || sequence.field !== "captureSequence"
    || sequence.contiguous !== true
    || (stats.writtenRecords === 0
      ? sequence.first !== null || sequence.lastWritten !== null
      : sequence.first !== 1 || sequence.lastWritten !== stats.writtenRecords)
  ) {
    throw new Error("Capture manifest failed integrity validation");
  }
  return value as unknown as RawCaptureManifest;
}

function parseCaptureEnvelope(
  line: Buffer,
  segment: CaptureSegment,
  expectedSequence: number,
): RawCaptureEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    throw new Error(`Capture ${segment.captureId} contains invalid NDJSON`);
  }
  if (!isObject(value)
    || value.captureSequence !== expectedSequence
    || !nonNegativeInteger(value.capturedAt)
    || value.exchange !== "binance"
    || value.symbol !== segment.symbol
    || (value.source !== "binance" && value.source !== "demo")
    || !isRawCaptureStream(value.stream)
    || typeof value.connectionId !== "string"
    || typeof value.payload !== "string") {
    throw new Error(
      `Capture ${segment.captureId} has malformed or non-contiguous record ${expectedSequence}`,
    );
  }
  return value as unknown as RawCaptureEnvelope;
}

async function assertRegularContainedFile(path: string, directory: string): Promise<void> {
  const root = resolve(directory);
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error("Capture artifact resolves outside its catalog directory");
  }
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Capture artifact must be a regular file, not a symbolic link");
  }
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function normalizeCatalogQuery(query: CaptureCatalogQuery): Required<Omit<CaptureCatalogQuery, "symbol" | "captureId">> & {
  symbol?: string;
  captureId?: string;
} {
  const from = finiteTimestamp(query.from, 0);
  const to = finiteTimestamp(query.to, Number.MAX_SAFE_INTEGER);
  if (to < from) throw new RangeError("Capture catalog `to` must be >= `from`");
  return {
    ...(query.symbol ? { symbol: query.symbol.toUpperCase() } : {}),
    ...(query.captureId ? { captureId: query.captureId } : {}),
    from,
    to,
    includeIncomplete: query.includeIncomplete === true,
  };
}

function compareSegments(left: CaptureSegment, right: CaptureSegment): number {
  return left.startedAt - right.startedAt
    || left.captureId.localeCompare(right.captureId)
    || left.manifestPath.localeCompare(right.manifestPath);
}

function catalogChecksum(segments: readonly CaptureSegment[]): string {
  const hash = createHash("sha256");
  hash.update("raw-capture-catalog-v1\n");
  for (const segment of segments) {
    hash.update(`${segment.startedAt}\0${segment.captureId}\0${segment.dataSha256}\0`);
    hash.update(`${segment.contentSha256}\0${segment.recordCount}\0`);
    hash.update(`${manifestDigest(segment.manifest)}\n`);
  }
  return hash.digest("hex");
}

function cloneSnapshot(snapshot: CaptureCatalogSnapshot): CaptureCatalogSnapshot {
  return {
    scannedAt: snapshot.scannedAt,
    checksum: snapshot.checksum,
    segments: snapshot.segments.map(cloneSegment),
    problems: snapshot.problems.map((problem) => ({ ...problem })),
  };
}

function cloneSegment(segment: CaptureSegment): CaptureSegment {
  return {
    ...segment,
    manifest: structuredClone(segment.manifest),
  };
}

function isRawCaptureStream(value: unknown): value is RawCaptureStream {
  return value === "depth" || value === "trade" || value === "snapshot" || value === "status";
}

function validEndpoints(value: unknown): boolean {
  if (!isObject(value)) return false;
  const allowed = new Set(["snapshot", "depth", "trade"]);
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, endpoint]) =>
    allowed.has(key)
    && typeof endpoint === "string"
    && endpoint.length > 0
    && endpoint.length <= 2_048);
}

function isCloseReason(value: unknown): boolean {
  return value === "manual"
    || value === "gateway_shutdown"
    || value === "duration_limit"
    || value === "size_limit"
    || value === "storage_failure";
}

function manifestDigest(manifest: RawCaptureManifest): string {
  // Recorder diagnostics include absolute local paths. They are not replay
  // semantics and would make the same immutable capture hash differently
  // after restore/move or across machines.
  const stableStats = Object.fromEntries(
    Object.entries(manifest.stats).filter(([key]) =>
      key !== "dataPath" && key !== "manifestPath"),
  );
  return sha256Text(JSON.stringify({ ...manifest, stats: stableStats }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function finiteTimestamp(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
