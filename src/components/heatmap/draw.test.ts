import { describe, expect, it } from "vitest";
import { createDeterministicDemoData } from "./demo";
import {
  calculateDataViewport,
  normalizeTrades,
  preparePriceSeries,
} from "./draw";

describe("heatmap data preparation", () => {
  it("keeps deterministic demo output stable for the same seed", () => {
    const first = createDeterministicDemoData(42);
    const second = createDeterministicDemoData(42);
    const other = createDeterministicDemoData(43);

    expect(first.priceSeries).toEqual(second.priceSeries);
    expect(first.trades).toEqual(second.trades);
    expect(first.priceSeries).not.toEqual(other.priceSeries);
  });

  it("normalizes an unknown aggressor side from volume dominance", () => {
    const [trade] = normalizeTrades([
      {
        timestamp: 1_000,
        price: 100,
        buyVolume: 2,
        sellVolume: 8,
        totalVolume: 10,
        side: "unknown",
      },
    ]);

    expect(trade.side).toBe("sell");
    expect(trade.totalVolume).toBe(10);
  });

  it("derives price points from nullable depth-frame mid prices", () => {
    const prices = preparePriceSeries(
      [],
      [
        {
          timestamp: 1_000,
          bids: [{ price: 99, quantity: 1 }],
          asks: [{ price: 101, quantity: 1 }],
          midPrice: null,
        },
      ],
    );

    expect(prices).toEqual([{ timestamp: 1_000, price: 100 }]);
  });

  it("limits the follow-live viewport to the requested time window", () => {
    const viewport = calculateDataViewport({
      depthFrames: [],
      liquidityCells: [],
      trades: [],
      priceSeries: [
        { timestamp: 0, price: 90 },
        { timestamp: 600_000, price: 100 },
      ],
      timeWindowMs: 240_000,
      fallbackNow: 0,
    });

    expect(viewport.startTime).toBe(360_000);
    expect(viewport.endTime).toBe(600_000);
  });
});

