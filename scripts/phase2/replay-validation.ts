import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  FileReplaySessionRepository,
  RawCaptureCatalog,
  RawCaptureReplaySource,
  ReplaySessionManager,
  projectRawCapture,
} from "../../server/replay/index.js";
import type { RawCaptureEnvelope } from "../../server/recording/rawCapture.js";
import { assertion, assertionBelow, measureCase } from "./case-utils.js";
import { createSyntheticRawHour } from "./raw-fixture.js";
import {
  SYNTHETIC_HOUR_END,
  SYNTHETIC_HOUR_START,
  SYNTHETIC_SYMBOL,
} from "./synthetic.js";
import type { Phase2ValidationCase } from "./types.js";

const DAY_MS = 24 * 60 * 60_000;

export async function validateOneHourReplayStartup(): Promise<Phase2ValidationCase> {
  return measureCase("one-hour-replay-startup", async () => withRawHour(async (directory) => {
    let wallClock = 2_000_000_000_000;
    const catalog = new RawCaptureCatalog(directory);
    const source = new RawCaptureReplaySource(catalog, { maxPageSize: 1_000 });
    const manager = new ReplaySessionManager(source, {
      now: () => wallClock,
      maxReadFrames: 1_000,
    });

    const started = performance.now();
    const session = await manager.create({
      symbol: SYNTHETIC_SYMBOL,
      from: SYNTHETIC_HOUR_START,
      to: SYNTHETIC_HOUR_END,
      speed: 20,
      autoplay: true,
    });
    wallClock += 180_000;
    const firstPage = await manager.read(session.id, { limit: 512, now: wallClock });
    const startupMs = performance.now() - started;

    return {
      assertions: [
        assertionBelow("one-hour replay startup is below three seconds", startupMs, 3_000),
        assertion("startup returns the requested first page", firstPage.frames.length, 512),
        assertion("startup authenticates a stable source checksum", /^[a-f0-9]{64}$/.test(
          firstPage.checkpoint.sourceChecksum,
        ), true),
      ],
      observations: {
        startupMs: Math.round(startupMs * 1_000) / 1_000,
        datasetMarketDurationMs: 60 * 60_000,
        datasetRecords: 7_201,
        firstPageRecords: firstPage.frames.length,
      },
      notes: [
        "Synthetic target dataset: one snapshot plus one depth delta and one trade per second for one market hour.",
        "Timer includes catalog discovery, session creation, compressed checksum verification, and first-page decoding; fixture generation is excluded.",
      ],
    };
  }));
}

export async function validateDeterministicReplayChecksums(): Promise<Phase2ValidationCase> {
  return measureCase("speed-and-seek-invariant-replay-checksum", async () =>
    withRawHour(async (directory) => {
      const catalog = new RawCaptureCatalog(directory);
      await catalog.refresh();
      const source = new RawCaptureReplaySource(catalog, { maxPageSize: 50_000 });
      const slow = await replayToEnd(source, 0.25, 3_000_000_000_000);
      const fast = await replayToEnd(source, 20, 3_100_000_000_000);
      const seekAt = SYNTHETIC_HOUR_START + 30 * 60_000;
      const seekSlow = await replayToEnd(source, 0.25, 3_200_000_000_000, seekAt);
      const seekFast = await replayToEnd(source, 20, 3_300_000_000_000, seekAt);

      return {
        assertions: [
          assertion("0.25x and 20x deliver the same frame count", slow.frames, fast.frames),
          assertion("0.25x and 20x preserve frame order", slow.sequenceDigest, fast.sequenceDigest),
          assertion("0.25x and 20x produce one rolling checksum", slow.checksum, fast.checksum),
          assertion("0.25x and 20x produce one projected state checksum", slow.stateChecksum ?? "", fast.stateChecksum ?? ""),
          assertion("0.25x and 20x produce one final book fingerprint", slow.bookFingerprint ?? "", fast.bookFingerprint ?? ""),
          assertion("full replay completes", slow.status, "completed"),
          assertion("seek resets the replay checkpoint", seekSlow.seekTimestamp, seekAt),
          assertion("seek checksum is speed-invariant", seekSlow.checksum, seekFast.checksum),
          assertion("seek frame order is speed-invariant", seekSlow.sequenceDigest, seekFast.sequenceDigest),
          assertion("seek replay starts on/after its target", seekSlow.firstTimestamp >= seekAt, true),
        ],
        observations: {
          fullReplayFrames: slow.frames,
          seekReplayFrames: seekSlow.frames,
          fullChecksum: slow.checksum,
          fullStateChecksum: slow.stateChecksum ?? "",
          finalBookFingerprint: slow.bookFingerprint ?? "",
          seekChecksum: seekSlow.checksum,
          sourceChecksum: slow.sourceChecksum,
        },
        notes: ["Playback speed changes scheduling only; rolling checksums consume stable source sequence and frame checksums."],
      };
    }));
}

export async function validateReplaySessionRestart(): Promise<Phase2ValidationCase> {
  return measureCase("replay-session-checkpoint-restart", async () =>
    withRawHour(async (directory) => {
      const catalog = new RawCaptureCatalog(directory);
      const source = new RawCaptureReplaySource(catalog, { maxPageSize: 5_000 });
      const repositoryPath = join(directory, "session-metadata.json");
      let wallClock = 4_000_000_000_000;
      const firstManager = new ReplaySessionManager(source, {
        now: () => wallClock,
        repository: new FileReplaySessionRepository(repositoryPath),
        maxReadFrames: 1_000,
      });
      const created = await firstManager.create({
        symbol: SYNTHETIC_SYMBOL,
        from: SYNTHETIC_HOUR_START,
        to: SYNTHETIC_HOUR_END,
        speed: 20,
        autoplay: true,
        ttlMs: DAY_MS,
      });
      wallClock += 45_000;
      const beforeRestart = await firstManager.read(created.id, {
        now: wallClock,
        limit: 1_000,
      });

      const restartedManager = new ReplaySessionManager(source, {
        now: () => wallClock,
        repository: new FileReplaySessionRepository(repositoryPath),
        maxReadFrames: 1_000,
      });
      const restore = await restartedManager.restore();
      const restored = await restartedManager.get(created.id);
      if (!restored) throw new Error("Persisted replay session was not restored");
      const pausedRead = await restartedManager.read(created.id, { now: wallClock });
      const seekTarget = SYNTHETIC_HOUR_START + 15 * 60_000;
      const seeked = await restartedManager.seek(created.id, seekTarget, wallClock);
      const spedUp = await restartedManager.setSpeed(created.id, 12, wallClock);
      const resumed = await restartedManager.resume(created.id, wallClock);

      return {
        assertions: [
          assertion("one session is restored", restore.restored, 1),
          assertion("valid session is not discarded", restore.discarded, 0),
          assertion("playing session restarts paused", restored.status, "paused"),
          assertion(
            "checkpoint rolling checksum survives restart",
            restored.checkpoint.rollingChecksum,
            beforeRestart.checkpoint.rollingChecksum,
          ),
          assertion("checkpoint cursor survives restart", restored.checkpoint.cursor ?? "", beforeRestart.checkpoint.cursor ?? ""),
          assertion("paused replay emits no frames", pausedRead.frames.length, 0),
          assertion("seek changes checkpoint origin", seeked.checkpoint.seekTimestamp, seekTarget),
          assertion("speed control persists", spedUp.speed, 12),
          assertion("resume changes lifecycle state", resumed.status, "playing"),
        ],
        observations: {
          deliveredBeforeRestart: beforeRestart.checkpoint.deliveredFrames,
          restoredPlayheadAt: restored.playheadAt,
          restoredChecksum: restored.checkpoint.rollingChecksum,
        },
        notes: ["A playing session intentionally restores paused because wall-clock anchors are process-local."],
      };
    }));
}

async function replayToEnd(
  source: RawCaptureReplaySource,
  speed: number,
  wallStart: number,
  seekAt?: number,
): Promise<{
  frames: number;
  checksum: string;
  sourceChecksum: string;
  sequenceDigest: string;
  seekTimestamp: number;
  firstTimestamp: number;
  status: string;
  stateChecksum: string | null;
  bookFingerprint: string | null;
}> {
  let wallClock = wallStart;
  const manager = new ReplaySessionManager(source, {
    now: () => wallClock,
    maxReadFrames: 50_000,
    defaultTtlMs: DAY_MS,
    maxTtlMs: DAY_MS,
  });
  const session = await manager.create({
    symbol: SYNTHETIC_SYMBOL,
    from: SYNTHETIC_HOUR_START,
    to: SYNTHETIC_HOUR_END,
    speed,
    autoplay: seekAt === undefined,
    ttlMs: DAY_MS,
  });
  if (seekAt !== undefined) {
    await manager.seek(session.id, seekAt, wallClock);
    await manager.resume(session.id, wallClock);
  }
  const remainingMarketMs = SYNTHETIC_HOUR_END - (seekAt ?? SYNTHETIC_HOUR_START);
  wallClock += Math.ceil(remainingMarketMs / speed) + 1;
  const result = await manager.read(session.id, { limit: 50_000, now: wallClock });
  const sequenceDigest = checksumSequences(result.frames);
  const projection = seekAt === undefined
    ? await projectRawCapture(frameData(result.frames), {
        symbol: SYNTHETIC_SYMBOL,
        tickSize: 0.1,
      })
    : null;
  return {
    frames: result.frames.length,
    checksum: result.checkpoint.rollingChecksum,
    sourceChecksum: result.checkpoint.sourceChecksum,
    sequenceDigest,
    seekTimestamp: result.checkpoint.seekTimestamp,
    firstTimestamp: result.frames[0]?.timestamp ?? Number.MAX_SAFE_INTEGER,
    status: result.session.status,
    stateChecksum: projection?.replayChecksum ?? null,
    bookFingerprint: projection?.checkpoint?.fingerprint ?? null,
  };
}

async function* frameData(
  frames: readonly { data: RawCaptureEnvelope }[],
): AsyncGenerator<RawCaptureEnvelope> {
  for (const frame of frames) yield frame.data;
}

function checksumSequences(frames: readonly { sequence: string; checksum: string }[]): string {
  const hash = createHash("sha256");
  for (const frame of frames) hash.update(`${frame.sequence}\0${frame.checksum}\n`);
  return hash.digest("hex");
}

async function withRawHour<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "liquidmap-phase2-replay-"));
  try {
    await createSyntheticRawHour(directory);
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
