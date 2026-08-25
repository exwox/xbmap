import type { NormalizedTrade, TradeBucket } from "../types.js";

interface MutableBucket {
  bucketStart: number;
  bucketEnd: number;
  price: number;
  side: NormalizedTrade["side"];
  volume: number;
  tradeCount: number;
  quoteVolume: number;
  maxTrade: number;
}

/** Aggregates trades by time, tick and aggressor side into renderable bubbles. */
export class TradeAggregator {
  private buckets = new Map<string, MutableBucket>();

  constructor(
    readonly bucketMs = 250,
    readonly priceTick = 0.1,
  ) {
    if (!Number.isFinite(bucketMs) || bucketMs < 20) {
      throw new Error("bucketMs must be at least 20ms");
    }
    if (!Number.isFinite(priceTick) || priceTick <= 0) {
      throw new Error("priceTick must be positive");
    }
  }

  add(trade: NormalizedTrade): void {
    if (
      !Number.isFinite(trade.price) ||
      trade.price <= 0 ||
      !Number.isFinite(trade.quantity) ||
      trade.quantity <= 0
    ) {
      return;
    }
    const bucketStart = Math.floor(trade.exchangeTimestamp / this.bucketMs) * this.bucketMs;
    const priceTicks = Math.round(trade.price / this.priceTick);
    const price = priceTicks * this.priceTick;
    const key = `${bucketStart}:${priceTicks}:${trade.side}`;
    const existing = this.buckets.get(key);
    if (existing) {
      existing.volume += trade.quantity;
      existing.quoteVolume += trade.price * trade.quantity;
      existing.tradeCount += 1;
      existing.maxTrade = Math.max(existing.maxTrade, trade.quantity);
      return;
    }
    this.buckets.set(key, {
      bucketStart,
      bucketEnd: bucketStart + this.bucketMs,
      price,
      side: trade.side,
      volume: trade.quantity,
      quoteVolume: trade.price * trade.quantity,
      tradeCount: 1,
      maxTrade: trade.quantity,
    });
  }

  flushCompleted(now: number): TradeBucket[] {
    const completed: TradeBucket[] = [];
    for (const [key, bucket] of this.buckets) {
      if (bucket.bucketEnd > now) continue;
      completed.push(toTradeBucket(bucket));
      this.buckets.delete(key);
    }
    return completed.sort((left, right) => left.bucketStart - right.bucketStart);
  }

  flushAll(): TradeBucket[] {
    const result = [...this.buckets.values()]
      .map(toTradeBucket)
      .sort((left, right) => left.bucketStart - right.bucketStart);
    this.buckets.clear();
    return result;
  }

  clear(): void {
    this.buckets.clear();
  }
}

function toTradeBucket(bucket: MutableBucket): TradeBucket {
  const buyVolume = bucket.side === "buy" ? bucket.volume : 0;
  const sellVolume = bucket.side === "sell" ? bucket.volume : 0;
  return {
    bucketStart: bucket.bucketStart,
    bucketEnd: bucket.bucketEnd,
    price: bucket.price,
    side: bucket.side,
    volume: bucket.volume,
    tradeCount: bucket.tradeCount,
    vwap: bucket.quoteVolume / bucket.volume,
    maxTrade: bucket.maxTrade,
    buyVolume,
    sellVolume,
    totalVolume: bucket.volume,
    delta: buyVolume - sellVolume,
  };
}
