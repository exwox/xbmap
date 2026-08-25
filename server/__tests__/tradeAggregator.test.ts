import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { TradeAggregator } from "../core/tradeAggregator.js";
import type { NormalizedTrade } from "../types.js";

function trade(
  timestamp: number,
  price: number,
  quantity: number,
  side: NormalizedTrade["side"],
): NormalizedTrade {
  return {
    id: `${timestamp}-${side}-${quantity}`,
    exchangeTimestamp: timestamp,
    receivedTimestamp: timestamp,
    price,
    quantity,
    side,
  };
}

describe("TradeAggregator", () => {
  it("groups the same time/price/side and keeps VWAP and maximum trade", () => {
    const aggregator = new TradeAggregator(250, 0.1);
    aggregator.add(trade(1_010, 100.01, 2, "buy"));
    aggregator.add(trade(1_100, 100.04, 3, "buy"));
    aggregator.add(trade(1_120, 100.04, 1, "sell"));

    const buckets = aggregator.flushCompleted(1_250);
    assert.equal(buckets.length, 2);
    const buy = buckets.find((bucket) => bucket.side === "buy")!;
    assert.equal(buy.price, 100);
    assert.equal(buy.volume, 5);
    assert.equal(buy.tradeCount, 2);
    assert.equal(buy.maxTrade, 3);
    assert.equal(buy.buyVolume, 5);
    assert.equal(buy.delta, 5);
    assert.ok(Math.abs(buy.vwap - 100.028) < 1e-9);
  });

  it("does not flush a bucket before its end", () => {
    const aggregator = new TradeAggregator(250, 0.1);
    aggregator.add(trade(1_010, 100, 1, "buy"));
    assert.deepEqual(aggregator.flushCompleted(1_249), []);
    assert.equal(aggregator.flushCompleted(1_250).length, 1);
  });

  it("drops malformed trades", () => {
    const aggregator = new TradeAggregator(250, 0.1);
    aggregator.add(trade(1_010, 100, -1, "buy"));
    assert.deepEqual(aggregator.flushAll(), []);
  });
});
