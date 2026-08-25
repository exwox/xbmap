import { describe, expect, it } from "vitest";
import {
  InsightEngine,
  type InsightFrame,
} from "../insights/insightEngine.js";
import type { ServerEnvelope } from "../types.js";

let sequence = 0;

function envelope(
  type: ServerEnvelope["type"],
  symbol: string,
  data: unknown,
  ts: number,
): ServerEnvelope {
  sequence += 1;
  return {
    type,
    schemaVersion: 1,
    exchange: "binance",
    symbol,
    serverTimestamp: ts,
    exchangeTimestamp: ts,
    sequence,
    data,
  };
}

function makeEngine(overrides: Partial<ConstructorParameters<typeof InsightEngine>[0]> = {}) {
  let now = 1_000;
  const engine = new InsightEngine({
    symbol: "BTCUSDT",
    tickSize: 0.1,
    publishIntervalMs: 0,
    wallConfirmMs: 1_500,
    wallMultiple: 6,
    vwapWindowMs: 60_000,
    profileWindowMs: 300_000,
    addedPulledWindowMs: 10_000,
    liquidationWindowMs: 60_000,
    absorptionWindowMs: 5_000,
    ...overrides,
    now: () => now,
  });
  return {
    engine,
    setNow(value: number) {
      now = value;
    },
    getNow: () => now,
  };
}

/** Market-real floors need large books; helper builds a realistic top. */
const REAL_BOOK = {
  lastUpdateId: 1,
  bids: [[59_999, 8], [60_000, 1], [59_998, 1]],
  asks: [[60_001, 2], [60_002, 1], [60_003, 1]],
};

describe("phase 5 insight engine", () => {
  it("confirms a liquidity wall only after the persistence window and reports transitions", () => {
    const harness = makeEngine();
    const base = { lastUpdateId: 1 };

    // Baseline book: every level quantity 1 → threshold = 6 × 1.
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      ...base,
      bids: [[60_000, 1], [59_999, 1]],
      asks: [[60_001, 1], [60_002, 1]],
    }, 1_000));

    // Big bid appears at t=1100 but has not persisted long enough yet.
    harness.setNow(1_100);
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      ...base, bids: [[60_000, 1], [59_999, 8]], asks: [[60_001, 1], [60_002, 1]],
    }, 1_100));
    const early = harness.engine.snapshotFrame();
    early.generatedAt = 1_100;
    expect(early.walls).toHaveLength(0);
    expect(early.wallTransitions).toHaveLength(0);

    // Still below the confirmation window at +900 ms.
    harness.setNow(2_000);
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      ...base, bids: [[60_000, 1], [59_999, 8]], asks: [[60_001, 1], [60_002, 1]],
    }, 2_000));
    expect(harness.engine.snapshotFrame().walls).toHaveLength(0);

    // At +1_500 ms the candidate becomes a confirmed wall.
    harness.setNow(2_700);
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      ...base, bids: [[60_000, 1], [59_999, 8]], asks: [[60_001, 1], [60_002, 1]],
    }, 2_700));
    const confirmed = harness.engine.snapshotFrame();
    expect(confirmed.walls).toHaveLength(1);
    expect(confirmed.walls[0]).toMatchObject({ side: "bid", price: 59_999, quantity: 8 });
    expect(confirmed.wallTransitions.map((transition) => transition.kind)).toEqual(["appeared"]);

    // Removing the level queues the disappearance.
    harness.setNow(3_000);
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      ...base, bids: [[60_000, 1], [59_999, 1]], asks: [[60_001, 1], [60_002, 1]],
    }, 3_000));
    const gone = harness.engine.snapshotFrame();
    expect(gone.walls).toHaveLength(0);
    expect(gone.wallTransitions.map((transition) => transition.kind)).toEqual(["disappeared"]);
  });

  it("computes rolling VWAP from trade buckets inside the window", () => {
    const harness = makeEngine({ vwapWindowMs: 10_000 });
    harness.engine.handleEvent(envelope("trade_bucket", "BTCUSDT", {
      price: 100, volume: 2, buyVolume: 2, sellVolume: 0, totalVolume: 2, delta: 2, tradeCount: 3,
    }, 5_000));
    harness.engine.handleEvent(envelope("trade_bucket", "BTCUSDT", {
      price: 103, volume: 1, buyVolume: 0, sellVolume: 1, totalVolume: 1, delta: -1, tradeCount: 1,
    }, 6_000));
    const frame: InsightFrame = harness.engine.snapshotFrame();
    expect(frame.rollingVwap.value).toBeCloseTo((100 * 2 + 103 * 1) / 3, 4);

    // Buckets outside the window no longer contribute.
    harness.setNow(80_000);
    const expired = harness.engine.snapshotFrame();
    expect(expired.rollingVwap.value).toBeNull();
  });

  it("accounts added versus pulled liquidity per side", () => {
    const harness = makeEngine({ addedPulledWindowMs: 10_000 });
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      lastUpdateId: 1, bids: [[100, 1], [99, 2]], asks: [[101, 5]],
    }, 1_000));
    harness.setNow(1_500);
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      lastUpdateId: 2, bids: [[100, 3], [98, 4]], asks: [[101, 2], [102, 7]],
    }, 1_500));
    const frame = harness.engine.snapshotFrame();
    // The very first book seeds every level as "added"; frame B then contributes
    // its own diff on top (100 grew +2, new 98 +4; 99 vanished −2).
    expect(frame.addedPulled).toMatchObject({
      bidAddedQuantity: 3 + 6,
      bidPulledQuantity: 2,
      askAddedQuantity: 5 + 7,
      askPulledQuantity: 3,
    });
  });

  it("finds the point of control in the volume profile", () => {
    const harness = makeEngine();
    for (const [price, count] of [[50, 3], [51, 1]] as const) {
      for (let index = 0; index < count; index += 1) {
        harness.engine.handleEvent(envelope("trade_bucket", "BTCUSDT", {
          price, volume: 1, buyVolume: 1, sellVolume: 0, totalVolume: 1, delta: 1, tradeCount: 1,
        }, 1_000 + index));
      }
    }
    const frame = harness.engine.snapshotFrame();
    expect(frame.volumeProfile.pocPrice).toBe(50);
    expect(frame.volumeProfile.totalVolume).toBe(4);
    expect(frame.volumeProfile.nodes[0]).toMatchObject({ price: 50, volume: 3 });
  });

  it("flags absorption when heavy flow lands on a flat book", () => {
    const harness = makeEngine({
      absorptionMinQuantity: 3,
      // Test-scale notional floor; production default is $15k.
      absorptionMinNotionalUsd: 100,
    });
    // Flat mid at 100 across the window (bid/ask symmetric around it).
    const flat = (ts: number) => harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      lastUpdateId: ts, bids: [[99.9, 1]], asks: [[100.1, 1]],
    }, ts));

    flat(1_000);
    harness.engine.handleEvent(envelope("trade_bucket", "BTCUSDT", {
      price: 100, volume: 4, buyVolume: 0, sellVolume: 4, totalVolume: 4, delta: -4, tradeCount: 5,
    }, 2_000));
    flat(2_500);
    harness.setNow(3_000);

    const frame = harness.engine.snapshotFrame();
    expect(frame.absorption).not.toBeNull();
    expect(frame.absorption?.direction).toBe("bullish");
    expect(frame.absorption?.reason).toContain("absorbed");
  });

  it("marks exhaustion when an active trend loses trade-rate momentum", () => {
    const harness = makeEngine();
    harness.engine.handleEvent(envelope("trend_signal", "BTCUSDT", {
      direction: "up", score: 80, upScore: 80, downScore: 10, confidence: 0.8,
      active: true, strength: "strong", reasons: [], since: 1_000,
    }, 1_000));
    // Rising trade rate then fading below 70% of the first half.
    const rates = [40, 44, 48, 52, 20, 22, 24, 26];
    rates.forEach((tradeRate, index) => {
      harness.engine.handleEvent(envelope("metric", "BTCUSDT", {
        tradeRate, delta: 1, stale: false,
      }, 1_000 + index * 500));
    });
    const frame = harness.engine.snapshotFrame();
    expect(frame.exhaustion.direction).toBe("up");
    expect(frame.exhaustion.reason).toContain("faded");
  });

  it("ignores high-multiple levels below the USD-notional wall floor", () => {
    // Median qty = 1 → relative threshold 6; level 8 @ $99.5 clears the
    // multiple (~$796 notional) but fails the real-market USD floor.
    const harness = makeEngine();
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      lastUpdateId: 1, bids: [[100, 1], [99, 1], [99.5, 8]], asks: [[101, 1]],
    }, 1_000));
    harness.setNow(1_100);
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      lastUpdateId: 2, bids: [[100, 1], [99, 1], [99.5, 8]], asks: [[101, 1]],
    }, 1_100));
    harness.setNow(2_800);
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      lastUpdateId: 3, bids: [[100, 1], [99, 1], [99.5, 8]], asks: [[101, 1]],
    }, 2_800));
    const frame = harness.engine.snapshotFrame();
    expect(frame.walls).toHaveLength(0);
    expect(frame.wallTransitions).toHaveLength(0);
  });

  it("rejects absorption once the mid moves beyond the bps tolerance", () => {
    const harness = makeEngine({ absorptionMinNotionalUsd: 50 });
    // Mid drifts ~100 bps (100 → 101): far above the 2 bps tolerance even
    // though traded notional clears the floor.
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      lastUpdateId: 1, bids: [[99.9, 1]], asks: [[100.1, 1]],
    }, 1_000));
    harness.engine.handleEvent(envelope("trade_bucket", "BTCUSDT", {
      price: 100.5, volume: 2, buyVolume: 0, sellVolume: 2, totalVolume: 2,
      delta: -2, tradeCount: 3,
    }, 1_500));
    harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      lastUpdateId: 2, bids: [[100.9, 1]], asks: [[101.1, 1]],
    }, 2_500));
    harness.setNow(3_000);
    expect(harness.engine.snapshotFrame().absorption).toBeNull();
  });

  it("reproduces byte-identical frames from the same event stream", () => {
    const buildSeries = (): InsightFrame => {
      const harness = makeEngine();
      harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
        lastUpdateId: 1, bids: [[60_000, 1], [59_999, 7]], asks: [[60_001, 1]],
      }, 1_000));
      harness.engine.handleEvent(envelope("trade_bucket", "BTCUSDT", {
        price: 60_000, volume: 3, buyVolume: 2, sellVolume: 1, totalVolume: 3,
        delta: 1, tradeCount: 4, vwap: 60_000,
      }, 1_200));
      harness.engine.handleEvent(envelope("metric", "BTCUSDT", { tradeRate: 5, delta: 1, stale: false }, 1_300));
      harness.setNow(2_700);
      harness.engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
        lastUpdateId: 2, bids: [[60_000, 1], [59_999, 7]], asks: [[60_001, 1]],
      }, 2_700));
      const frame = harness.engine.snapshotFrame();
      return JSON.parse(JSON.stringify(frame)) as InsightFrame;
    };

    const first = buildSeries();
    const second = buildSeries();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.algoVersion).toBe("insights-v1");
  });
});
