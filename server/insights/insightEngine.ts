import type { ServerEnvelope } from "../types.js";

/**
 * Phase 5 advanced analytics. One `InsightEngine` per market session consumes
 * the exact gateway envelope stream (so replaying the same events reproduces
 * the same insights — no wall-clock inside the compute path) and produces a
 * bounded `InsightFrame` once per publish interval.
 */

export const INSIGHTS_ALGO_VERSION = "insights-v1";

export interface WallObservation {
  side: "bid" | "ask";
  price: number;
  quantity: number;
  multipleOfMedian: number;
  firstSeenAt: number;
  persistenceMs: number;
}

export interface WallTransition {
  at: number;
  kind: "appeared" | "disappeared";
  wall: WallObservation;
}

export interface RollingVwap {
  value: number | null;
  windowMs: number;
  sampleSeconds: number;
}

export interface AddedPulledLiquidity {
  windowMs: number;
  bidAddedQuantity: number;
  bidPulledQuantity: number;
  askAddedQuantity: number;
  askPulledQuantity: number;
}

export interface AbsorptionState {
  direction: "bullish" | "bearish";
  price: number;
  tradedQuantity: number;
  reason: string;
}

export interface ExhaustionState {
  direction: "up" | "down" | null;
  reason: string;
}

export interface VolumeProfileNode {
  price: number;
  volume: number;
  share: number;
}

export interface VolumeProfile {
  bucketTickSize: number;
  totalVolume: number;
  pocPrice: number | null;
  nodes: VolumeProfileNode[];
}

export interface FootprintRow {
  priceTicks: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  tradeCount: number;
}

export interface DerivativesSnapshot {
  fundingRate: number | null;
  nextFundingTime: number | null;
  markPrice: number | null;
  openInterest: number | null;
  updatedAtMs: number | null;
  stale: boolean;
}

export interface LiquidationAggregate {
  windowMs: number;
  longLiquidations: number;
  shortLiquidations: number;
  longQuantity: number;
  shortQuantity: number;
}

export interface InsightFrame {
  algoVersion: string;
  symbol: string;
  generatedAt: number;
  rollingVwap: RollingVwap;
  walls: WallObservation[];
  addedPulled: AddedPulledLiquidity;
  absorption: AbsorptionState | null;
  exhaustion: ExhaustionState;
  volumeProfile: VolumeProfile;
  footprint: { rows: FootprintRow[]; maxRows: number };
  derivatives: DerivativesSnapshot;
  liquidations: LiquidationAggregate;
  /** Wall transitions since the previous published frame (alert input). */
  wallTransitions: WallTransition[];
}

interface RingEntry {
  timestamp: number;
  value: number;
}

/** Fixed-capacity ring of `{timestamp, value}` samples ordered by insertion. */
class TimeRing {
  private readonly items: RingEntry[] = [];
  constructor(private readonly capacity: number) {}

  push(timestamp: number, value: number): void {
    this.items.push({ timestamp, value });
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  dropOlderThan(cutoff: number): void {
    let index = 0;
    while (index < this.items.length && this.items[index]!.timestamp < cutoff) index += 1;
    if (index > 0) this.items.splice(0, index);
  }

  entries(): ReadonlyArray<RingEntry> {
    return this.items;
  }

  clear(): void {
    this.items.length = 0;
  }
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function median(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0;
  const middle = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 1
    ? sortedValues[middle]!
    : (sortedValues[middle - 1]! + sortedValues[middle]!) / 2;
}

export interface InsightEngineOptions {
  symbol: string;
  tickSize: number;
  /** Wall = level with quantity ≥ max(wallMinQuantity, wallMultiple × median top levels). */
  wallMultiple?: number;
  wallMinQuantity?: number;
  /**
   * Real-market floor: a candidate must also carry at least this notional
   * value (quantity × price, USD) regardless of its multiple of the median.
   */
  minWallNotionalUsd?: number;
  /** A candidate must persist this long before it counts as a wall. */
  wallConfirmMs?: number;
  vwapWindowMs?: number;
  profileWindowMs?: number;
  addedPulledWindowMs?: number;
  liquidationWindowMs?: number;
  absorptionWindowMs?: number;
  /** Extra quantity floor for absorption; 0 relies on the notional floor. */
  absorptionMinQuantity?: number;
  /** Real-market floor: traded quote value (USD) inside the window. */
  absorptionMinNotionalUsd?: number;
  /** Absorption only counts while the mid stays within this many bps. */
  absorptionMaxMoveBps?: number;
  footprintMaxRows?: number;
  publishIntervalMs?: number;
  now?: () => number;
}

interface CandidateWall {
  side: "bid" | "ask";
  price: number;
  quantity: number;
  firstSeenAt: number;
}

const EMPTY_DERIVATIVES: DerivativesSnapshot = {
  fundingRate: null,
  nextFundingTime: null,
  markPrice: null,
  openInterest: null,
  updatedAtMs: null,
  stale: true,
};

export class InsightEngine {
  readonly symbol: string;

  private readonly opts: Required<
    Pick<
      InsightEngineOptions,
      | "tickSize"
      | "wallMultiple"
      | "wallMinQuantity"
      | "minWallNotionalUsd"
      | "wallConfirmMs"
      | "vwapWindowMs"
      | "profileWindowMs"
      | "addedPulledWindowMs"
      | "liquidationWindowMs"
      | "absorptionWindowMs"
      | "absorptionMinQuantity"
      | "absorptionMinNotionalUsd"
      | "absorptionMaxMoveBps"
      | "footprintMaxRows"
      | "publishIntervalMs"
    >
  > & { now: () => number };

  private sawInput = false;
  private lastPublishAt = -Infinity;

  // Book state (full top-N levels arrive on every depth frame).
  private lastBidLevels = new Map<number, number>();
  private lastAskLevels = new Map<number, number>();
  private readonly wallState = new Map<string, {
    side: "bid" | "ask"; price: number; quantity: number; firstSeenAt: number; confirmedAt: number | null;
  }>();
  private readonly bidDeltas = new DeltaRing();
  private readonly askDeltas = new DeltaRing();
  private readonly midSamples = new TimeRing(256);
  private candidates = new Map<string, CandidateWall>();
  private walls: WallObservation[] = [];

  // Trade-derived state.
  private readonly vwapRing = new TimeRing(4_000);
  private readonly profileRing = new TimeRing(20_000);
  private readonly absorptionQtyRing = new TimeRing(4_000);
  private readonly absorptionDeltaRing = new TimeRing(4_000);
  private readonly absorptionQuoteRing = new TimeRing(4_000);
  private readonly footprintRows = new Map<number, FootprintRow & { updatedAt: number }>();

  // Metric/trend context for exhaustion + alert evaluation.
  private latestMetric: { tradeRate: number; delta: number; midPrice: number | null } | null = null;
  private readonly tradeRateSeries = new TimeRing(64);
  private latestTrend: { direction: "up" | "down" | null; active: boolean } | null = null;

  private derivatives: DerivativesSnapshot = EMPTY_DERIVATIVES;
  private readonly liquidationRing = new TimeRing(256);
  private pendingWallTransitions: WallTransition[] = [];

  constructor(options: InsightEngineOptions) {
    this.symbol = options.symbol;
    this.opts = {
      tickSize: options.tickSize,
      wallMultiple: options.wallMultiple ?? 6,
      wallMinQuantity: options.wallMinQuantity ?? 0,
      minWallNotionalUsd: options.minWallNotionalUsd ?? 10_000,
      wallConfirmMs: options.wallConfirmMs ?? 1_500,
      vwapWindowMs: options.vwapWindowMs ?? 60_000,
      profileWindowMs: options.profileWindowMs ?? 300_000,
      addedPulledWindowMs: options.addedPulledWindowMs ?? 10_000,
      liquidationWindowMs: options.liquidationWindowMs ?? 60_000,
      absorptionWindowMs: options.absorptionWindowMs ?? 5_000,
      absorptionMinQuantity: options.absorptionMinQuantity ?? 0,
      absorptionMinNotionalUsd: options.absorptionMinNotionalUsd ?? 15_000,
      absorptionMaxMoveBps: options.absorptionMaxMoveBps ?? 2,
      footprintMaxRows: options.footprintMaxRows ?? 24,
      publishIntervalMs: options.publishIntervalMs ?? 1_000,
      now: options.now ?? Date.now,
    };
  }

  setDerivatives(snapshot: Partial<DerivativesSnapshot> & { stale: boolean }): void {
    this.derivatives = {
      fundingRate: snapshot.fundingRate ?? null,
      nextFundingTime: snapshot.nextFundingTime ?? null,
      markPrice: snapshot.markPrice ?? null,
      openInterest: snapshot.openInterest ?? null,
      updatedAtMs: snapshot.updatedAtMs ?? this.opts.now(),
      stale: snapshot.stale,
    };
  }

  /**
   * Records one forced liquidation. `liquidatedSide` is the POSITION side that
   * was closed (a SELL force-order liquidates a LONG, and vice versa), so the
   * ring encodes long as positive quantity and short as negative.
   */
  pushLiquidation(input: {
    liquidatedSide: "long" | "short";
    price: number;
    quantity: number;
    timestamp: number;
  }): void {
    this.liquidationRing.push(
      input.timestamp,
      input.liquidatedSide === "long" ? input.quantity : -input.quantity,
    );
  }

  /**
   * Feeds one gateway envelope. Only market-data types mutate state; anything
   * else is ignored so replaying the recorded stream stays reproducible.
   */
  handleEvent(envelope: ServerEnvelope): void {
    switch (envelope.type) {
      case "snapshot":
      case "depth_frame":
        this.handleDepth(envelope);
        return;
      case "trade_bucket":
        this.handleTradeBucket(envelope);
        return;
      case "metric":
        this.handleMetric(envelope);
        return;
      case "trend_signal":
        this.handleTrend(envelope);
        return;
      default:
        return;
    }
  }

  // ── Input handlers ────────────────────────────────────────────────────────

  private handleDepth(envelope: ServerEnvelope): void {
    const data = envelope.data as {
      bids?: Array<[number | string, number | string]>;
      asks?: Array<[number | string, number | string]>;
    };
    if (!Array.isArray(data.bids) || !Array.isArray(data.asks)) return;

    const bidLevels = toLevelMap(data.bids);
    const askLevels = toLevelMap(data.asks);
    const timestamp = envelope.exchangeTimestamp || envelope.serverTimestamp || this.opts.now();

    const [bidAdded, bidPulled] = this.diffLevels(this.lastBidLevels, bidLevels);
    const [askAdded, askPulled] = this.diffLevels(this.lastAskLevels, askLevels);
    this.bidDeltas.push(timestamp, bidAdded, bidPulled);
    this.askDeltas.push(timestamp, askAdded, askPulled);
    this.lastBidLevels = bidLevels;
    this.lastAskLevels = askLevels;

    this.updateWalls(bidLevels, askLevels, timestamp);
    const mid = this.currentMidPrice();
    if (mid !== null) this.midSamples.push(timestamp, mid);
    this.sawInput = true;
  }

  private handleTradeBucket(envelope: ServerEnvelope): void {
    const bucket = envelope.data as {
      price?: number; volume?: number; delta?: number;
      buyVolume?: number; sellVolume?: number; tradeCount?: number;
      bucketStart?: number;
    };
    if (typeof bucket.price !== "number" || typeof bucket.volume !== "number" || bucket.volume <= 0) return;
    const ts = envelope.exchangeTimestamp || bucket.bucketStart || this.opts.now();
    const buy = typeof bucket.buyVolume === "number" ? bucket.buyVolume : 0;
    const sell = typeof bucket.sellVolume === "number" ? bucket.sellVolume : 0;

    this.vwapRing.push(ts, bucket.price * bucket.volume); // quote volume
    this.vwapRing.push(ts, -bucket.volume);               // negative encodes base quantity
    this.profileRing.push(ts, Math.round(bucket.price / this.opts.tickSize));
    this.absorptionQtyRing.push(ts, bucket.volume);
    this.absorptionDeltaRing.push(ts, bucket.delta ?? buy - sell);
    this.absorptionQuoteRing.push(ts, bucket.price * bucket.volume);

    const priceTicks = Math.round(bucket.price / this.opts.tickSize);
    const row = this.footprintRows.get(priceTicks)
      ?? { priceTicks, buyVolume: 0, sellVolume: 0, delta: 0, tradeCount: 0, updatedAt: ts };
    row.buyVolume += buy;
    row.sellVolume += sell;
    row.delta += buy - sell;
    row.tradeCount += bucket.tradeCount ?? 1;
    row.updatedAt = ts;
    this.footprintRows.set(priceTicks, row);
    this.sawInput = true;
  }

  private handleMetric(envelope: ServerEnvelope): void {
    const metric = envelope.data as { tradeRate?: number; delta?: number };
    const previous = this.latestMetric;
    this.latestMetric = {
      tradeRate: typeof metric.tradeRate === "number" ? metric.tradeRate : previous?.tradeRate ?? 0,
      delta: typeof metric.delta === "number" ? metric.delta : previous?.delta ?? 0,
      midPrice: this.currentMidPrice(),
    };
    this.tradeRateSeries.push(envelope.serverTimestamp || this.opts.now(), this.latestMetric.tradeRate);
    this.sawInput = true;
  }

  private handleTrend(envelope: ServerEnvelope): void {
    const trend = envelope.data as { direction?: string; active?: boolean };
    this.latestTrend = {
      direction: trend.direction === "up" || trend.direction === "down" ? trend.direction : null,
      active: trend.active === true,
    };
    this.sawInput = true;
  }

  // ── Computations ─────────────────────────────────────────────────────────

  private currentMidPrice(): number | null {
    const bestBid = firstKeyBy(this.lastBidLevels, "max");
    const bestAsk = firstKeyBy(this.lastAskLevels, "min");
    if (bestBid !== null && bestAsk !== null) return (bestBid + bestAsk) / 2;
    return bestBid ?? bestAsk;
  }

  /** Returns `[addedQuantity, pulledQuantity]` between the two level maps. */
  private diffLevels(
    previous: Map<number, number>,
    current: Map<number, number>,
  ): [number, number] {
    let added = 0;
    let pulled = 0;
    for (const [priceTicks, quantity] of current) {
      const before = previous.get(priceTicks);
      if (before === undefined || quantity > before) added += quantity - (before ?? 0);
    }
    for (const [priceTicks, quantity] of previous) {
      const after = current.get(priceTicks);
      if (after === undefined || quantity > after) pulled += quantity - (after ?? 0);
    }
    return [added, pulled];
  }

  private updateWalls(bids: Map<number, number>, asks: Map<number, number>, timestamp: number): void {
    const quantities = [...bids.values(), ...asks.values()]
      .filter((value) => value > 0)
      .sort((left, right) => left - right);
    const medianQuantity = median(quantities);
    if (medianQuantity <= 0) return;
    const threshold = Math.max(this.opts.wallMinQuantity, this.opts.wallMultiple * medianQuantity);

    const qualifying = new Map<string, { side: "bid" | "ask"; price: number; quantity: number }>();
    for (const [side, levels] of [["bid", bids], ["ask", asks]] as const) {
      for (const [price, quantity] of levels) {
        // Real-market guard: the level must clear BOTH the relative multiple
        // of this symbol's median level AND an absolute USD-notional floor,
        // so dust-heavy books cannot fabricate walls on low-priced assets.
        if (
          quantity >= threshold &&
          price * quantity >= this.opts.minWallNotionalUsd
        ) {
          qualifying.set(`${side}:${price}`, { side, price, quantity });
        }
      }
    }

    for (const [key, level] of qualifying) {
      const existing = this.wallState.get(key);
      if (!existing) {
        this.wallState.set(key, {
          side: level.side,
          price: level.price,
          quantity: level.quantity,
          firstSeenAt: timestamp,
          confirmedAt: null,
        });
        continue;
      }
      existing.quantity = level.quantity;
      if (
        existing.confirmedAt === null &&
        timestamp - existing.firstSeenAt >= this.opts.wallConfirmMs
      ) {
        existing.confirmedAt = timestamp;
        this.pendingWallTransitions.push({
          at: timestamp,
          kind: "appeared",
          wall: toObservation(existing, medianQuantity, timestamp),
        });
      }
    }

    for (const [key, state] of [...this.wallState.entries()]) {
      if (qualifying.has(key)) continue;
      this.wallState.delete(key);
      if (state.confirmedAt !== null) {
        this.pendingWallTransitions.push({
          at: timestamp,
          kind: "disappeared",
          wall: toObservation(state, medianQuantity, timestamp),
        });
      }
    }
  }

  /** Builds the current `InsightFrame` when the publish interval elapsed. */
  maybePublish(): InsightFrame | null {
    if (!this.sawInput) return null;
    const now = this.opts.now();
    if (now - this.lastPublishAt < this.opts.publishIntervalMs) return null;
    this.lastPublishAt = now;
    return this.buildFrame(now);
  }

  /** Forces a frame build (REST snapshots and tests). */
  snapshotFrame(): InsightFrame {
    this.sawInput = true;
    return this.buildFrame(this.opts.now());
  }

  private buildFrame(now: number): InsightFrame {
    // Rolling VWAP over the quote/base ring pairs.
    this.vwapRing.dropOlderThan(now - this.opts.vwapWindowMs);
    let quoteVolume = 0;
    let baseQuantity = 0;
    for (const entry of this.vwapRing.entries()) {
      if (entry.value >= 0) quoteVolume += entry.value;
      else baseQuantity += -entry.value;
    }

    // Volume profile: bucket counts over the profile window.
    const profileCutoff = now - this.opts.profileWindowMs;
    this.profileRing.dropOlderThan(profileCutoff);
    const profileTotals = new Map<number, number>();
    for (const entry of this.profileRing.entries()) {
      profileTotals.set(entry.value, (profileTotals.get(entry.value) ?? 0) + 1);
    }
    let totalBuckets = 0;
    let pocTicks = -1;
    let pocCount = -1;
    for (const [priceTicks, count] of profileTotals) {
      totalBuckets += count;
      if (count > pocCount) {
        pocCount = count;
        pocTicks = priceTicks;
      }
    }
    const nodes: VolumeProfileNode[] = [...profileTotals.entries()]
      .map(([priceTicks, count]) => ({
        price: roundTo(priceTicks * this.opts.tickSize, 10),
        volume: count,
        share: totalBuckets > 0 ? roundTo(count / totalBuckets, 4) : 0,
      }))
      .sort((left, right) => right.volume - left.volume)
      .slice(0, 12);

    // Added/pulled sums over their window.
    this.bidDeltas.dropOlderThan(now - this.opts.addedPulledWindowMs);
    this.askDeltas.dropOlderThan(now - this.opts.addedPulledWindowMs);

    const liquidationCutoff = now - this.opts.liquidationWindowMs;
    this.liquidationRing.dropOlderThan(liquidationCutoff);
    const liquidations: LiquidationAggregate = {
      windowMs: this.opts.liquidationWindowMs,
      longLiquidations: 0,
      shortLiquidations: 0,
      longQuantity: 0,
      shortQuantity: 0,
    };
    for (const entry of this.liquidationRing.entries()) {
      if (entry.value >= 0) {
        liquidations.longLiquidations += 1;
        liquidations.longQuantity += roundTo(entry.value, 6);
      } else {
        liquidations.shortLiquidations += 1;
        liquidations.shortQuantity += roundTo(-entry.value, 6);
      }
    }

    const walls = [...this.wallState.values()]
      .filter((state) => state.confirmedAt !== null)
      .map((state) => toObservation(state, 0, now))
      .sort((left, right) => right.persistenceMs - left.persistenceMs);

    const footprintRows = [...this.footprintRows.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, this.opts.footprintMaxRows)
      .map(({ updatedAt, ...row }) => ({ priceTicks: row.priceTicks, buyVolume: roundTo(row.buyVolume, 6), sellVolume: roundTo(row.sellVolume, 6), delta: roundTo(row.delta, 6), tradeCount: row.tradeCount }));

    return {
      algoVersion: INSIGHTS_ALGO_VERSION,
      symbol: this.symbol,
      generatedAt: now,
      rollingVwap: {
        value: baseQuantity > 0 ? roundTo(quoteVolume / baseQuantity, 6) : null,
        windowMs: this.opts.vwapWindowMs,
        sampleSeconds: Math.min(Math.round(baseQuantity), this.opts.vwapWindowMs / 1_000),
      },
      walls,
      addedPulled: {
        windowMs: this.opts.addedPulledWindowMs,
        bidAddedQuantity: roundTo(this.bidDeltas.sumAdded(), 4),
        bidPulledQuantity: roundTo(this.bidDeltas.sumPulled(), 4),
        askAddedQuantity: roundTo(this.askDeltas.sumAdded(), 4),
        askPulledQuantity: roundTo(this.askDeltas.sumPulled(), 4),
      },
      absorption: this.computeAbsorption(now),
      exhaustion: this.computeExhaustion(),
      volumeProfile: {
        bucketTickSize: this.opts.tickSize,
        totalVolume: totalBuckets,
        pocPrice: pocTicks >= 0 ? roundTo(pocTicks * this.opts.tickSize, 10) : null,
        nodes,
      },
      footprint: { rows: footprintRows, maxRows: this.opts.footprintMaxRows },
      derivatives: this.derivatives,
      liquidations,
      wallTransitions: this.pendingWallTransitions.splice(0, this.pendingWallTransitions.length),
    };
  }

  /**
   * Absorption heuristic (documented, deterministic, market-real): heavy
   * traded **notional** within the window while the mid moved at most
   * `absorptionMaxMoveBps` basis points → the aggression was absorbed.
   * Sell-dominant flow absorbed reads bullish; buy-dominant reads bearish.
   */
  private computeAbsorption(now: number): AbsorptionState | null {
    const cutoff = now - this.opts.absorptionWindowMs;
    this.absorptionQtyRing.dropOlderThan(cutoff);
    this.absorptionDeltaRing.dropOlderThan(cutoff);
    this.absorptionQuoteRing.dropOlderThan(cutoff);
    const qtyEntries = this.absorptionQtyRing.entries();
    if (qtyEntries.length === 0) return null;

    let tradedQuantity = 0;
    for (const entry of qtyEntries) tradedQuantity += entry.value;
    if (tradedQuantity < this.opts.absorptionMinQuantity) return null;

    let tradedNotional = 0;
    for (const entry of this.absorptionQuoteRing.entries()) tradedNotional += entry.value;
    if (tradedNotional < this.opts.absorptionMinNotionalUsd) return null;

    const mids = this.midSamples.entries().filter((entry) => entry.timestamp >= cutoff);
    const firstMid = mids[0]?.value ?? null;
    const lastMid = mids[mids.length - 1]?.value ?? null;
    if (firstMid === null || lastMid === null || firstMid <= 0) return null;
    const moveBps = Math.abs(lastMid - firstMid) / firstMid * 10_000;
    if (moveBps > this.opts.absorptionMaxMoveBps) return null;

    const deltaSum = this.absorptionDeltaRing.entries().reduce((sum, entry) => sum + entry.value, 0);
    const direction = deltaSum < 0 ? "bullish" : "bearish";
    return {
      direction,
      price: roundTo(lastMid, 10),
      tradedQuantity: roundTo(tradedQuantity, 4),
      reason:
        direction === "bullish"
          ? `Sell flow $${Math.round(tradedNotional).toLocaleString("en-US")} absorbed with ${roundTo(moveBps, 2)} bps of movement`
          : `Buy flow $${Math.round(tradedNotional).toLocaleString("en-US")} absorbed with ${roundTo(moveBps, 2)} bps of movement`,
    };
  }

  /** Exhaustion: active trend whose trade rate faded ≥30% over half-window. */
  private computeExhaustion(): ExhaustionState {
    const trend = this.latestTrend;
    if (!trend?.active || trend.direction === null || !this.latestMetric) {
      return { direction: null, reason: "" };
    }
    const rates = this.tradeRateSeries.entries().map((entry) => entry.value);
    if (rates.length < 6) return { direction: null, reason: "" };
    const half = Math.floor(rates.length / 2);
    const olderHalf = rates.slice(0, half).reduce((sum, value) => sum + value, 0) / Math.max(half, 1);
    const newerHalf =
      rates.slice(half).reduce((sum, value) => sum + value, 0) / Math.max(rates.length - half, 1);
    if (olderHalf <= 0 || newerHalf >= olderHalf * 0.7) return { direction: null, reason: "" };
    const fadedPct = roundTo((1 - newerHalf / olderHalf) * 100, 0);
    return {
      direction: trend.direction,
      reason:
        trend.direction === "up"
          ? `Upside trade rate faded ${fadedPct}% while the uptrend stayed active`
          : `Downside trade rate faded ${fadedPct}% while the downtrend stayed active`,
    };
  }
}

/** Fixed-capacity added/pulled deltas keyed by timestamp. */
class DeltaRing {
  private readonly items: Array<{ timestamp: number; added: number; pulled: number }> = [];

  push(timestamp: number, added: number, pulled: number): void {
    this.items.push({ timestamp, added, pulled });
    if (this.items.length > 4_096) this.items.splice(0, this.items.length - 4_096);
  }

  dropOlderThan(cutoff: number): void {
    let index = 0;
    while (index < this.items.length && this.items[index]!.timestamp < cutoff) index += 1;
    if (index > 0) this.items.splice(0, index);
  }

  sumAdded(): number {
    return this.items.reduce((sum, item) => sum + item.added, 0);
  }

  sumPulled(): number {
    return this.items.reduce((sum, item) => sum + item.pulled, 0);
  }
}

function toLevelMap(levels: Array<[number | string, number | string]>): Map<number, number> {
  const map = new Map<number, number>();
  for (const [priceRaw, quantityRaw] of levels) {
    const price = typeof priceRaw === "number" ? priceRaw : Number(priceRaw);
    const quantity = typeof quantityRaw === "number" ? quantityRaw : Number(quantityRaw);
    if (!Number.isFinite(price) || !Number.isFinite(quantity)) continue;
    map.set(price, quantity);
  }
  return map;
}

function firstKeyBy(map: Map<number, number>, order: "max" | "min"): number | null {
  let best: number | null = null;
  for (const key of map.keys()) {
    if (best === null) {
      best = key;
      continue;
    }
    if (order === "max" ? key > best : key < best) best = key;
  }
  return best;
}

type WallStateEntry = {
  side: "bid" | "ask";
  price: number;
  quantity: number;
  firstSeenAt: number;
  confirmedAt: number | null;
};

function toObservation(
  state: WallStateEntry,
  medianQuantity: number,
  now: number,
): WallObservation {
  return {
    side: state.side,
    price: roundTo(state.price, 10),
    quantity: roundTo(state.quantity, 6),
    multipleOfMedian: medianQuantity > 0 ? roundTo(state.quantity / medianQuantity, 2) : 0,
    firstSeenAt: state.firstSeenAt,
    persistenceMs: Math.max(0, now - state.firstSeenAt),
  };
}

