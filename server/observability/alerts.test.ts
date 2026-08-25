import { describe, expect, it } from "vitest";
import { AlertEvaluator, type AlertInputs } from "./alerts.js";

function baseInput(): AlertInputs {
  const now = 1_700_000_000_000;
  return {
    staleMs: null,
    staleAfterMs: 3_000,
    httpErrorDelta: 0,
    windowSeconds: 1,
    sequenceGapDelta: 0,
    resyncDelta: 0,
    memoryRatio: 0.2,
    memoryWarnRatio: 0.8,
    memoryCriticalRatio: 0.9,
    httpErrorRatePerSecond: 0.5,
    resyncStormThreshold: 3,
  };
}

const NOW = 1_700_000_000_000;

describe("alert evaluator", () => {
  it("fires stale_feed critical when the market is stale beyond the threshold", () => {
    const evaluator = new AlertEvaluator({ emit: () => undefined });
    const fired = evaluator.evaluate({
      ...baseInput(),
      staleMs: 3_500,
      windowSeconds: 1,
    });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ rule: "stale_feed", severity: "critical", active: true });
  });

  it("does not fire while the feed is fresh", () => {
    const evaluator = new AlertEvaluator({ emit: () => undefined });
    expect(evaluator.evaluate(baseInput())).toHaveLength(0);
  });

  it("fires sequence_gap on new gaps and resolves when the window clears", () => {
    const evaluator = new AlertEvaluator({ emit: () => undefined });
    const first = evaluator.evaluate({ ...baseInput(), sequenceGapDelta: 1 });
    expect(first.map((event) => event.rule)).toContain("sequence_gap");
    const second = evaluator.evaluate(baseInput());
    expect(second.map((event) => event.rule)).toContain("sequence_gap");
    expect(second.at(-1)).toMatchObject({ rule: "sequence_gap", active: false });
  });

  it("fires recovery_loop when resyncs exceed the storm threshold", () => {
    const evaluator = new AlertEvaluator({ emit: () => undefined, resyncStormThreshold: 3 });
    const fired = evaluator.evaluate({ ...baseInput(), resyncDelta: 3 });
    expect(fired.map((event) => event.rule)).toContain("recovery_loop");
  });

  it("fires memory_pressure at the warning and critical thresholds", () => {
    const evaluator = new AlertEvaluator({ emit: () => undefined });
    const warning = evaluator.evaluate({ ...baseInput(), memoryRatio: 0.81 });
    expect(warning.map((event) => event.rule)).toContain("memory_pressure");
    const evaluator2 = new AlertEvaluator({ emit: () => undefined });
    const critical = evaluator2.evaluate({ ...baseInput(), memoryRatio: 0.91 });
    expect(critical.map((event) => event.rule)).toContain("memory_pressure");
    expect(critical.at(-1)?.message).toContain("critical");
  });

  it("fires http_error_rate from a 5xx delta in the window", () => {
    const evaluator = new AlertEvaluator({ emit: () => {} });
    const fired = evaluator.evaluate({ ...baseInput(), httpErrorDelta: 6, windowSeconds: 10 });
    expect(fired.map((event) => event.rule)).toContain("http_error_rate");
  });

  it("retains fired events in the bounded recent buffer", () => {
    const evaluator = new AlertEvaluator({ emit: () => {}, maxRecentEvents: 2 });
    evaluator.evaluate({ ...baseInput(), sequenceGapDelta: 1 });
    evaluator.evaluate({ ...baseInput(), httpErrorDelta: 7, windowSeconds: 10 });
    evaluator.evaluate({ ...baseInput(), resyncDelta: 4 });
    expect(evaluator.recent.length).toBeLessThanOrEqual(2);
    const snapshot = evaluator.snapshot();
    expect(snapshot.recent).toHaveLength(2);
  });

  it("records alert transitions in order", () => {
    const evaluator = new AlertEvaluator({ emit: () => {} });
    evaluator.evaluate({ ...baseInput(), staleMs: 5_000 });
    evaluator.evaluate(baseInput());
    const rulesFired = evaluator.recent.map((event) => event.rule);
    expect(rulesFired).toEqual(["stale_feed", "stale_feed"]);
    expect(evaluator.recent[0]).toMatchObject({ active: true });
    expect(evaluator.recent[1]).toMatchObject({ active: false });
  });
});