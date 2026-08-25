import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { RawCaptureEnvelope } from "../recording/rawCapture.js";
import {
  RawCaptureCatalog,
  readCaptureSegment,
  type CaptureCatalogQuery,
} from "./rawCaptureCatalog.js";

export interface ReplayRange {
  symbol: string;
  /** Pins one immutable dataset and prevents overlapping captures from mixing. */
  captureId?: string;
  from: number;
  to: number;
}

export interface ReplaySourceFrame<T> {
  /** Stable opaque key; it defines replay order independently of wall clock. */
  sequence: string;
  timestamp: number;
  checksum: string;
  data: T;
  /** True when the frame predates the seek watermark and only anchors book state. */
  preroll?: boolean;
}

export interface ReplaySourceQuery extends ReplayRange {
  after?: string | null;
  limit: number;
  /** Lower event-time watermark used after seek; source fingerprint still uses ReplayRange. */
  startAt?: number;
  /** Optional playback watermark; it never changes source ordering. */
  through?: number;
  /**
   * When set on a fresh read (`after` empty), the page opens with the nearest
   * depth snapshot at or before `startAt` plus its subsequent depth deltas so a
   * seeking client can reconstruct the full book before live frames arrive.
   */
  includePreRoll?: boolean;
  /** Upper bound on retained pre-roll depth envelopes; overflow drops the run. */
  maxPreRollRecords?: number;
}

export interface ReplaySourcePage<T> {
  frames: ReplaySourceFrame<T>[];
  hasMore: boolean;
  sourceChecksum: string;
}

export interface ReplayFrameSource<T> {
  fingerprint(range: ReplayRange): Promise<string>;
  page(query: ReplaySourceQuery): Promise<ReplaySourcePage<T>>;
}

export interface RawCaptureReplaySourceOptions {
  maxPageSize?: number;
  refreshBeforeQuery?: boolean;
}

/**
 * Raw replay source backed by immutable gzip capture segments. The segment
 * order and captureSequence form the ordering key; capturedAt is only a
 * playback/filter timestamp and can never reorder exchange messages.
 */
export class RawCaptureReplaySource implements ReplayFrameSource<RawCaptureEnvelope> {
  private readonly maxPageSize: number;
  private readonly refreshBeforeQuery: boolean;

  constructor(
    readonly catalog: RawCaptureCatalog,
    options: RawCaptureReplaySourceOptions = {},
  ) {
    this.maxPageSize = clampInteger(options.maxPageSize ?? 5_000, 1, 50_000);
    this.refreshBeforeQuery = options.refreshBeforeQuery === true;
  }

  async fingerprint(range: ReplayRange): Promise<string> {
    await this.ensureCatalog();
    return this.catalog.checksum(normalizeRange(range));
  }

  async page(query: ReplaySourceQuery): Promise<ReplaySourcePage<RawCaptureEnvelope>> {
    await this.ensureCatalog();
    const range = normalizeRange(query);
    const limit = clampInteger(query.limit, 1, this.maxPageSize);
    const startAt = query.startAt === undefined
      ? range.from
      : clampTimestamp(query.startAt, range.from, range.to);
    const through = query.through === undefined
      ? range.to
      : clampTimestamp(query.through, range.from, range.to);
    const after = query.after || null;
    const frames: ReplaySourceFrame<RawCaptureEnvelope>[] = [];
    let cursorReached = after === null;

    // Seek pre-roll: retain the newest snapshot at or before `startAt` plus the
    // depth deltas that follow it. Trades never pre-roll; they are point events.
    const collectPreroll = query.includePreRoll === true && after === null;
    const maxPreRoll = clampInteger(query.maxPreRollRecords ?? 20_000, 0, 100_000);
    let prerollAnchor: ReplaySourceFrame<RawCaptureEnvelope> | null = null;
    let prerollPending: ReplaySourceFrame<RawCaptureEnvelope>[] = [];
    let prerollEmitted = false;
    let prerollDropped = 0;
    const rememberPreroll = (frame: ReplaySourceFrame<RawCaptureEnvelope>): void => {
      if (!collectPreroll) return;
      if (frame.data.stream === "snapshot") {
        prerollAnchor = frame;
        prerollPending = [];
        prerollDropped = 0;
        prerollEmitted = false;
        return;
      }
      if (prerollAnchor === null || frame.data.stream !== "depth") return;
      if (prerollPending.length >= maxPreRoll) {
        prerollDropped += 1;
        return;
      }
      prerollPending.push(frame);
    };
    const drainPreroll = (): void => {
      if (!collectPreroll || prerollEmitted || prerollAnchor === null) return;
      const budget = Math.max(0, limit - frames.length);
      const run = [prerollAnchor, ...prerollPending].map(
        (frame) => ({ ...frame, preroll: true }),
      );
      const take = run.slice(0, budget);
      prerollDropped += run.length - take.length > 0 ? run.length - take.length : 0;
      frames.push(...take);
      prerollEmitted = true;
    };

    const catalogQuery: CaptureCatalogQuery = range;
    for (const segment of this.catalog.list(catalogQuery)) {
      const segmentKey = captureSegmentKey(segment.startedAt, segment.captureId, basename(segment.dataPath));
      for await (const envelope of readCaptureSegment(segment, {
        verifyChecksums: true,
        maxRecords: Math.max(1, segment.recordCount),
      })) {
        const sequence = `${segmentKey}:${String(envelope.captureSequence).padStart(12, "0")}`;
        if (!cursorReached) {
          if (sequence === after) cursorReached = true;
          continue;
        }
        if (envelope.capturedAt < startAt) {
          rememberPreroll({
            sequence,
            timestamp: envelope.capturedAt,
            checksum: envelopeChecksum(envelope),
            data: envelope,
          });
          continue;
        }
        if (envelope.capturedAt > through) {
          // Before the final watermark, never skip a future event and advance
          // the cursor past it. This preserves capture order under clock drift.
          if (through < range.to) {
            drainPreroll();
            return {
              frames,
              hasMore: true,
              sourceChecksum: this.catalog.checksum(range),
            };
          }
          continue;
        }
        drainPreroll();
        frames.push({
          sequence,
          timestamp: envelope.capturedAt,
          checksum: envelopeChecksum(envelope),
          data: envelope,
        });
        if (frames.length > limit) {
          return {
            frames: frames.slice(0, limit),
            hasMore: true,
            sourceChecksum: this.catalog.checksum(range),
          };
        }
      }
    }

    if (!cursorReached) throw new Error("Replay cursor no longer exists in the capture catalog");
    drainPreroll();
    return {
      frames,
      hasMore: prerollDropped > 0,
      sourceChecksum: this.catalog.checksum(range),
    };
  }

  private async ensureCatalog(): Promise<void> {
    if (this.refreshBeforeQuery || this.catalog.snapshot.scannedAt === 0) {
      await this.catalog.refresh();
    }
  }
}

export function envelopeChecksum(envelope: RawCaptureEnvelope): string {
  const hash = createHash("sha256");
  hash.update("raw-capture-envelope-v1\n");
  hash.update(`${envelope.captureSequence}\0${envelope.capturedAt}\0${envelope.exchange}\0`);
  hash.update(`${envelope.symbol}\0${envelope.source}\0${envelope.stream}\0`);
  hash.update(`${envelope.connectionId}\0${envelope.payload}`);
  return hash.digest("hex");
}

function captureSegmentKey(startedAt: number, captureId: string, dataFile: string): string {
  const hash = createHash("sha256")
    .update(`${startedAt}\0${captureId}\0${dataFile}`)
    .digest("hex")
    .slice(0, 16);
  return `${String(startedAt).padStart(16, "0")}:${captureId}:${hash}`;
}

function normalizeRange(range: ReplayRange): ReplayRange {
  const symbol = range.symbol.trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9_-]{1,48}$/.test(symbol)) {
    throw new TypeError("Replay symbol is invalid");
  }
  if (!Number.isSafeInteger(range.from) || range.from < 0) {
    throw new TypeError("Replay `from` must be a non-negative integer timestamp");
  }
  if (!Number.isSafeInteger(range.to) || range.to < range.from) {
    throw new TypeError("Replay `to` must be an integer timestamp >= `from`");
  }
  const captureId = range.captureId?.trim();
  if (captureId !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(captureId)) {
    throw new TypeError("Replay capture id is invalid");
  }
  return {
    symbol,
    ...(captureId ? { captureId } : {}),
    from: range.from,
    to: range.to,
  };
}

function clampTimestamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
