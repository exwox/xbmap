import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryPersistence } from "../historyPersistence.js";
import type { MetricFrame, TrendSignal } from "../types.js";

describe("HistoryPersistence gateway runtime", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("persists interval facts across restart and creates idempotent 5s rollups", async () => {
    const root = await mkdtemp(join(tmpdir(), "liquidmap-history-runtime-"));
    roots.push(root);
    const directory = join(root, "history");
    const start = 1_700_000_000_000;
    const captureId = "runtime-capture";
    const first = await HistoryPersistence.open({
      directory,
      symbol: "BTCUSDT",
      tickSize: 0.1,
      batchRecords: 3,
      flushIntervalMs: 10,
      retentionIntervalMs: 60 * 60_000,
    });

    for (let second = 0; second < 5; second += 1) {
      const intervalStart = start + second * 1_000;
      const buyVolume = second + 1;
      const sellVolume = second / 2;
      expect(first.recordMetric(
        captureId,
        metric(second),
        trend(second),
        {
          intervalStart,
          intervalEnd: intervalStart + 1_000,
          buyVolume,
          sellVolume,
          tradeCount: second + 1,
        },
        digest(`book-${second}`),
      )).toBe(true);
    }
    await first.close();

    const restarted = await HistoryPersistence.open({
      directory,
      symbol: "BTCUSDT",
      tickSize: 0.1,
      retentionIntervalMs: 60 * 60_000,
    });
    const oneSecond = await restarted.queryHistory(start, start + 4_999, 1_000, 100);
    const fiveSeconds = await restarted.queryHistory(start, start + 4_999, 5_000, 100);

    expect(oneSecond.items).toHaveLength(5);
    expect(oneSecond.items[0]).toMatchObject({ volume: 1, delta: 1 });
    expect(oneSecond.items[4]).toMatchObject({ volume: 7, delta: 3 });
    expect(fiveSeconds.items).toHaveLength(1);
    expect(fiveSeconds.items[0]).toMatchObject({
      timestamp: start,
      volume: 20,
      delta: 10,
      cvd: 4,
    });
    await restarted.close();
  });
});

function metric(index: number): MetricFrame {
  return {
    lastPrice: 64_000 + index,
    bestBid: 63_999.9 + index,
    bestAsk: 64_000.1 + index,
    spread: 0.2,
    delta: index,
    cvd: index,
    buyVolume: index + 10,
    sellVolume: index + 5,
    buySellRatio: 1,
    imbalance: 0.1,
    tradeRate: 1,
    volumeRatio: 1,
    momentumShort: 0,
    momentumMedium: 0,
    latencyMs: 1,
    stale: false,
  };
}

function trend(index: number): TrendSignal {
  return {
    direction: "up",
    score: 70 + index,
    upScore: 70 + index,
    downScore: 10,
    confidence: 0.8,
    active: true,
    strength: "strong",
    reasons: ["test"],
    since: 1_700_000_000_000,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
