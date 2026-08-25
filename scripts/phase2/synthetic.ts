import { createHash } from "node:crypto";
import type { HistoricalRecord } from "../../server/storage/types.js";

export const SYNTHETIC_EXCHANGE = "binance" as const;
export const SYNTHETIC_SYMBOL = "BTCUSDT";
export const SYNTHETIC_CAPTURE_ID = "phase2-synthetic-hour";
export const SYNTHETIC_HOUR_START = Date.UTC(2025, 0, 1, 0, 0, 0);
export const SYNTHETIC_HOUR_END = SYNTHETIC_HOUR_START + 60 * 60_000 - 1;

/**
 * Deterministic one-hour projection fixture. It is intentionally generated at
 * test time so no market data with uncertain redistribution rights enters the
 * repository.
 */
export function syntheticHourRecords(): HistoricalRecord[] {
  const records: HistoricalRecord[] = [];
  let captureSequence = 0;
  let updateId = 10_000;

  records.push(snapshotRecord(++captureSequence, SYNTHETIC_HOUR_START, updateId));

  for (let second = 0; second < 3_600; second += 1) {
    const timestamp = SYNTHETIC_HOUR_START + second * 1_000;
    const previousUpdateId = updateId;
    updateId += 1;
    const priceTicks = 640_000 + Math.floor(second / 30) + (second % 4) - 2;
    const side = second % 3 === 0 ? "sell" : "buy";

    records.push(asHistoricalRecord({
      ...common(++captureSequence, timestamp),
      kind: "depth_delta",
      sequenceStart: updateId,
      sequenceEnd: updateId,
      previousSequence: previousUpdateId,
      tickSize: 0.1,
      bids: [[priceTicks - 1, canonicalQuantity(5 + (second % 17) / 10)]],
      asks: [[priceTicks + 1, canonicalQuantity(4 + (second % 13) / 10)]],
    }));
    records.push(asHistoricalRecord({
      ...common(++captureSequence, timestamp + 100),
      kind: "trade",
      tradeId: `phase2-trade-${second}`,
      priceTicks,
      tickSize: 0.1,
      quantity: canonicalQuantity(0.01 + (second % 25) / 100),
      side,
    }));
    records.push(asHistoricalRecord({
      ...common(++captureSequence, timestamp + 999),
      kind: "metric_frame",
      resolutionMs: 1_000,
      intervalStart: timestamp,
      intervalEnd: timestamp + 1_000,
      intervalBuyVolume: side === "buy" ? 1 : 0,
      intervalSellVolume: side === "sell" ? 1 : 0,
      intervalTradeCount: 1,
      metric: {
        lastPrice: priceTicks * 0.1,
        bestBid: (priceTicks - 1) * 0.1,
        bestAsk: (priceTicks + 1) * 0.1,
        spread: 0.2,
        delta: side === "buy" ? 1 : -1,
        cvd: second % 2 === 0 ? second / 10 : -second / 10,
        buyVolume: side === "buy" ? 1 : 0,
        sellVolume: side === "sell" ? 1 : 0,
        buySellRatio: side === "buy" ? 2 : 0.5,
        imbalance: ((second % 21) - 10) / 10,
        tradeRate: 1,
        volumeRatio: 1 + (second % 10) / 10,
        momentumShort: (second % 7) - 3,
        momentumMedium: (second % 13) - 6,
        latencyMs: 2,
        stale: false,
      },
      trend: {
        direction: second % 120 < 60 ? "up" : "down",
        score: 70,
        upScore: second % 120 < 60 ? 70 : 30,
        downScore: second % 120 < 60 ? 30 : 70,
        confidence: 0.7,
        active: true,
        strength: "strong",
        reasons: ["deterministic synthetic fixture"],
        since: timestamp,
      },
      bookFingerprint: null,
      analyticsFingerprint: null,
    }));

    if (second > 0 && second % 300 === 0) {
      records.push(snapshotRecord(++captureSequence, timestamp, updateId));
    }
  }

  return records;
}

export function syntheticTradeRecord(
  captureSequence: number,
  exchangeTimestamp: number,
  captureId = SYNTHETIC_CAPTURE_ID,
): HistoricalRecord {
  return asHistoricalRecord({
    ...common(captureSequence, exchangeTimestamp, captureId),
    kind: "trade",
    tradeId: `${captureId}-${captureSequence}`,
    priceTicks: 640_000 + captureSequence,
    tickSize: 0.1,
    quantity: canonicalQuantity(0.01 + (captureSequence % 10) / 100),
    side: captureSequence % 2 === 0 ? "buy" : "sell",
  });
}

function snapshotRecord(
  captureSequence: number,
  timestamp: number,
  lastUpdateId: number,
): HistoricalRecord {
  const bids: [number, string][] = [
    [639_999, "5"],
    [639_998, "7.5"],
  ];
  const asks: [number, string][] = [
    [640_001, "4.5"],
    [640_002, "8"],
  ];
  return asHistoricalRecord({
    ...common(captureSequence, timestamp),
    kind: "depth_snapshot",
    lastUpdateId,
    tickSize: 0.1,
    bids,
    asks,
    stateFingerprint: createHash("sha256")
      .update(JSON.stringify({ lastUpdateId, bids, asks }))
      .digest("hex"),
  });
}

function common(
  captureSequence: number,
  exchangeTimestamp: number,
  captureId = SYNTHETIC_CAPTURE_ID,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    exchange: SYNTHETIC_EXCHANGE,
    symbol: SYNTHETIC_SYMBOL,
    captureId,
    captureSequence,
    exchangeTimestamp,
    receivedTimestamp: exchangeTimestamp + 2,
  };
}

function canonicalQuantity(value: number): string {
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function asHistoricalRecord(value: Record<string, unknown>): HistoricalRecord {
  return value as unknown as HistoricalRecord;
}
