import { performance } from "node:perf_hooks";
import { AnalyticsEngine } from "../../server/core/analytics.js";
import { OrderBook } from "../../server/core/orderBook.js";
import type { DepthSnapshot, DepthUpdate, NormalizedTrade } from "../../server/types.js";
import {
  VALIDATION_SCHEMA_VERSION,
  type MemorySample,
  type MemoryTrend,
  type SoakConfiguration,
  type SoakReport,
} from "./types.js";

const MIB = 1024 * 1024;
const MINUTE_MS = 60_000;

export function quickSoakConfiguration(): SoakConfiguration {
  return {
    mode: "quick",
    durationMs: 5_000,
    warmupMs: 1_000,
    sampleIntervalMs: 500,
    cycleIntervalMs: 100,
    marketEventsPerSecond: 1_200,
    requireExposedGc: false,
    minimumTrendSamples: 8,
    maximumRetainedGrowthBytes: 8 * MIB,
    maximumSlopeBytesPerMinute: 64 * MIB,
    minimumRSquared: 0.6,
    minimumPositiveIntervalRatio: 0.7,
  };
}

export function fullEightHourSoakConfiguration(): SoakConfiguration {
  return {
    mode: "full-8h",
    durationMs: 8 * 60 * 60_000,
    warmupMs: 2 * 60_000,
    sampleIntervalMs: 60_000,
    cycleIntervalMs: 100,
    marketEventsPerSecond: 1_200,
    requireExposedGc: true,
    minimumTrendSamples: 30,
    maximumRetainedGrowthBytes: 32 * MIB,
    maximumSlopeBytesPerMinute: 256 * 1024,
    minimumRSquared: 0.6,
    minimumPositiveIntervalRatio: 0.7,
  };
}

export function customSoakConfiguration(durationMs: number): SoakConfiguration {
  if (!Number.isFinite(durationMs) || durationMs < 1_000) {
    throw new Error("Custom soak duration must be at least 1 second");
  }
  const sampleIntervalMs = Math.max(250, Math.min(60_000, Math.floor(durationMs / 20)));
  return {
    ...quickSoakConfiguration(),
    mode: "custom",
    durationMs,
    warmupMs: Math.min(120_000, Math.floor(durationMs * 0.2)),
    sampleIntervalMs,
    minimumTrendSamples: Math.min(12, Math.max(4, Math.floor(durationMs / sampleIntervalMs) - 2)),
    maximumRetainedGrowthBytes: durationMs >= 60_000 ? 32 * MIB : 8 * MIB,
    maximumSlopeBytesPerMinute: durationMs >= 60_000 ? 256 * 1024 : 64 * MIB,
  };
}

export async function runWallClockSoak(
  configuration: SoakConfiguration,
  signal?: AbortSignal,
): Promise<SoakReport> {
  validateConfiguration(configuration);
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  const gcExposed = typeof gc === "function";
  if (configuration.requireExposedGc && !gcExposed) {
    throw new Error("This soak mode requires Node --expose-gc for retained-heap sampling");
  }
  const startedAt = new Date();
  const started = performance.now();
  const samples: MemorySample[] = [];
  const book = new OrderBook(0.1);
  book.loadSnapshot(makeSnapshot());
  const analytics = new AnalyticsEngine({ trendEnterScore: 65, trendExitScore: 50 });
  const eventsPerCycle = Math.round(
    configuration.marketEventsPerSecond * configuration.cycleIntervalMs / 1_000,
  );
  const depthPerCycle = Math.floor(eventsPerCycle / 4);
  const tradesPerCycle = eventsPerCycle - depthPerCycle;
  const eventClockStart = 1_735_700_000_000;
  let sequence = 50_000;
  let eventsProcessed = 0;
  let cycle = 0;
  let nextSampleAt = 0;
  let aborted = false;

  collectSample(samples, 0, eventsProcessed, gc);
  nextSampleAt += configuration.sampleIntervalMs;

  while (performance.now() - started < configuration.durationMs) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const cycleTimestamp = eventClockStart + cycle * configuration.cycleIntervalMs;
    for (let index = 0; index < depthPerCycle; index += 1) {
      const next = sequence + 1;
      const quantity = 1 + ((cycle * 19 + index * 23) % 400) / 100;
      const update: DepthUpdate = {
        exchangeTimestamp: cycleTimestamp + Math.floor(index / 3),
        receivedTimestamp: cycleTimestamp + Math.floor(index / 3) + 2,
        sequenceStart: next,
        sequenceEnd: next,
        previousSequence: sequence,
        bids: [[63_999.9, quantity]],
        asks: [[64_000.1, 5.5 - quantity / 2]],
      };
      const result = book.applyUpdate(update);
      if (result.status !== "applied") {
        throw new Error(`Soak depth ${next} was ${result.status}: ${result.reason ?? "unknown"}`);
      }
      sequence = next;
      eventsProcessed += 1;
    }
    for (let index = 0; index < tradesPerCycle; index += 1) {
      const buy = (cycle + index) % 2 === 0;
      const trade: NormalizedTrade = {
        id: `soak-${cycle}-${index}`,
        exchangeTimestamp: cycleTimestamp + Math.floor(index / 9),
        receivedTimestamp: cycleTimestamp + Math.floor(index / 9) + 2,
        price: buy ? 64_000.1 : 63_999.9,
        quantity: 0.01 + ((cycle * 11 + index * 7) % 50) / 1_000,
        side: buy ? "buy" : "sell",
      };
      analytics.onTrade(trade);
      eventsProcessed += 1;
    }
    analytics.compute(book, cycleTimestamp + configuration.cycleIntervalMs - 1, false);
    cycle += 1;

    const deadline = started + cycle * configuration.cycleIntervalMs;
    const waitMs = deadline - performance.now();
    if (waitMs > 0) await interruptibleDelay(waitMs, signal);
    const elapsed = performance.now() - started;
    if (elapsed >= nextSampleAt) {
      collectSample(samples, elapsed, eventsProcessed, gc);
      while (nextSampleAt <= elapsed) nextSampleAt += configuration.sampleIntervalMs;
    }
  }

  const actualWallDurationMs = performance.now() - started;
  if (
    samples.length === 0 ||
    actualWallDurationMs - (samples.at(-1)?.elapsedMs ?? 0) >= configuration.sampleIntervalMs / 2
  ) {
    collectSample(samples, actualWallDurationMs, eventsProcessed, gc);
  }
  const trend = analyzeMemoryTrend(samples, configuration);
  const completionToleranceMs = Math.max(25, configuration.cycleIntervalMs * 0.25);
  const completedRequestedDuration =
    !aborted && actualWallDurationMs + completionToleranceMs >= configuration.durationMs;
  const expectedEvents =
    configuration.marketEventsPerSecond * (configuration.durationMs / 1_000);
  const processedAtLeastConfiguredRate = eventsProcessed >= expectedEvents * 0.98;
  const noSuspectedUnboundedGrowth = !trend.suspectedUnboundedGrowth;
  const passed =
    completedRequestedDuration &&
    processedAtLeastConfiguredRate &&
    noSuspectedUnboundedGrowth;
  const completedAt = new Date();

  return {
    validationSchemaVersion: VALIDATION_SCHEMA_VERSION,
    kind: "phase-1-wall-clock-soak",
    mode: configuration.mode,
    wallClock: true,
    acceleratedEventClock: false,
    qualification:
      configuration.mode === "quick"
        ? "smoke-only"
        : configuration.mode === "full-8h"
          ? "eight-hour-exit-gate"
          : "custom-diagnostic",
    status: aborted ? "aborted" : passed ? "passed" : "failed",
    configuration,
    runtime: {
      gcExposed,
      requestedWallDurationMs: configuration.durationMs,
      actualWallDurationMs: round(actualWallDurationMs, 3),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      eventsProcessed,
      achievedEventsPerSecond: round(eventsProcessed / (actualWallDurationMs / 1_000), 3),
    },
    memory: { trend, samples },
    assertions: {
      completedRequestedDuration,
      processedAtLeastConfiguredRate,
      noSuspectedUnboundedGrowth,
    },
    notes: buildSoakNotes(configuration, gcExposed, trend),
  };
}

export function analyzeMemoryTrend(
  allSamples: MemorySample[],
  configuration: SoakConfiguration,
): MemoryTrend {
  const samples = allSamples.filter((sample) => sample.elapsedMs >= configuration.warmupMs);
  const empty: MemoryTrend = {
    sampleCount: samples.length,
    durationMs: 0,
    heapStartBytes: samples[0]?.heapUsedBytes ?? 0,
    heapEndBytes: samples.at(-1)?.heapUsedBytes ?? 0,
    heapNetGrowthBytes: 0,
    heapSlopeBytesPerMinute: 0,
    rSquared: 0,
    positiveIntervalRatio: 0,
    suspectedUnboundedGrowth: false,
    conclusive: false,
    reasons: [],
  };
  if (samples.length < 2) {
    empty.reasons.push("Insufficient post-warmup memory samples");
    return empty;
  }

  const first = samples[0]!;
  const last = samples.at(-1)!;
  const x = samples.map((sample) => (sample.elapsedMs - first.elapsedMs) / MINUTE_MS);
  const y = samples.map((sample) => sample.heapUsedBytes);
  const regression = linearRegression(x, y);
  let positive = 0;
  for (let index = 1; index < y.length; index += 1) {
    if (y[index]! > y[index - 1]!) positive += 1;
  }
  const positiveIntervalRatio = positive / (y.length - 1);
  const netGrowth = last.heapUsedBytes - first.heapUsedBytes;
  const conclusive = samples.length >= configuration.minimumTrendSamples;
  const exceedsGrowth = netGrowth > configuration.maximumRetainedGrowthBytes;
  const exceedsSlope = regression.slope > configuration.maximumSlopeBytesPerMinute;
  const coherent =
    regression.rSquared >= configuration.minimumRSquared &&
    positiveIntervalRatio >= configuration.minimumPositiveIntervalRatio;
  const suspected = conclusive && exceedsGrowth && exceedsSlope && coherent;
  const reasons: string[] = [];
  if (!conclusive) reasons.push(
    `Only ${samples.length} post-warmup samples; ${configuration.minimumTrendSamples} required`,
  );
  if (exceedsGrowth) reasons.push("Retained heap net growth exceeds configured bound");
  if (exceedsSlope) reasons.push("Retained heap regression slope exceeds configured bound");
  if (coherent) reasons.push("Growth is sustained by regression and positive-interval checks");
  if (suspected) reasons.push("All unbounded-growth detection conditions are met");

  return {
    sampleCount: samples.length,
    durationMs: round(last.elapsedMs - first.elapsedMs, 3),
    heapStartBytes: first.heapUsedBytes,
    heapEndBytes: last.heapUsedBytes,
    heapNetGrowthBytes: netGrowth,
    heapSlopeBytesPerMinute: round(regression.slope, 3),
    rSquared: round(regression.rSquared, 6),
    positiveIntervalRatio: round(positiveIntervalRatio, 6),
    suspectedUnboundedGrowth: suspected,
    conclusive,
    reasons,
  };
}

function collectSample(
  samples: MemorySample[],
  elapsedMs: number,
  eventsProcessed: number,
  gc: (() => void) | undefined,
): void {
  gc?.();
  const memory = process.memoryUsage();
  samples.push({
    elapsedMs: round(elapsedMs, 3),
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    externalBytes: memory.external,
    eventsProcessed,
  });
}

function linearRegression(x: number[], y: number[]): { slope: number; rSquared: number } {
  const xMean = mean(x);
  const yMean = mean(y);
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;
  for (let index = 0; index < x.length; index += 1) {
    const xDelta = x[index]! - xMean;
    const yDelta = y[index]! - yMean;
    covariance += xDelta * yDelta;
    xVariance += xDelta ** 2;
    yVariance += yDelta ** 2;
  }
  const slope = xVariance > 0 ? covariance / xVariance : 0;
  const rSquared = xVariance > 0 && yVariance > 0
    ? Math.max(0, Math.min(1, covariance ** 2 / (xVariance * yVariance)))
    : 0;
  return { slope, rSquared };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function makeSnapshot(): DepthSnapshot {
  const bids: DepthSnapshot["bids"] = [];
  const asks: DepthSnapshot["asks"] = [];
  for (let level = 1; level <= 80; level += 1) {
    bids.push([64_000 - level * 0.1, 1 + level / 20]);
    asks.push([64_000 + level * 0.1, 1 + level / 20]);
  }
  return {
    lastUpdateId: 50_000,
    exchangeTimestamp: 1_735_700_000_000,
    bids,
    asks,
  };
}

function validateConfiguration(configuration: SoakConfiguration): void {
  if (!Number.isFinite(configuration.durationMs) || configuration.durationMs < 1_000) {
    throw new Error("Soak duration must be at least 1 second");
  }
  if (configuration.warmupMs < 0 || configuration.warmupMs >= configuration.durationMs) {
    throw new Error("Warmup must be non-negative and shorter than soak duration");
  }
  if (
    configuration.sampleIntervalMs <= 0 ||
    configuration.cycleIntervalMs <= 0 ||
    configuration.marketEventsPerSecond <= 0
  ) {
    throw new Error("Sample interval, cycle interval, and event rate must be positive");
  }
  const eventsPerCycle =
    configuration.marketEventsPerSecond * configuration.cycleIntervalMs / 1_000;
  if (!Number.isInteger(eventsPerCycle) || eventsPerCycle < 4) {
    throw new Error("Configured market event rate must yield at least four whole events per cycle");
  }
}

function buildSoakNotes(
  configuration: SoakConfiguration,
  gcExposed: boolean,
  trend: MemoryTrend,
): string[] {
  const notes: string[] = [];
  if (configuration.mode === "quick") {
    notes.push("Quick mode is a wall-clock smoke test and does not satisfy the Phase 1 eight-hour exit gate.");
  }
  if (configuration.mode === "full-8h") {
    notes.push("Full mode measures eight actual wall-clock hours; no accelerated event clock is used.");
  }
  if (!gcExposed) notes.push(
    "GC is not exposed; retained-heap samples include normal garbage-collection timing noise.",
  );
  if (!trend.conclusive) notes.push("Memory trend did not reach the configured minimum sample count.");
  return notes;
}

async function interruptibleDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
