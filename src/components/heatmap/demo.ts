import type {
  HeatmapDepthFrame,
  HeatmapPriceLevel,
  HeatmapPricePoint,
  HeatmapTradeBucket,
  HeatmapTrendSignal,
} from "./types";

export interface DeterministicDemoData {
  depthFrames: HeatmapDepthFrame[];
  trades: HeatmapTradeBucket[];
  priceSeries: HeatmapPricePoint[];
  trend: HeatmapTrendSignal;
}

export interface DeterministicDemoDataOptions {
  frameCount?: number;
  levelsPerSide?: number;
  intervalMs?: number;
  startTimestamp?: number;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Creates a fixed replay-like dataset; no wall clock is used. */
export function createDeterministicDemoData(
  seed = 7,
  options: DeterministicDemoDataOptions = {},
): DeterministicDemoData {
  const random = mulberry32(seed);
  const depthFrames: HeatmapDepthFrame[] = [];
  const trades: HeatmapTradeBucket[] = [];
  const priceSeries: HeatmapPricePoint[] = [];
  const start = options.startTimestamp ?? Date.UTC(2025, 0, 1, 0, 0, 0);
  const frameCount = Math.max(1, Math.round(options.frameCount ?? 240));
  const levelsPerSide = Math.max(1, Math.round(options.levelsPerSide ?? 46));
  const intervalMs = Math.max(1, Math.round(options.intervalMs ?? 1_000));
  const tickSize = 0.5;
  let price = 98_450;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const timestamp = start + frameIndex * intervalMs;
    const impulse = frameIndex > 122 && frameIndex < 190 ? 2.3 : 0.25;
    price += (random() - 0.43) * 8 + impulse;
    const midPrice = Math.round(price / tickSize) * tickSize;
    const bids: HeatmapPriceLevel[] = [];
    const asks: HeatmapPriceLevel[] = [];

    for (let level = 1; level <= levelsPerSide; level += 1) {
      const persistentBidWall =
        level === 18 && frameIndex > 20 && frameIndex < 172 ? 18 : 1;
      const persistentAskWall =
        level === 24 && frameIndex > 52 && frameIndex < 142 ? 15 : 1;
      const base = 0.8 + random() * 3.2;
      bids.push({
        price: midPrice - level * tickSize,
        quantity: base * persistentBidWall * (1 + random()),
      });
      asks.push({
        price: midPrice + level * tickSize,
        quantity:
          (0.8 + random() * 3.2) * persistentAskWall * (1 + random()),
      });
    }

    depthFrames.push({
      timestamp,
      sequence: frameIndex + 1,
      bids,
      asks,
      midPrice,
    });
    priceSeries.push({ timestamp, price: midPrice });

    if (frameIndex % 3 === 0 || random() > 0.72) {
      const buying = frameIndex > 122 && frameIndex < 198
        ? random() > 0.24
        : random() > 0.5;
      const volume = 2 + random() * random() * 90;
      trades.push({
        timestamp: timestamp + Math.floor(random() * 750),
        vwap: midPrice + (buying ? tickSize : -tickSize),
        buyVolume: buying ? volume : volume * 0.08,
        sellVolume: buying ? volume * 0.08 : volume,
        totalVolume: volume * 1.08,
        side: buying ? "buy" : "sell",
        tradeCount: 1 + Math.floor(random() * 12),
        confidence: 0.92,
      });
    }
  }

  return {
    depthFrames,
    trades,
    priceSeries,
    trend: {
      direction: "up",
      score: 78,
      confidence: 84,
      reasons: ["Buy imbalance", "Positive delta", "Local breakout"],
      timestamp: start + (frameCount - 1) * intervalMs,
    },
  };
}
