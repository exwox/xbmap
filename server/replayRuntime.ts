import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  FileReplaySessionRepository,
  RawCaptureCatalog,
  RawCaptureReplaySource,
  ReplaySessionManager,
  projectRawCapture,
  readCaptureSegment,
  verifyCaptureSegment,
  type ReplayReadResult,
  type ReplaySessionSnapshot,
} from "./replay/index.js";
import type { RawCaptureEnvelope } from "./recording/rawCapture.js";

export interface RawReplayRuntimeOptions {
  captureDirectory: string;
  sessionRepositoryPath: string;
  tickSize: number;
  maxRangeMs?: number;
  maxReadFrames?: number;
  maxVerifyRecords?: number;
  cleanupIntervalMs?: number;
}

export interface SafeRawReplayFrame {
  sequence: string;
  timestamp: number;
  checksum: string;
  captureSequence: number;
  stream: RawCaptureEnvelope["stream"];
  connectionId: string;
  /** Frame predates the seek watermark; used to rebuild the full book. */
  preroll: boolean;
}

export class RawReplayValidationError extends Error {
  override readonly name = "RawReplayValidationError";
}

/** Runtime container for private immutable-capture replay and durable session metadata. */
export class RawReplayRuntime {
  readonly catalog: RawCaptureCatalog;
  readonly manager: ReplaySessionManager<RawCaptureEnvelope>;
  private readonly maxVerifyRecords: number;
  private readonly tickSize: number;
  private readonly cleanupTimer: NodeJS.Timeout;
  private restoredSessions = 0;
  private discardedSessions = 0;

  private constructor(options: RawReplayRuntimeOptions) {
    this.tickSize = options.tickSize;
    this.maxVerifyRecords = positiveInteger(options.maxVerifyRecords, 250_000);
    this.catalog = new RawCaptureCatalog(options.captureDirectory);
    const source = new RawCaptureReplaySource(this.catalog, {
      refreshBeforeQuery: true,
      maxPageSize: options.maxReadFrames,
    });
    this.manager = new ReplaySessionManager(source, {
      repository: new FileReplaySessionRepository(options.sessionRepositoryPath),
      maxRangeMs: options.maxRangeMs,
      maxReadFrames: options.maxReadFrames,
    });
    this.cleanupTimer = setInterval(() => {
      void this.manager.cleanup().catch(() => undefined);
    }, positiveInteger(options.cleanupIntervalMs, 60_000));
    this.cleanupTimer.unref?.();
  }

  static async open(options: RawReplayRuntimeOptions): Promise<RawReplayRuntime> {
    const captureDirectory = resolve(options.captureDirectory);
    await mkdir(captureDirectory, { recursive: true, mode: 0o700 });
    const runtime = new RawReplayRuntime({ ...options, captureDirectory });
    await runtime.catalog.refresh();
    const restored = await runtime.manager.restore();
    runtime.restoredSessions = restored.restored;
    runtime.discardedSessions = restored.discarded;
    return runtime;
  }

  get status() {
    const snapshot = this.catalog.snapshot;
    return {
      enabled: true as const,
      captures: snapshot.segments.length,
      catalogProblems: snapshot.problems.length,
      catalogChecksum: snapshot.checksum,
      restoredSessions: this.restoredSessions,
      discardedSessions: this.discardedSessions,
    };
  }

  async listCaptures() {
    const snapshot = await this.catalog.refresh();
    return {
      checksum: snapshot.checksum,
      captures: snapshot.segments.map((segment) => ({
        captureId: segment.captureId,
        symbol: segment.symbol,
        startedAt: segment.startedAt,
        closedAt: segment.closedAt,
        recordCount: segment.recordCount,
        complete: segment.complete,
        dataBytes: segment.dataBytes,
        sha256: segment.dataSha256,
        adapterVersion: segment.manifest.adapterVersion ?? null,
        analyticsVersion: segment.manifest.analyticsVersion ?? null,
        closeReason: segment.manifest.closeReason ?? null,
      })),
      problems: snapshot.problems.map((problem) => ({
        artifact: basename(problem.manifestPath),
        message: problem.message,
      })),
    };
  }

  async verify(captureId: string) {
    await this.catalog.refresh();
    const segment = this.catalog.get(captureId);
    if (!segment) throw new Error("Raw capture was not found");
    if (!segment.complete) throw new Error("Incomplete raw capture cannot be verified as valid");
    if (segment.recordCount > this.maxVerifyRecords) {
      throw new RangeError(`Raw capture exceeds the ${this.maxVerifyRecords} record verification limit`);
    }
    let verification;
    let projection;
    try {
      verification = await verifyCaptureSegment(segment);
      if (verification.records === 0) {
        throw new Error("Raw capture is empty and has no reconstructable market state");
      }
      projection = await projectRawCapture(
        readCaptureSegment(segment, {
          verifyChecksums: true,
          maxRecords: this.maxVerifyRecords,
        }),
        { symbol: segment.symbol, tickSize: this.tickSize },
      );
    } catch (error) {
      throw new RawReplayValidationError(
        error instanceof Error ? error.message : "Raw capture verification failed",
      );
    }
    return {
      verification,
      projection: {
        symbol: projection.symbol,
        records: projection.records,
        snapshots: projection.snapshots,
        depthApplied: projection.depthApplied,
        depthIgnored: projection.depthIgnored,
        trades: projection.trades,
        buyVolume: projection.buyVolume,
        sellVolume: projection.sellVolume,
        firstCapturedAt: projection.firstCapturedAt,
        lastCapturedAt: projection.lastCapturedAt,
        checkpoint: projection.checkpoint,
        replayChecksum: projection.replayChecksum,
      },
    };
  }

  safeRead(result: ReplayReadResult<RawCaptureEnvelope>) {
    return {
      ...result,
      frames: result.frames.map((frame): SafeRawReplayFrame => ({
        sequence: frame.sequence,
        timestamp: frame.timestamp,
        checksum: frame.checksum,
        captureSequence: frame.data.captureSequence,
        stream: frame.data.stream,
        connectionId: frame.data.connectionId,
        preroll: frame.preroll === true,
      })),
    };
  }

  close(): void {
    clearInterval(this.cleanupTimer);
  }
}

export async function rawReplayRuntimeFromEnvironment(
  tickSize: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RawReplayRuntime | null> {
  const captureDirectory = environment.XBMAP_CAPTURE_DIR?.trim();
  if (!captureDirectory) return null;
  const repository = environment.XBMAP_REPLAY_SESSION_FILE?.trim()
    || join(captureDirectory, ".replay-sessions.json");
  return RawReplayRuntime.open({
    captureDirectory,
    sessionRepositoryPath: repository,
    tickSize,
    maxRangeMs: envInteger(environment.XBMAP_REPLAY_MAX_RANGE_MS, 24 * 60 * 60_000),
    maxReadFrames: envInteger(environment.XBMAP_REPLAY_MAX_PAGE_FRAMES, 5_000),
    maxVerifyRecords: envInteger(environment.XBMAP_REPLAY_MAX_VERIFY_RECORDS, 250_000),
  });
}

export function replaySessionSummary(session: ReplaySessionSnapshot) {
  return {
    ...session,
    checkpoint: { ...session.checkpoint },
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError("Replay limit must be positive");
  return result;
}

function envInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
