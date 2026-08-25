import type {
  AggressorSide,
  MetricFrame,
  TrendSignal,
} from "../types.js";

export const HISTORY_SCHEMA_VERSION = 1 as const;
export const HISTORY_RESOLUTIONS_MS = [1_000, 5_000, 60_000] as const;

export type HistoryResolutionMs = (typeof HISTORY_RESOLUTIONS_MS)[number];
export type HistoricalRecordKind =
  | "trade"
  | "depth_snapshot"
  | "depth_delta"
  | "metric_frame";

/** Price is always an integer number of venue ticks; quantity is canonical decimal text. */
export type StoredPriceLevel = [priceTicks: number, quantity: string];

export interface HistoricalRecordBase {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  exchange: "binance";
  symbol: string;
  captureId: string;
  captureSequence: number;
  exchangeTimestamp: number;
  receivedTimestamp: number;
}

export interface StoredTrade extends HistoricalRecordBase {
  kind: "trade";
  tradeId: string;
  priceTicks: number;
  tickSize: number;
  quantity: string;
  side: AggressorSide;
}

export interface StoredDepthSnapshot extends HistoricalRecordBase {
  kind: "depth_snapshot";
  lastUpdateId: number;
  tickSize: number;
  bids: StoredPriceLevel[];
  asks: StoredPriceLevel[];
  stateFingerprint: string;
}

export interface StoredDepthDelta extends HistoricalRecordBase {
  kind: "depth_delta";
  sequenceStart: number;
  sequenceEnd: number;
  previousSequence?: number;
  tickSize: number;
  bids: StoredPriceLevel[];
  asks: StoredPriceLevel[];
}

export interface StoredMetricFrame extends HistoricalRecordBase {
  kind: "metric_frame";
  resolutionMs: HistoryResolutionMs;
  intervalStart: number;
  intervalEnd: number;
  intervalBuyVolume: number;
  intervalSellVolume: number;
  intervalTradeCount: number;
  metric: MetricFrame;
  trend: TrendSignal;
  bookFingerprint: string | null;
  analyticsFingerprint: string | null;
}

export type HistoricalRecord =
  | StoredTrade
  | StoredDepthSnapshot
  | StoredDepthDelta
  | StoredMetricFrame;

export interface HistoryCursor {
  timestamp: number;
  captureSequence: number;
  kind: HistoricalRecordKind;
  captureId: string;
  recordKey: string;
}

/** `from` is inclusive and `to` is exclusive. */
export interface HistoryQuery {
  exchange: "binance";
  symbol: string;
  from: number;
  to: number;
  kinds?: HistoricalRecordKind[];
  captureId?: string;
  resolutionMs?: HistoryResolutionMs;
  after?: HistoryCursor;
  limit?: number;
}

export interface HistoryQueryResult {
  records: HistoricalRecord[];
  truncated: boolean;
  nextCursor: HistoryCursor | null;
  scannedSegments: number;
  scannedCompressedBytes: number;
}

export interface HistoryQueryLimits {
  defaultRows: number;
  maxRows: number;
  maxRangeMs: number;
  maxScannedSegments: number;
  maxScannedCompressedBytes: number;
}

export const DEFAULT_HISTORY_QUERY_LIMITS: Readonly<HistoryQueryLimits> = {
  defaultRows: 10_000,
  maxRows: 100_000,
  maxRangeMs: 24 * 60 * 60 * 1_000,
  maxScannedSegments: 512,
  maxScannedCompressedBytes: 256 * 1024 * 1024,
};

export interface AppendResult {
  segmentId: string;
  recordCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
}

export interface HistoryRetentionPolicy {
  tradeMs: number;
  depthSnapshotMs: number;
  depthDeltaMs: number;
  metricFrameMs: Record<HistoryResolutionMs, number>;
}

export const DEFAULT_HISTORY_RETENTION: Readonly<HistoryRetentionPolicy> = {
  tradeMs: 90 * 24 * 60 * 60 * 1_000,
  depthSnapshotMs: 30 * 24 * 60 * 60 * 1_000,
  depthDeltaMs: 14 * 24 * 60 * 60 * 1_000,
  metricFrameMs: {
    1_000: 365 * 24 * 60 * 60 * 1_000,
    5_000: 365 * 24 * 60 * 60 * 1_000,
    60_000: 3 * 365 * 24 * 60 * 60 * 1_000,
  },
};

export interface RetentionResult {
  scannedSegments: number;
  rewrittenSegments: number;
  removedSegments: number;
  removedRecords: number;
  retainedRecords: number;
}

export interface BackupResult {
  destination: string;
  segmentCount: number;
  recordCount: number;
  byteCount: number;
  manifestSha256: string;
}

export interface HistoryStore {
  open(): Promise<void>;
  appendBatch(records: readonly HistoricalRecord[]): Promise<AppendResult>;
  query(query: HistoryQuery): Promise<HistoryQueryResult>;
  runRetention(
    policy?: HistoryRetentionPolicy,
    now?: number,
  ): Promise<RetentionResult>;
  createBackup(destination: string): Promise<BackupResult>;
  restoreBackup(source: string): Promise<void>;
}

export interface MaintenanceCheckpointStore {
  getMaintenanceCheckpoint(name: string): Promise<number | null>;
  setMaintenanceCheckpoint(name: string, timestamp: number): Promise<void>;
}

/** Metadata belongs in PostgreSQL; high-volume frames never do. */
export interface ReplaySessionMetadataStore {
  createSession(metadata: ReplaySessionMetadata): Promise<void>;
  getSession(id: string): Promise<ReplaySessionMetadata | null>;
  updateSession(id: string, patch: Partial<ReplaySessionMetadata>): Promise<void>;
}

export interface ReplaySessionMetadata {
  id: string;
  datasetId: string;
  exchange: "binance";
  symbol: string;
  from: number;
  to: number;
  cursor: HistoryCursor | null;
  speed: number;
  state: "paused" | "playing" | "complete" | "failed";
  expectedChecksum: string | null;
  actualChecksum: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Raw captures are immutable objects and are referenced by metadata, not embedded there. */
export interface RawCaptureObjectStore {
  putCapture(
    key: string,
    sourcePath: string,
    sha256: string,
  ): Promise<{ key: string; byteCount: number }>;
  getCapture(key: string, destinationPath: string): Promise<void>;
}

export class HistoryValidationError extends Error {
  override readonly name = "HistoryValidationError";
}

export class HistoryQueryLimitError extends Error {
  override readonly name = "HistoryQueryLimitError";

  constructor(
    message: string,
    readonly code:
      | "RANGE_LIMIT"
      | "ROW_LIMIT"
      | "SEGMENT_LIMIT"
      | "BYTE_LIMIT",
  ) {
    super(message);
  }
}

export class HistoryStorageBusyError extends Error {
  override readonly name = "HistoryStorageBusyError";
}

export function historyTimestamp(record: HistoricalRecord): number {
  return record.exchangeTimestamp > 0
    ? record.exchangeTimestamp
    : record.receivedTimestamp;
}

export function historyCursor(record: HistoricalRecord): HistoryCursor {
  return {
    timestamp: historyTimestamp(record),
    captureSequence: record.captureSequence,
    kind: record.kind,
    captureId: record.captureId,
    recordKey: historyRecordKey(record),
  };
}

const KIND_ORDER: Record<HistoricalRecordKind, number> = {
  depth_snapshot: 0,
  depth_delta: 1,
  trade: 2,
  metric_frame: 3,
};

export function compareHistoryRecords(
  left: HistoricalRecord,
  right: HistoricalRecord,
): number {
  return historyTimestamp(left) - historyTimestamp(right)
    || left.captureSequence - right.captureSequence
    || KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    || compareText(left.captureId, right.captureId)
    || compareText(historyRecordKey(left), historyRecordKey(right));
}

export function compareCursor(
  record: HistoricalRecord,
  cursor: HistoryCursor,
): number {
  return historyTimestamp(record) - cursor.timestamp
    || record.captureSequence - cursor.captureSequence
    || KIND_ORDER[record.kind] - KIND_ORDER[cursor.kind]
    || compareText(record.captureId, cursor.captureId)
    || compareText(historyRecordKey(record), cursor.recordKey);
}

export function historyRecordKey(record: HistoricalRecord): string {
  if (record.kind === "trade") return `trade:${record.tradeId}`;
  if (record.kind === "depth_snapshot") return `snapshot:${record.lastUpdateId}`;
  if (record.kind === "depth_delta") {
    return `delta:${record.sequenceStart}:${record.sequenceEnd}`;
  }
  return `metric:${record.resolutionMs}:${record.intervalStart}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalQuantity(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    throw new HistoryValidationError(`Invalid decimal quantity: ${text}`);
  }
  const [integer, fraction = ""] = text.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
}

export function validateHistoricalRecord(record: HistoricalRecord): void {
  if (!record || typeof record !== "object") invalid("Record must be an object");
  if (record.schemaVersion !== HISTORY_SCHEMA_VERSION) invalid("Unsupported history schema");
  if (record.exchange !== "binance") invalid("Unsupported exchange");
  if (!/^[A-Z0-9_.-]{1,48}$/.test(record.symbol)) invalid("Invalid symbol");
  if (!record.captureId || record.captureId.length > 128) invalid("Invalid captureId");
  positiveSafeInteger(record.captureSequence, "captureSequence");
  nonNegativeSafeInteger(record.exchangeTimestamp, "exchangeTimestamp");
  nonNegativeSafeInteger(record.receivedTimestamp, "receivedTimestamp");

  if (record.kind === "trade") {
    if (!record.tradeId || record.tradeId.length > 128) invalid("Invalid tradeId");
    positiveSafeInteger(record.priceTicks, "priceTicks");
    positiveFinite(record.tickSize, "tickSize");
    if (canonicalQuantity(record.quantity) !== record.quantity || record.quantity === "0") {
      invalid("Trade quantity must be a positive canonical decimal");
    }
    if (record.side !== "buy" && record.side !== "sell") invalid("Invalid trade side");
    return;
  }

  if (record.kind === "depth_snapshot" || record.kind === "depth_delta") {
    positiveFinite(record.tickSize, "tickSize");
    validateLevels(record.bids, record.kind === "depth_delta");
    validateLevels(record.asks, record.kind === "depth_delta");
    if (record.kind === "depth_snapshot") {
      nonNegativeSafeInteger(record.lastUpdateId, "lastUpdateId");
      if (!/^[a-f0-9]{64}$/.test(record.stateFingerprint)) {
        invalid("stateFingerprint must be a lowercase SHA-256 digest");
      }
    } else {
      nonNegativeSafeInteger(record.sequenceStart, "sequenceStart");
      nonNegativeSafeInteger(record.sequenceEnd, "sequenceEnd");
      if (record.sequenceEnd < record.sequenceStart) invalid("Invalid depth sequence range");
      if (record.previousSequence !== undefined) {
        nonNegativeSafeInteger(record.previousSequence, "previousSequence");
      }
    }
    return;
  }

  if (record.kind === "metric_frame") {
    if (!HISTORY_RESOLUTIONS_MS.includes(record.resolutionMs)) invalid("Invalid resolution");
    nonNegativeSafeInteger(record.intervalStart, "intervalStart");
    nonNegativeSafeInteger(record.intervalEnd, "intervalEnd");
    if (record.intervalEnd - record.intervalStart !== record.resolutionMs) {
      invalid("Metric interval must exactly match its resolution");
    }
    nonNegativeFinite(record.intervalBuyVolume, "intervalBuyVolume");
    nonNegativeFinite(record.intervalSellVolume, "intervalSellVolume");
    nonNegativeSafeInteger(record.intervalTradeCount, "intervalTradeCount");
    validateFiniteTree(record.metric, "metric");
    validateFiniteTree(record.trend, "trend");
    validateOptionalDigest(record.bookFingerprint, "bookFingerprint");
    validateOptionalDigest(record.analyticsFingerprint, "analyticsFingerprint");
    return;
  }

  invalid("Unknown historical record kind");
}

function validateLevels(levels: StoredPriceLevel[], zeroAllowed: boolean): void {
  if (!Array.isArray(levels)) invalid("Price levels must be an array");
  for (const level of levels) {
    if (!Array.isArray(level) || level.length !== 2) invalid("Invalid price level");
    positiveSafeInteger(level[0], "priceTicks");
    const canonical = canonicalQuantity(level[1]);
    if (canonical !== level[1] || (!zeroAllowed && canonical === "0")) {
      invalid("Price-level quantity is not canonical or allowed");
    }
  }
}

function validateFiniteTree(value: unknown, label: string): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${label} contains a non-finite number`);
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const nested of value) validateFiniteTree(nested, label);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) validateFiniteTree(nested, label);
    return;
  }
  if (value !== undefined) invalid(`${label} contains an unsupported value`);
}

function validateOptionalDigest(value: string | null, label: string): void {
  if (value !== null && !/^[a-f0-9]{64}$/.test(value)) invalid(`${label} is invalid`);
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive safe integer`);
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a non-negative safe integer`);
}

function positiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) invalid(`${label} must be positive and finite`);
}

function nonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) invalid(`${label} must be non-negative and finite`);
}

function invalid(message: string): never {
  throw new HistoryValidationError(message);
}
