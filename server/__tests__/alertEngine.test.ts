import { describe, expect, it } from "vitest";
import {
  AlertEngine,
  ALERT_ALGO_VERSION,
  type AlertRule,
  type AuditEntry,
  type PerformanceRow,
} from "../alerts/alertEngine.js";

function makeEngine(options: { shadowMode?: boolean } = {}) {
  let now = 1_000_000;
  const engine = new AlertEngine({
    shadowMode: options.shadowMode ?? false,
    now: () => now,
    randomId: (() => {
      let counter = 0;
      return () => `id-${(counter += 1)}`;
    })(),
  });
  return {
    engine,
    setNow(value: number) {
      now = value;
    },
    getNow: () => now,
  };
}

describe("phase 5 alert engine", () => {
  it("triggers an absolute trend-score rule once, then enforces cooldown", () => {
    const harness = makeEngine();
    const rule = harness.engine.createRule({
      kind: "trend_score",
      symbol: "*",
      thresholdMode: "absolute",
      absoluteValue: 70,
      op: "above",
      cooldownMs: 60_000,
    });

    const first = harness.engine.evaluate({
      symbol: "BTCUSDT", ts: harness.getNow(), price: 100,
      trendScore: 80, trendDirection: "up", wallTransitions: [],
      volumeDelta: 0, tradeVelocity: 1,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      ruleId: rule.id, kind: "trend_score", value: 80, threshold: 70,
      direction: "bullish", algoVersion: ALERT_ALGO_VERSION,
    });
    expect(first[0]?.reason).toContain("Trend score");

    harness.setNow(harness.getNow() + 1_000);
    const suppressed = harness.engine.evaluate({
      symbol: "BTCUSDT", ts: harness.getNow(), price: 101,
      trendScore: 82, trendDirection: "up", wallTransitions: [],
      volumeDelta: 0, tradeVelocity: 1,
    });
    expect(suppressed).toHaveLength(0);

    const audit = harness.engine.auditTrail(10);
    expect(audit.map((entry: AuditEntry) => entry.kind)).toContain("triggered");
    expect(audit.map((entry: AuditEntry) => entry.kind)).toContain("suppressed_cooldown");
  });

  it("only allows baseline rules after enough per-symbol samples exist", () => {
    const harness = makeEngine();
    harness.engine.createRule({
      kind: "volume_delta",
      symbol: "ETHUSDT",
      thresholdMode: "baseline",
      multiplier: 3,
      op: "above",
      cooldownMs: 5_000,
    });

    // Fewer than BASELINE_MIN_SAMPLES → no median → no trigger even on spikes.
    for (let index = 0; index < 20; index += 1) {
      const triggers = harness.engine.evaluate({
        symbol: "ETHUSDT", ts: harness.getNow() + index * 1_000, price: 3_000,
        trendScore: 0, trendDirection: null, wallTransitions: [],
        volumeDelta: index === 19 ? 500 : 1, tradeVelocity: 2,
      });
      expect(triggers).toHaveLength(0);
    }
    for (let index = 20; index < 40; index += 1) {
      harness.engine.evaluate({
        symbol: "ETHUSDT", ts: harness.getNow() + index * 1_000, price: 3_000,
        trendScore: 0, trendDirection: null, wallTransitions: [],
        volumeDelta: 1, tradeVelocity: 2,
      });
    }
    harness.setNow(harness.getNow() + 45_000);
    const triggered = harness.engine.evaluate({
      symbol: "ETHUSDT", ts: harness.getNow(), price: 3_001,
      trendScore: 0, trendDirection: null, wallTransitions: [],
      volumeDelta: 50, tradeVelocity: 2,
    });
    expect(triggered).toHaveLength(1);
    expect(triggered[0]?.baselineMedian).toBeCloseTo(1, 4);
    // Threshold = median × multiplier = 1 × 3.
    expect(triggered[0]?.threshold).toBeCloseTo(3, 4);
  });

  it("suppresses delivery in shadow mode while still auditing and evaluating", () => {
    const harness = makeEngine({ shadowMode: true });
    harness.engine.createRule({
      kind: "trade_velocity",
      symbol: "*",
      thresholdMode: "absolute",
      absoluteValue: 5,
      cooldownMs: 5_000,
    });
    const triggers = harness.engine.evaluate({
      symbol: "SOLUSDT", ts: harness.getNow(), price: 150,
      trendScore: 0, trendDirection: null, wallTransitions: [],
      volumeDelta: 0, tradeVelocity: 42,
    });
    expect(triggers).toHaveLength(0);
    const kinds = harness.engine.auditTrail(10).map((entry: AuditEntry) => entry.kind);
    expect(kinds).toContain("suppressed_shadow");
    const rows = harness.engine.performance({ kind: "trade_velocity" }) as PerformanceRow[];
    expect(rows.some((row) => row.signalsTriggered > 0)).toBe(true);
  });

  it("resolves horizon evaluations with precision and excursion metrics", () => {
    const harness = makeEngine();
    harness.engine.createRule({
      kind: "trend_score",
      symbol: "BTCUSDT",
      thresholdMode: "absolute",
      absoluteValue: 65,
      op: "above",
      cooldownMs: 5_000,
    });
    const start = harness.getNow();
    harness.engine.evaluate({
      symbol: "BTCUSDT", ts: start, price: 100,
      trendScore: 75, trendDirection: "up", wallTransitions: [],
      volumeDelta: 0, tradeVelocity: 1,
    });

    // Price walks up: +200 bps by t+11s (resolves the 10s horizon), +300 by t+31s.
    harness.setNow(start + 5_000);
    harness.engine.feedPrice("BTCUSDT", start + 5_000, 101);
    harness.setNow(start + 11_000);
    harness.engine.feedPrice("BTCUSDT", start + 11_000, 102);
    harness.setNow(start + 31_000);
    harness.engine.feedPrice("BTCUSDT", start + 31_000, 103);

    const rows = harness.engine.performance({ symbol: "BTCUSDT" });
    const tenSeconds = rows.find((row) => row.horizonMs === 10_000);
    expect(tenSeconds).toBeDefined();
    expect(tenSeconds?.signalsResolved).toBeGreaterThan(0);
    expect(tenSeconds?.favorable).toBe(tenSeconds?.signalsResolved);
    expect(tenSeconds?.precision).toBe(1);
    expect(tenSeconds?.avgFavorableExcursionBps).toBeGreaterThanOrEqual(100);

    for (const row of rows.filter((entry) => entry.horizonMs === 300_000)) {
      expect(row.signalsResolved).toBe(0);
    }
  });

  it("audits rule lifecycle changes and restores persisted rules verbatim", () => {
    const harness = makeEngine();
    const created = harness.engine.createRule({
      kind: "liquidity_wall", symbol: "ETHUSDT", thresholdMode: "baseline",
      multiplier: 2, wallState: "appeared", cooldownMs: 10_000,
    });
    expect(created.wallState).toBe("appeared");
    harness.engine.updateRule(created.id, { enabled: false });
    expect(harness.engine.deleteRule(created.id)).toBe(true);

    const restored: AlertRule[] = [{
      id: "restored-1", symbol: "*", kind: "trend_score", thresholdMode: "absolute",
      absoluteValue: 55, op: "above", cooldownMs: 30_000,
      sound: true, enabled: true, createdBy: "file", createdAtMs: 1, updatedAtMs: 1,
    }];
    expect(harness.engine.restoreRules(restored)).toBe(1);
    expect(harness.engine.listRules().some((rule) => rule.id === "restored-1")).toBe(true);

    const kinds = harness.engine.auditTrail(10).map((entry) => entry.kind);
    for (const expected of ["created", "updated", "deleted"]) {
      expect(kinds).toContain(expected);
    }
  });
});