import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  scoreTrend,
  TrendDetector,
  type TrendFeatures,
} from "../core/analytics.js";

const strongUp: TrendFeatures = {
  momentumShort: 0.003,
  momentumMedium: 0.008,
  deltaRatio: 0.8,
  cvdSlope: 0.65,
  imbalance: 0.55,
  volumeRatio: 2.8,
  breakout: 1,
  spreadBps: 0.5,
  valid: true,
};

describe("trend analytics", () => {
  it("scores aligned bullish features high and explains the result", () => {
    const result = scoreTrend(strongUp);
    assert.ok(result.upScore >= 80);
    assert.ok(result.downScore < 20);
    assert.ok(result.upReasons.includes("Buy volume delta"));
    assert.ok(result.upReasons.includes("Local high breakout"));
  });

  it("mirrors the formula for bearish features", () => {
    const result = scoreTrend({
      ...strongUp,
      momentumShort: -strongUp.momentumShort,
      momentumMedium: -strongUp.momentumMedium,
      deltaRatio: -strongUp.deltaRatio,
      cvdSlope: -strongUp.cvdSlope,
      imbalance: -strongUp.imbalance,
      breakout: -1,
    });
    assert.ok(result.downScore >= 80);
    assert.ok(result.upScore < 20);
    assert.ok(result.downReasons.includes("Sell volume delta"));
  });

  it("enters after confirmation and exits below the hysteresis threshold", () => {
    const detector = new TrendDetector(65, 50, 3);
    assert.equal(detector.update(strongUp, 1).active, false);
    assert.equal(detector.update(strongUp, 2).active, false);
    const entered = detector.update(strongUp, 3);
    assert.equal(entered.active, true);
    assert.equal(entered.direction, "up");
    assert.equal(entered.since, 3);

    const quiet: TrendFeatures = {
      ...strongUp,
      momentumShort: 0,
      momentumMedium: 0,
      deltaRatio: 0,
      cvdSlope: 0,
      imbalance: 0,
      volumeRatio: 0,
      breakout: 0,
    };
    assert.equal(detector.update(quiet, 4).active, true);
    assert.equal(detector.update(quiet, 5).active, false);
  });

  it("immediately invalidates a signal when data quality is bad", () => {
    const detector = new TrendDetector(65, 50, 1);
    assert.equal(detector.update(strongUp, 1).active, true);
    const stale = detector.update({ ...strongUp, valid: false }, 2);
    assert.equal(stale.active, false);
    assert.equal(stale.direction, "neutral");
    assert.equal(stale.score, 0);
  });
});
