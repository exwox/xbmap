import { AnalyticsEngine } from "../../server/core/analytics.js";
import { OrderBook } from "../../server/core/orderBook.js";
import type { NormalizedTrade, TrendDirection } from "../../server/types.js";
import { canonicalJson, sha256 } from "./canonical.js";
import type {
  FixtureCheckpointOutcome,
  FixtureExpectedOutcome,
  FixtureScenario,
} from "./schema.js";

export function evaluateScenario(scenario: FixtureScenario): FixtureExpectedOutcome {
  const book = new OrderBook(scenario.market.tickSize);
  const analytics = new AnalyticsEngine({ trendEnterScore: 65, trendExitScore: 50 });
  const trades: NormalizedTrade[] = [];
  const checkpoints: FixtureCheckpointOutcome[] = [];
  const depthResults: FixtureExpectedOutcome["sequence"]["depthResults"] = [];
  const states: FixtureExpectedOutcome["connection"]["states"] = [];
  const depthCounts = {
    applied: 0,
    ignored: 0,
    gap: 0,
    invalid: 0,
    unsynced: 0,
  };

  let snapshotsLoaded = 0;
  let resyncs = 0;
  let statusStale = false;
  let bookValid = false;
  let gapDetected = false;
  let replacementSnapshotLoaded = false;
  let replacementDeltaApplied = false;

  for (const event of scenario.events) {
    switch (event.kind) {
      case "snapshot": {
        book.loadSnapshot(event.data);
        snapshotsLoaded += 1;
        bookValid = true;
        statusStale = false;
        if (gapDetected) replacementSnapshotLoaded = true;
        break;
      }

      case "depth": {
        const result = book.applyUpdate(event.data);
        depthCounts[result.status] += 1;
        depthResults.push({
          ordinal: event.ordinal,
          sequenceStart: event.data.sequenceStart,
          sequenceEnd: event.data.sequenceEnd,
          status: result.status,
          lastUpdateId: result.lastUpdateId,
        });
        if (result.status !== event.expectedBookResult) {
          throw new Error(
            `${scenario.id} event ${event.ordinal}: expected ${event.expectedBookResult}, received ${result.status}`,
          );
        }
        if (result.status === "gap" || result.status === "invalid" || result.status === "unsynced") {
          bookValid = false;
        }
        if (result.status === "gap") gapDetected = true;
        if (result.status === "applied" && replacementSnapshotLoaded) {
          replacementDeltaApplied = true;
        }
        break;
      }

      case "trade":
        trades.push(event.data);
        analytics.onTrade(event.data);
        break;

      case "status":
        statusStale = event.data.stale;
        resyncs = Math.max(resyncs, event.data.resyncCount);
        states.push({
          at: event.at,
          state: event.data.state,
          stale: event.data.stale,
          resyncCount: event.data.resyncCount,
        });
        break;

      case "checkpoint": {
        const valid = bookValid && !statusStale && !event.data.forceInvalid;
        const frame = analytics.compute(book, event.at, !valid);
        checkpoints.push({
          name: event.data.name,
          at: event.at,
          bookValid: valid,
          lastUpdateId: book.lastUpdateId,
          metric: frame.metric,
          trend: frame.trend,
        });
        break;
      }
    }
  }

  const levels = book.getLevels(scenario.market.visibleDepth);
  const bestBid = levels.bids[0]?.[0] ?? null;
  const bestAsk = levels.asks[0]?.[0] ?? null;
  const midPrice = bestBid !== null && bestAsk !== null ? round((bestBid + bestAsk) / 2, 8) : null;
  const spread = bestBid !== null && bestAsk !== null ? round(bestAsk - bestBid, 8) : null;
  const lastCheckpoint = checkpoints.at(-1);
  const activatedDirections = uniqueDirections(
    checkpoints
      .filter((checkpoint) => checkpoint.trend.active)
      .map((checkpoint) => checkpoint.trend.direction),
  );

  return {
    sequence: {
      snapshotsLoaded,
      depthApplied: depthCounts.applied,
      depthIgnored: depthCounts.ignored,
      depthGaps: depthCounts.gap,
      depthInvalid: depthCounts.invalid,
      depthUnsynced: depthCounts.unsynced,
      resyncs,
      finalLastUpdateId: book.lastUpdateId,
      depthResults,
    },
    orderBook: {
      depth: scenario.market.visibleDepth,
      bids: levels.bids,
      asks: levels.asks,
      bestBid,
      bestAsk,
      midPrice,
      spread,
      imbalance: round(book.imbalance(scenario.market.visibleDepth), 8),
      fingerprint: `sha256:${sha256(canonicalJson({
        lastUpdateId: book.lastUpdateId,
        bids: levels.bids,
        asks: levels.asks,
      }))}`,
    },
    trades: summarizeTrades(trades),
    trend: {
      finalDirection: lastCheckpoint?.trend.direction ?? "neutral",
      finalScore: lastCheckpoint?.trend.score ?? 0,
      finalActive: lastCheckpoint?.trend.active ?? false,
      activatedDirections,
      maxUpScore: maximum(checkpoints.map((checkpoint) => checkpoint.trend.upScore)),
      maxDownScore: maximum(checkpoints.map((checkpoint) => checkpoint.trend.downScore)),
      directionTransitions: countTransitions(
        checkpoints.map((checkpoint) => checkpoint.trend.direction),
      ),
    },
    connection: {
      states,
      gapDetected,
      recoveredAfterGap:
        gapDetected &&
        replacementSnapshotLoaded &&
        replacementDeltaApplied &&
        states.some((status) => status.state === "live" && status.at > (states.find((status) => status.state === "reconnecting")?.at ?? Infinity)),
    },
    checkpoints,
  };
}

function summarizeTrades(trades: NormalizedTrade[]): FixtureExpectedOutcome["trades"] {
  const buys = trades.filter((trade) => trade.side === "buy");
  const sells = trades.filter((trade) => trade.side === "sell");
  const prices = trades.map((trade) => trade.price);
  const firstPrice = prices[0] ?? null;
  const lastPrice = prices.at(-1) ?? null;
  let squaredLogReturns = 0;
  for (let index = 1; index < prices.length; index += 1) {
    const previous = prices[index - 1];
    const current = prices[index];
    if (previous !== undefined && current !== undefined && previous > 0 && current > 0) {
      squaredLogReturns += Math.log(current / previous) ** 2;
    }
  }
  const buyVolume = sumVolume(buys);
  const sellVolume = sumVolume(sells);
  return {
    count: trades.length,
    buyCount: buys.length,
    sellCount: sells.length,
    buyVolume: round(buyVolume, 8),
    sellVolume: round(sellVolume, 8),
    delta: round(buyVolume - sellVolume, 8),
    firstPrice,
    lastPrice,
    lowPrice: prices.length > 0 ? Math.min(...prices) : null,
    highPrice: prices.length > 0 ? Math.max(...prices) : null,
    priceChangeBps:
      firstPrice !== null && lastPrice !== null
        ? round(((lastPrice - firstPrice) / firstPrice) * 10_000, 4)
        : 0,
    realizedVolatilityBps: round(Math.sqrt(squaredLogReturns) * 10_000, 4),
  };
}

function sumVolume(trades: NormalizedTrade[]): number {
  return trades.reduce((sum, trade) => sum + trade.quantity, 0);
}

function maximum(values: number[]): number {
  return values.length > 0 ? Math.max(...values) : 0;
}

function uniqueDirections(directions: TrendDirection[]): TrendDirection[] {
  return [...new Set(directions)];
}

function countTransitions(directions: TrendDirection[]): number {
  let transitions = 0;
  for (let index = 1; index < directions.length; index += 1) {
    if (directions[index] !== directions[index - 1]) transitions += 1;
  }
  return transitions;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
