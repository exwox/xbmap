import { describe, expect, it } from "vitest";
import { validateThreeTimesBurst } from "./burst-validation.js";
import { validateDisconnectDuringReconciliation } from "./disconnect-validation.js";
import { validateCoreFaults } from "./fault-validation.js";
import { validateReplayRepeatability } from "./replay-validation.js";
import {
  analyzeMemoryTrend,
  customSoakConfiguration,
  fullEightHourSoakConfiguration,
  quickSoakConfiguration,
} from "./soak-core.js";
import type { MemorySample } from "./types.js";

describe("Phase 1 deterministic fault validation", () => {
  it("detects lost, duplicate, late/out-of-order, malformed, and crossed updates", async () => {
    const results = await validateCoreFaults();
    expect(results.map((result) => result.id)).toEqual([
      "lost-event",
      "duplicate-event",
      "late-out-of-order-event",
      "malformed-event",
      "crossed-update",
    ]);
    expect(results.filter((result) => !result.passed)).toEqual([]);
  });

  it("replays every committed fixture to the same complete outcome and fingerprint", async () => {
    const result = await validateReplayRepeatability();
    expect(result).toMatchObject({ id: "replay-repeatability", passed: true });
  });

  it("processes at least three times the Phase 0 peak workload", async () => {
    const result = await validateThreeTimesBurst(3, 1);
    expect(result).toMatchObject({ id: "burst-three-times-baseline", passed: true });
    expect(observation(result, "modeledMarketEventsPerSecond")).toBeGreaterThanOrEqual(1_200);
    expect(observation(result, "rejectedDepthUpdates")).toBe(0);
  });

  it("does not publish a disconnected in-flight reconciliation generation", async () => {
    const result = await validateDisconnectDuringReconciliation();
    expect(result).toMatchObject({
      id: "disconnect-during-reconciliation",
      passed: true,
    });
  });
});

describe("Phase 1 wall-clock soak trend analysis", () => {
  it("keeps quick smoke and explicit eight-hour gate semantically distinct", () => {
    const quick = quickSoakConfiguration();
    const full = fullEightHourSoakConfiguration();
    expect(quick).toMatchObject({ mode: "quick", durationMs: 5_000, requireExposedGc: false });
    expect(full).toMatchObject({
      mode: "full-8h",
      durationMs: 8 * 60 * 60_000,
      requireExposedGc: true,
    });
  });

  it("flags a coherent, unbounded retained-heap trend", () => {
    const configuration = {
      ...customSoakConfiguration(20 * 60_000),
      warmupMs: 0,
      minimumTrendSamples: 8,
      maximumRetainedGrowthBytes: 2 * 1024 * 1024,
      maximumSlopeBytesPerMinute: 512 * 1024,
      minimumRSquared: 0.8,
      minimumPositiveIntervalRatio: 0.8,
    };
    const samples = memorySamples([10, 12, 14, 16, 18, 20, 22, 24, 26]);
    const trend = analyzeMemoryTrend(samples, configuration);
    expect(trend).toMatchObject({
      conclusive: true,
      suspectedUnboundedGrowth: true,
      positiveIntervalRatio: 1,
    });
    expect(trend.rSquared).toBe(1);
  });

  it("does not call a bounded oscillating heap an unbounded leak", () => {
    const configuration = {
      ...customSoakConfiguration(20 * 60_000),
      warmupMs: 0,
      minimumTrendSamples: 8,
      maximumRetainedGrowthBytes: 2 * 1024 * 1024,
      maximumSlopeBytesPerMinute: 512 * 1024,
      minimumRSquared: 0.8,
      minimumPositiveIntervalRatio: 0.8,
    };
    const samples = memorySamples([20, 21, 19, 20, 22, 19, 21, 20, 20]);
    const trend = analyzeMemoryTrend(samples, configuration);
    expect(trend).toMatchObject({
      conclusive: true,
      suspectedUnboundedGrowth: false,
    });
  });
});

function observation(
  result: Awaited<ReturnType<typeof validateThreeTimesBurst>>,
  key: string,
): number {
  const value = result.observations.find((candidate) => candidate.key === key)?.value;
  if (typeof value !== "number") throw new Error(`Missing numeric observation ${key}`);
  return value;
}

function memorySamples(heapMib: number[]): MemorySample[] {
  return heapMib.map((heap, index) => ({
    elapsedMs: index * 60_000,
    heapUsedBytes: heap * 1024 * 1024,
    rssBytes: (heap + 50) * 1024 * 1024,
    externalBytes: 1_000_000,
    eventsProcessed: index * 72_000,
  }));
}
