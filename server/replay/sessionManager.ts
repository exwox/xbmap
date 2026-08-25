import { createHash, randomUUID } from "node:crypto";
import type {
  ReplayFrameSource,
  ReplayRange,
  ReplaySourceFrame,
} from "./replaySource.js";

export type ReplaySessionStatus = "paused" | "playing" | "completed";

export interface ReplayCheckpoint {
  seekTimestamp: number;
  cursor: string | null;
  deliveredFrames: number;
  rollingChecksum: string;
  sourceChecksum: string;
}

export interface ReplaySessionSnapshot {
  version: 1;
  id: string;
  symbol: string;
  captureId?: string;
  from: number;
  to: number;
  speed: number;
  status: ReplaySessionStatus;
  playheadAt: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  checkpoint: ReplayCheckpoint;
}

interface ManagedReplaySession extends ReplaySessionSnapshot {
  anchorWallAt: number | null;
  anchorReplayAt: number;
}

export interface CreateReplaySessionOptions extends ReplayRange {
  speed?: number;
  autoplay?: boolean;
  ttlMs?: number;
}

export interface ReplayReadOptions {
  limit?: number;
  now?: number;
}

export interface ReplayReadResult<T> {
  session: ReplaySessionSnapshot;
  frames: ReplaySourceFrame<T>[];
  hasMore: boolean;
  checkpoint: ReplayCheckpoint;
}

export interface ReplayRestoreResult {
  restored: number;
  discarded: number;
}

export interface ReplaySessionRepository {
  load(): Promise<ReplaySessionSnapshot[]>;
  save(session: ReplaySessionSnapshot): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface ReplaySessionManagerOptions {
  now?: () => number;
  repository?: ReplaySessionRepository;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  maxRangeMs?: number;
  maxReadFrames?: number;
}

/**
 * Clocked replay lifecycle with durable, speed-invariant checkpoints. Source
 * bytes remain immutable; pause/seek only changes the session cursor.
 */
export class ReplaySessionManager<T> {
  private readonly sessions = new Map<string, ManagedReplaySession>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly repository?: ReplaySessionRepository;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly maxRangeMs: number;
  private readonly maxReadFrames: number;

  constructor(
    private readonly source: ReplayFrameSource<T>,
    options: ReplaySessionManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = clampInteger(options.defaultTtlMs ?? 30 * 60_000, 1_000, 24 * 60 * 60_000);
    this.maxTtlMs = clampInteger(options.maxTtlMs ?? 24 * 60 * 60_000, this.defaultTtlMs, 7 * 24 * 60 * 60_000);
    this.maxRangeMs = clampInteger(options.maxRangeMs ?? 24 * 60 * 60_000, 1_000, 30 * 24 * 60 * 60_000);
    this.maxReadFrames = clampInteger(options.maxReadFrames ?? 5_000, 1, 50_000);
    this.repository = options.repository;
  }

  async restore(): Promise<ReplayRestoreResult> {
    if (!this.repository) return { restored: 0, discarded: 0 };
    const now = this.safeNow();
    let restored = 0;
    let discarded = 0;
    for (const candidate of await this.repository.load()) {
      try {
        const session = validateSnapshot(candidate);
        if (session.expiresAt <= now) throw new Error("expired");
        const sourceChecksum = await this.source.fingerprint(session);
        if (sourceChecksum !== session.checkpoint.sourceChecksum) {
          throw new Error("source checksum changed");
        }
        // Wall-clock anchors are intentionally not persisted. A process restart
        // restores a playing session as paused at its last committed playhead.
        session.status = session.status === "playing" ? "paused" : session.status;
        session.updatedAt = now;
        this.sessions.set(session.id, {
          ...session,
          anchorWallAt: null,
          anchorReplayAt: session.playheadAt,
        });
        await this.persist(this.sessions.get(session.id)!);
        restored += 1;
      } catch {
        discarded += 1;
        if (isObject(candidate) && typeof candidate.id === "string") {
          await this.repository.remove(candidate.id).catch(() => undefined);
        }
      }
    }
    return { restored, discarded };
  }

  async create(options: CreateReplaySessionOptions): Promise<ReplaySessionSnapshot> {
    const range = normalizeRange(options);
    if (range.to - range.from > this.maxRangeMs) {
      throw new RangeError(`Replay range exceeds the ${this.maxRangeMs}ms limit`);
    }
    const now = this.safeNow();
    const speed = clampNumber(options.speed ?? 1, 0.25, 20);
    const ttlMs = clampInteger(options.ttlMs ?? this.defaultTtlMs, 1_000, this.maxTtlMs);
    const sourceChecksum = await this.source.fingerprint(range);
    const status: ReplaySessionStatus = options.autoplay ? "playing" : "paused";
    const session: ManagedReplaySession = {
      version: 1,
      id: randomUUID(),
      ...range,
      speed,
      status,
      playheadAt: range.from,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs,
      checkpoint: initialCheckpoint(range.from, sourceChecksum),
      anchorWallAt: options.autoplay ? now : null,
      anchorReplayAt: range.from,
    };
    this.sessions.set(session.id, session);
    await this.persist(session);
    return publicSnapshot(session);
  }

  async get(id: string): Promise<ReplaySessionSnapshot | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= this.safeNow()) {
      await this.delete(id);
      return undefined;
    }
    return publicSnapshot(session);
  }

  async pause(id: string, now = this.safeNow()): Promise<ReplaySessionSnapshot> {
    return this.enqueue(id, async (session) => {
      updatePlayhead(session, normalizedNow(now));
      if (session.status !== "completed") session.status = "paused";
      session.anchorWallAt = null;
      session.anchorReplayAt = session.playheadAt;
      session.updatedAt = normalizedNow(now);
      await this.persist(session);
      return publicSnapshot(session);
    });
  }

  async resume(id: string, now = this.safeNow()): Promise<ReplaySessionSnapshot> {
    return this.enqueue(id, async (session) => {
      if (session.status === "completed") {
        throw new Error("Completed replay must be seeked before it can resume");
      }
      const timestamp = normalizedNow(now);
      updatePlayhead(session, timestamp);
      session.status = "playing";
      session.anchorWallAt = timestamp;
      session.anchorReplayAt = session.playheadAt;
      session.updatedAt = timestamp;
      await this.persist(session);
      return publicSnapshot(session);
    });
  }

  async seek(id: string, timestamp: number, now = this.safeNow()): Promise<ReplaySessionSnapshot> {
    return this.enqueue(id, async (session) => {
      const target = clampTimestamp(timestamp, session.from, session.to);
      const wallNow = normalizedNow(now);
      const sourceChecksum = await this.source.fingerprint(session);
      if (sourceChecksum !== session.checkpoint.sourceChecksum) {
        throw new Error("Replay source changed; create a new session before seeking");
      }
      session.playheadAt = target;
      session.checkpoint = initialCheckpoint(target, sourceChecksum);
      if (session.status === "completed") session.status = "paused";
      session.anchorWallAt = session.status === "playing" ? wallNow : null;
      session.anchorReplayAt = target;
      session.updatedAt = wallNow;
      await this.persist(session);
      return publicSnapshot(session);
    });
  }

  async setSpeed(id: string, speed: number, now = this.safeNow()): Promise<ReplaySessionSnapshot> {
    return this.enqueue(id, async (session) => {
      const wallNow = normalizedNow(now);
      updatePlayhead(session, wallNow);
      session.speed = clampNumber(speed, 0.25, 20);
      session.anchorWallAt = session.status === "playing" ? wallNow : null;
      session.anchorReplayAt = session.playheadAt;
      session.updatedAt = wallNow;
      await this.persist(session);
      return publicSnapshot(session);
    });
  }

  async read(id: string, options: ReplayReadOptions = {}): Promise<ReplayReadResult<T>> {
    return this.enqueue(id, async (session) => {
      const now = normalizedNow(options.now ?? this.safeNow());
      if (session.status !== "playing") {
        return {
          session: publicSnapshot(session),
          frames: [],
          hasMore: session.status !== "completed",
          checkpoint: cloneCheckpoint(session.checkpoint),
        };
      }

      updatePlayhead(session, now);
      const page = await this.source.page({
        symbol: session.symbol,
        ...(session.captureId ? { captureId: session.captureId } : {}),
        from: session.from,
        to: session.to,
        startAt: session.checkpoint.seekTimestamp,
        after: session.checkpoint.cursor,
        through: session.playheadAt,
        limit: clampInteger(options.limit ?? this.maxReadFrames, 1, this.maxReadFrames),
      });
      if (page.sourceChecksum !== session.checkpoint.sourceChecksum) {
        throw new Error("Replay source checksum changed during the session");
      }
      for (const frame of page.frames) advanceCheckpoint(session.checkpoint, frame);
      const complete = session.playheadAt >= session.to && !page.hasMore;
      if (complete) {
        session.status = "completed";
        session.anchorWallAt = null;
        session.anchorReplayAt = session.to;
      }
      session.updatedAt = now;
      await this.persist(session);
      return {
        session: publicSnapshot(session),
        frames: page.frames,
        hasMore: !complete,
        checkpoint: cloneCheckpoint(session.checkpoint),
      };
    });
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.sessions.delete(id);
    if (existed && this.repository) await this.repository.remove(id);
    return existed;
  }

  async cleanup(now = this.safeNow()): Promise<number> {
    const timestamp = normalizedNow(now);
    const expired = [...this.sessions.values()]
      .filter((session) => session.expiresAt <= timestamp)
      .map((session) => session.id);
    for (const id of expired) await this.delete(id);
    return expired.length;
  }

  private async enqueue<R>(
    id: string,
    operation: (session: ManagedReplaySession) => Promise<R>,
  ): Promise<R> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(id, tail);
    await previous;
    try {
      const session = this.sessions.get(id);
      if (!session || session.expiresAt <= this.safeNow()) {
        if (session) await this.delete(id);
        throw new Error("Replay session was not found or expired");
      }
      return await operation(session);
    } finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  private persist(session: ManagedReplaySession): Promise<void> {
    return this.repository?.save(publicSnapshot(session)) ?? Promise.resolve();
  }

  private safeNow(): number {
    return normalizedNow(this.now());
  }
}

function updatePlayhead(session: ManagedReplaySession, now: number): void {
  if (session.status !== "playing" || session.anchorWallAt === null) return;
  const elapsed = Math.max(0, now - session.anchorWallAt);
  session.playheadAt = Math.min(session.to, Math.trunc(session.anchorReplayAt + elapsed * session.speed));
}

function initialCheckpoint(seekTimestamp: number, sourceChecksum: string): ReplayCheckpoint {
  return {
    seekTimestamp,
    cursor: null,
    deliveredFrames: 0,
    rollingChecksum: createHash("sha256")
      .update(`replay-checkpoint-v1\n${sourceChecksum}\n${seekTimestamp}\n`)
      .digest("hex"),
    sourceChecksum,
  };
}

function advanceCheckpoint<T>(checkpoint: ReplayCheckpoint, frame: ReplaySourceFrame<T>): void {
  checkpoint.rollingChecksum = createHash("sha256")
    .update(`${checkpoint.rollingChecksum}\n${frame.sequence}\n${frame.checksum}\n`)
    .digest("hex");
  checkpoint.cursor = frame.sequence;
  checkpoint.deliveredFrames += 1;
}

function publicSnapshot(session: ManagedReplaySession): ReplaySessionSnapshot {
  return {
    version: 1,
    id: session.id,
    symbol: session.symbol,
    ...(session.captureId ? { captureId: session.captureId } : {}),
    from: session.from,
    to: session.to,
    speed: session.speed,
    status: session.status,
    playheadAt: session.playheadAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    checkpoint: cloneCheckpoint(session.checkpoint),
  };
}

function validateSnapshot(value: ReplaySessionSnapshot): ReplaySessionSnapshot {
  if (!isObject(value)
    || value.version !== 1
    || typeof value.id !== "string" || !value.id
    || typeof value.symbol !== "string"
    || (value.captureId !== undefined
      && (typeof value.captureId !== "string"
        || !/^[A-Za-z0-9_.-]{1,128}$/.test(value.captureId)))
    || !Number.isSafeInteger(value.from)
    || !Number.isSafeInteger(value.to)
    || value.to < value.from
    || !Number.isFinite(value.speed) || value.speed < 0.25 || value.speed > 20
    || !isReplayStatus(value.status)
    || !Number.isSafeInteger(value.playheadAt)
    || value.playheadAt < value.from || value.playheadAt > value.to
    || !Number.isSafeInteger(value.createdAt)
    || !Number.isSafeInteger(value.updatedAt)
    || !Number.isSafeInteger(value.expiresAt)
    || !isCheckpoint(value.checkpoint)) {
    throw new Error("Malformed persisted replay session");
  }
  return structuredClone(value);
}

function isCheckpoint(value: unknown): value is ReplayCheckpoint {
  return isObject(value)
    && Number.isSafeInteger(value.seekTimestamp) && (value.seekTimestamp as number) >= 0
    && (value.cursor === null || typeof value.cursor === "string")
    && Number.isSafeInteger(value.deliveredFrames) && (value.deliveredFrames as number) >= 0
    && isSha256(value.rollingChecksum)
    && isSha256(value.sourceChecksum);
}

function normalizeRange(range: ReplayRange): ReplayRange {
  const symbol = range.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,48}$/.test(symbol)) throw new TypeError("Replay symbol is invalid");
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

function cloneCheckpoint(checkpoint: ReplayCheckpoint): ReplayCheckpoint {
  return { ...checkpoint };
}

function isReplayStatus(value: unknown): value is ReplaySessionStatus {
  return value === "paused" || value === "playing" || value === "completed";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Replay clock is invalid");
  return Math.trunc(value);
}

function clampTimestamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new TypeError("Replay seek timestamp must be finite");
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new TypeError("Replay speed must be finite");
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
