import { RingBuffer } from "./ringBuffer.js";
import type { OrderBook } from "./orderBook.js";
import type {
  GatewaySettings,
  MetricFrame,
  NormalizedTrade,
  TrendDirection,
  TrendSignal,
  TrendStrength,
} from "../types.js";

interface CvdPoint {
  timestamp: number;
  value: number;
}

export interface TrendFeatures {
  momentumShort: number;
  momentumMedium: number;
  deltaRatio: number;
  cvdSlope: number;
  imbalance: number;
  volumeRatio: number;
  breakout: -1 | 0 | 1;
  spreadBps: number;
  valid: boolean;
}

export interface TrendScore {
  upScore: number;
  downScore: number;
  upReasons: string[];
  downReasons: string[];
}

export interface AnalyticsFrame {
  metric: MetricFrame;
  trend: TrendSignal;
}

/** Stateless, explainable weighted trend formula. */
export function scoreTrend(features: TrendFeatures): TrendScore {
  if (!features.valid) {
    return { upScore: 0, downScore: 0, upReasons: [], downReasons: [] };
  }

  const scoreDirection = (direction: 1 | -1) => {
    const shortMomentum = clamp(direction * features.momentumShort / 0.0015, 0, 1);
    const mediumMomentum = clamp(direction * features.momentumMedium / 0.004, 0, 1);
    const momentum = shortMomentum * 0.65 + mediumMomentum * 0.35;
    const delta = clamp(direction * features.deltaRatio, 0, 1);
    const cvd = clamp(direction * features.cvdSlope, 0, 1);
    const imbalance = clamp(direction * features.imbalance, 0, 1);
    const activity = clamp((features.volumeRatio - 0.8) / 1.7, 0, 1);
    const breakout = direction * features.breakout > 0 ? 1 : 0;

    const raw =
      25 * momentum +
      20 * delta +
      15 * cvd +
      15 * imbalance +
      15 * activity +
      10 * breakout;
    const spreadMultiplier =
      features.spreadBps <= 2 ? 1 : clamp(2 / features.spreadBps, 0.25, 1);
    const score = Math.round(clamp(raw * spreadMultiplier, 0, 100));

    const reasons: string[] = [];
    if (momentum >= 0.45) reasons.push(direction > 0 ? "Positive price momentum" : "Negative price momentum");
    if (delta >= 0.35) reasons.push(direction > 0 ? "Buy volume delta" : "Sell volume delta");
    if (cvd >= 0.35) reasons.push(direction > 0 ? "CVD rising" : "CVD falling");
    if (imbalance >= 0.2) reasons.push(direction > 0 ? "Bid liquidity imbalance" : "Ask liquidity imbalance");
    if (activity >= 0.3) reasons.push("Elevated trade activity");
    if (breakout > 0) reasons.push(direction > 0 ? "Local high breakout" : "Local low breakout");
    if (spreadMultiplier < 0.8) reasons.push("Confidence reduced by wide spread");
    return { score, reasons };
  };

  const up = scoreDirection(1);
  const down = scoreDirection(-1);
  return {
    upScore: up.score,
    downScore: down.score,
    upReasons: up.reasons,
    downReasons: down.reasons,
  };
}

/** Stateful enter/exit confirmation prevents signal flicker. */
export class TrendDetector {
  private activeDirection: TrendDirection = "neutral";
  private activeSince: number | null = null;
  private pendingDirection: TrendDirection = "neutral";
  private pendingFrames = 0;
  private exitFrames = 0;

  constructor(
    private readonly enterScore = 65,
    private readonly exitScore = 50,
    private readonly confirmationFrames = 3,
  ) {}

  reset(): void {
    this.activeDirection = "neutral";
    this.activeSince = null;
    this.pendingDirection = "neutral";
    this.pendingFrames = 0;
    this.exitFrames = 0;
  }

  update(features: TrendFeatures, now: number): TrendSignal {
    const scores = scoreTrend(features);
    if (!features.valid) {
      this.reset();
      return neutralSignal(scores);
    }

    const candidate: TrendDirection =
      scores.upScore === scores.downScore
        ? "neutral"
        : scores.upScore > scores.downScore
          ? "up"
          : "down";
    const candidateScore = candidate === "up" ? scores.upScore : scores.downScore;

    if (this.activeDirection === "neutral") {
      if (candidate !== "neutral" && candidateScore >= this.enterScore) {
        if (candidate === this.pendingDirection) this.pendingFrames += 1;
        else {
          this.pendingDirection = candidate;
          this.pendingFrames = 1;
        }
        if (this.pendingFrames >= this.confirmationFrames) {
          this.activeDirection = candidate;
          this.activeSince = now;
          this.pendingDirection = "neutral";
          this.pendingFrames = 0;
        }
      } else {
        this.pendingDirection = "neutral";
        this.pendingFrames = 0;
      }
    } else {
      const activeScore =
        this.activeDirection === "up" ? scores.upScore : scores.downScore;
      if (activeScore < this.exitScore) this.exitFrames += 1;
      else this.exitFrames = 0;

      if (this.exitFrames >= 2) {
        this.activeDirection = "neutral";
        this.activeSince = null;
        this.exitFrames = 0;
      }
    }

    const displayDirection =
      this.activeDirection !== "neutral"
        ? this.activeDirection
        : candidateScore >= 40
          ? candidate
          : "neutral";
    const score =
      displayDirection === "up"
        ? scores.upScore
        : displayDirection === "down"
          ? scores.downScore
          : Math.max(scores.upScore, scores.downScore);
    const reasons =
      displayDirection === "up"
        ? scores.upReasons
        : displayDirection === "down"
          ? scores.downReasons
          : [];

    return {
      direction: displayDirection,
      score,
      upScore: scores.upScore,
      downScore: scores.downScore,
      confidence: round(clamp((score - 25) / 75, 0, 1), 3),
      active: this.activeDirection !== "neutral",
      strength: strengthFor(score),
      reasons,
      since: this.activeSince,
    };
  }
}

export class AnalyticsEngine {
  private readonly trades = new RingBuffer<NormalizedTrade>(30_000);
  private readonly cvdPoints = new RingBuffer<CvdPoint>(30_000);
  private readonly trendDetector: TrendDetector;
  private cvd = 0;
  private lastPrice: number | null = null;
  private lastReceivedTimestamp: number | null = null;

  constructor(private settings: Pick<GatewaySettings, "trendEnterScore" | "trendExitScore">) {
    this.trendDetector = new TrendDetector(
      settings.trendEnterScore,
      settings.trendExitScore,
    );
  }

  reset(): void {
    this.trades.clear();
    this.cvdPoints.clear();
    this.trendDetector.reset();
    this.cvd = 0;
    this.lastPrice = null;
    this.lastReceivedTimestamp = null;
  }

  onTrade(trade: NormalizedTrade): void {
    if (
      !Number.isFinite(trade.price) ||
      trade.price <= 0 ||
      !Number.isFinite(trade.quantity) ||
      trade.quantity <= 0
    ) return;
    this.trades.push(trade);
    this.lastPrice = trade.price;
    this.lastReceivedTimestamp = trade.receivedTimestamp;
    this.cvd += trade.side === "buy" ? trade.quantity : -trade.quantity;
    this.cvdPoints.push({ timestamp: trade.exchangeTimestamp, value: this.cvd });
  }

  compute(book: OrderBook, now: number, stale: boolean): AnalyticsFrame {
    const allTrades = this.trades.toArray();
    const recent = allTrades.filter((trade) => trade.exchangeTimestamp >= now - 5_000);
    const medium = allTrades.filter((trade) => trade.exchangeTimestamp >= now - 30_000);
    const buyVolume = sumVolume(recent, "buy");
    const sellVolume = sumVolume(recent, "sell");
    const volume = buyVolume + sellVolume;
    const delta = buyVolume - sellVolume;
    const bestBid = book.getBestBid()?.[0] ?? null;
    const bestAsk = book.getBestAsk()?.[0] ?? null;
    const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
    const referencePrice = this.lastPrice ?? midPrice(bestBid, bestAsk);
    const momentumShort = priceChange(recent, referencePrice);
    const momentumMedium = priceChange(medium, referencePrice);
    const volumeRatio = calculateVolumeRatio(medium, now);
    const imbalance = book.imbalance(20);
    const cvdSlope = calculateCvdSlope(this.cvdPoints.toArray(), now, volume);
    const breakout = detectBreakout(medium, this.lastPrice);
    const spreadBps =
      spread !== null && referencePrice !== null && referencePrice > 0
        ? (spread / referencePrice) * 10_000
        : 100;
    const latencyMs =
      this.lastReceivedTimestamp === null
        ? null
        : Math.max(0, now - this.lastReceivedTimestamp);

    const metric: MetricFrame = {
      lastPrice: this.lastPrice,
      bestBid,
      bestAsk,
      spread,
      delta: round(delta, 8),
      cvd: round(this.cvd, 8),
      buyVolume: round(buyVolume, 8),
      sellVolume: round(sellVolume, 8),
      buySellRatio: round(sellVolume > 0 ? buyVolume / sellVolume : buyVolume > 0 ? 99 : 1, 4),
      imbalance: round(imbalance, 5),
      tradeRate: round(recent.length / 5, 2),
      volumeRatio: round(volumeRatio, 4),
      momentumShort: round(momentumShort, 7),
      momentumMedium: round(momentumMedium, 7),
      latencyMs,
      stale,
    };
    const trend = this.trendDetector.update(
      {
        momentumShort,
        momentumMedium,
        deltaRatio: volume > 0 ? delta / volume : 0,
        cvdSlope,
        imbalance,
        volumeRatio,
        breakout,
        spreadBps,
        valid: !stale && book.isSynchronized && recent.length >= 2,
      },
      now,
    );
    return { metric, trend };
  }
}

function sumVolume(trades: NormalizedTrade[], side: NormalizedTrade["side"]): number {
  return trades.reduce(
    (sum, trade) => sum + (trade.side === side ? trade.quantity : 0),
    0,
  );
}

function priceChange(trades: NormalizedTrade[], latest: number | null): number {
  if (trades.length < 2 || latest === null) return 0;
  const first = trades[0]?.price;
  return first && first > 0 ? (latest - first) / first : 0;
}

function calculateVolumeRatio(trades: NormalizedTrade[], now: number): number {
  if (trades.length === 0) return 0;
  const seconds = new Map<number, number>();
  for (const trade of trades) {
    const second = Math.floor(trade.exchangeTimestamp / 1_000);
    seconds.set(second, (seconds.get(second) ?? 0) + trade.quantity);
  }
  const currentStart = now - 5_000;
  const recentVolume = trades.reduce(
    (sum, trade) => sum + (trade.exchangeTimestamp >= currentStart ? trade.quantity : 0),
    0,
  );
  const historical = [...seconds.entries()]
    .filter(([second]) => second * 1_000 < currentStart)
    .map(([, volume]) => volume)
    .sort((left, right) => left - right);
  if (historical.length < 3) return 1;
  const median = historical[Math.floor(historical.length / 2)] ?? 0;
  return median > 0 ? recentVolume / (median * 5) : 1;
}

function calculateCvdSlope(points: CvdPoint[], now: number, recentVolume: number): number {
  if (points.length < 2 || recentVolume <= 0) return 0;
  const target = now - 10_000;
  const start = points.find((point) => point.timestamp >= target) ?? points[0];
  const end = points.at(-1);
  if (!start || !end) return 0;
  return clamp((end.value - start.value) / Math.max(recentVolume * 2, 0.00000001), -1, 1);
}

function detectBreakout(
  trades: NormalizedTrade[],
  latestPrice: number | null,
): -1 | 0 | 1 {
  if (trades.length < 8 || latestPrice === null) return 0;
  const comparison = trades.slice(0, -2).map((trade) => trade.price);
  if (comparison.length === 0) return 0;
  const high = Math.max(...comparison);
  const low = Math.min(...comparison);
  if (latestPrice > high) return 1;
  if (latestPrice < low) return -1;
  return 0;
}

function midPrice(bid: number | null, ask: number | null): number | null {
  return bid !== null && ask !== null ? (bid + ask) / 2 : bid ?? ask;
}

function neutralSignal(scores: TrendScore): TrendSignal {
  return {
    direction: "neutral",
    score: 0,
    upScore: scores.upScore,
    downScore: scores.downScore,
    confidence: 0,
    active: false,
    strength: "neutral",
    reasons: [],
    since: null,
  };
}

function strengthFor(score: number): TrendStrength {
  if (score >= 80) return "very_strong";
  if (score >= 60) return "strong";
  if (score >= 40) return "forming";
  return "neutral";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
