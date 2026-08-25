import {
  DEFAULT_MARKET_SELECTION,
  MARKET_SCHEMA_VERSION,
  type DepthFrame,
  type MarketDataEvent,
  type MarketSelection,
  type MetricFrame,
  type PriceLevel,
  type PriceTick,
  type StatusFrame,
  type TradeBucket,
  type TrendSignal,
} from '../types/market';
import type { MarketDataSource, MarketEventListener } from './marketDataClient';

export interface DemoMarketDataOptions {
  selection?: MarketSelection;
  intervalMs?: number;
  now?: () => number;
  random?: () => number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundToTick(value: number, tickSize: number): number {
  return Math.round(value / tickSize) * tickSize;
}

function demoStartPrice(symbol: string): number {
  const normalized = symbol.toUpperCase();
  if (normalized.startsWith('ETH')) return 3_500;
  if (normalized.startsWith('SOL')) return 160;
  if (normalized.startsWith('BNB')) return 600;
  return 65_000;
}

function demoTickSize(price: number): number {
  if (price >= 10_000) return 0.1;
  if (price >= 1_000) return 0.01;
  return 0.001;
}

function normalizeSelection(selection: MarketSelection): MarketSelection {
  return {
    exchange: selection.exchange.trim().toLowerCase() || 'demo',
    symbol: selection.symbol.trim().toUpperCase() || DEFAULT_MARKET_SELECTION.symbol,
    market: selection.market,
    depth: clamp(Math.round(selection.depth), 10, 200),
  };
}

/** Offline source with the same event contract as the live gateway. */
export class DemoMarketDataClient implements MarketDataSource {
  readonly mode = 'demo' as const;

  private currentSelection: MarketSelection;
  private readonly listeners = new Set<MarketEventListener>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private running = false;
  private sequence = 0;
  private midPrice: number;
  private previousPrice: number;
  private cvd = 0;

  constructor(options: DemoMarketDataOptions = {}) {
    this.currentSelection = normalizeSelection(options.selection ?? {
      ...DEFAULT_MARKET_SELECTION,
      exchange: 'demo',
    });
    this.intervalMs = Math.max(50, options.intervalMs ?? 150);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.midPrice = demoStartPrice(this.currentSelection.symbol);
    this.previousPrice = this.midPrice;
  }

  get selection(): MarketSelection {
    return this.currentSelection;
  }

  get connected(): boolean {
    return this.running;
  }

  connect(selection?: MarketSelection): void {
    if (selection) this.resetForSelection(selection);
    if (this.running) return;
    this.running = true;
    this.emitStatus('Demo generator active');
    this.generateFrame();
    this.timer = globalThis.setInterval(() => this.generateFrame(), this.intervalMs);
  }

  disconnect(): void {
    this.running = false;
    if (this.timer !== null) globalThis.clearInterval(this.timer);
    this.timer = null;
  }

  setSelection(selection: MarketSelection): void {
    const wasRunning = this.running;
    this.resetForSelection(selection);
    if (wasRunning) {
      this.emitStatus(`Demo switched to ${this.currentSelection.symbol}`);
      this.generateFrame();
    }
  }

  requestSnapshot(): void {
    if (this.running) this.generateFrame();
  }

  subscribe(listener: MarketEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private resetForSelection(selection: MarketSelection): void {
    this.currentSelection = normalizeSelection(selection);
    this.sequence = 0;
    this.midPrice = demoStartPrice(this.currentSelection.symbol);
    this.previousPrice = this.midPrice;
    this.cvd = 0;
  }

  private generateFrame(): void {
    const timestamp = this.now();
    const tickSize = demoTickSize(this.midPrice);
    const wave = Math.sin(this.sequence / 35);
    const noise = (this.random() - 0.5) * tickSize * 1.2;
    this.previousPrice = this.midPrice;
    this.midPrice = roundToTick(this.midPrice + wave * tickSize * 1.4 + noise, tickSize);

    const depth = Math.min(this.currentSelection.depth, 80);
    const bids: PriceLevel[] = [];
    const asks: PriceLevel[] = [];
    const movingWall = 6 + Math.floor((Math.sin(this.sequence / 18) + 1) * 8);
    for (let index = 0; index < depth; index += 1) {
      const distance = index + 1;
      const baseline = 0.25 + this.random() * 2.2 + Math.exp(-distance / 22) * 2;
      const bidWall = distance === movingWall && wave > 0 ? 18 + this.random() * 12 : 0;
      const askWall = distance === movingWall && wave < 0 ? 18 + this.random() * 12 : 0;
      bids.push({
        price: roundToTick(this.midPrice - distance * tickSize, tickSize),
        quantity: baseline + bidWall,
      });
      asks.push({
        price: roundToTick(this.midPrice + distance * tickSize, tickSize),
        quantity: baseline + askWall,
      });
    }

    const bestBid = bids[0]?.price ?? this.midPrice - tickSize;
    const bestAsk = asks[0]?.price ?? this.midPrice + tickSize;
    const common = this.base(timestamp);
    const depthFrame: DepthFrame = {
      ...common,
      type: 'depth_frame',
      timestamp,
      lastUpdateId: common.sequence,
      bids,
      asks,
      bestBid,
      bestAsk,
      midPrice: this.midPrice,
      spread: bestAsk - bestBid,
      stale: false,
      source: 'demo',
    };
    this.emit(depthFrame);

    const movement = this.midPrice - this.previousPrice;
    const buyBias = clamp(0.5 + wave * 0.32 + Math.sign(movement) * 0.08, 0.03, 0.97);
    const totalVolume = 0.5 + this.random() * 8 + Math.abs(wave) * 14;
    const buyVolume = totalVolume * buyBias;
    const sellVolume = totalVolume - buyVolume;
    const delta = buyVolume - sellVolume;
    this.cvd += delta;
    const tradePrice = movement >= 0 ? bestAsk : bestBid;

    const trade: TradeBucket = {
      ...this.base(timestamp),
      type: 'trade_bucket',
      timestamp,
      bucketStart: timestamp - this.intervalMs,
      bucketEnd: timestamp,
      price: tradePrice,
      side: delta > 0 ? 'buy' : delta < 0 ? 'sell' : 'unknown',
      volume: totalVolume,
      tradeCount: Math.max(1, Math.round(totalVolume * 1.8)),
      vwap: tradePrice,
      maxTrade: totalVolume * (0.2 + this.random() * 0.35),
      buyVolume,
      sellVolume,
      totalVolume,
      delta,
    };
    this.emit(trade);

    const price: PriceTick = {
      ...this.base(timestamp),
      type: 'price',
      timestamp,
      price: tradePrice,
      quantity: totalVolume,
      side: trade.side,
    };
    this.emit(price);

    const score = clamp(Math.abs(wave) * 88 + Math.abs(movement / tickSize) * 5, 0, 100);
    const direction = score >= 40 ? (wave >= 0 ? 'up' : 'down') : 'neutral';
    const imbalance = clamp(wave * 0.72 + (this.random() - 0.5) * 0.15, -1, 1);
    const metric: MetricFrame = {
      ...this.base(timestamp),
      type: 'metric',
      timestamp,
      lastPrice: tradePrice,
      bestBid,
      bestAsk,
      spread: bestAsk - bestBid,
      delta,
      cvd: this.cvd,
      buyVolume,
      sellVolume,
      buySellRatio: sellVolume === 0 ? buyVolume : buyVolume / sellVolume,
      imbalance,
      tradeRate: trade.tradeCount / (this.intervalMs / 1_000),
      volumeRatio: 0.8 + Math.abs(wave) * 2.4,
      momentumShort: movement / tickSize,
      momentumMedium: wave,
      latencyMs: 2 + Math.round(this.random() * 7),
      stale: false,
    };
    this.emit(metric);

    const trend: TrendSignal = {
      ...this.base(timestamp),
      type: 'trend_signal',
      timestamp,
      direction,
      score,
      upScore: direction === 'up' ? score : Math.max(0, 35 - score / 4),
      downScore: direction === 'down' ? score : Math.max(0, 35 - score / 4),
      confidence: score / 100,
      active: score >= 65,
      strength:
        score >= 80 ? 'very_strong' : score >= 60 ? 'strong' : score >= 40 ? 'forming' : 'neutral',
      reasons:
        direction === 'neutral'
          ? ['Balanced order flow']
          : [
              direction === 'up' ? 'Positive volume delta' : 'Negative volume delta',
              `${direction === 'up' ? 'Bid' : 'Ask'} liquidity imbalance`,
              'Sustained trade velocity',
            ],
      since: score >= 40 ? timestamp - Math.round(Math.abs(wave) * 4_000) : null,
    };
    this.emit(trend);

    this.sequence += 1;
  }

  private base(timestamp: number) {
    return {
      schemaVersion: MARKET_SCHEMA_VERSION,
      exchange: this.currentSelection.exchange,
      symbol: this.currentSelection.symbol,
      exchangeTimestamp: timestamp,
      serverTimestamp: timestamp,
      sequence: ++this.sequence,
    };
  }

  private emitStatus(message: string): void {
    const timestamp = this.now();
    const status: StatusFrame = {
      ...this.base(timestamp),
      type: 'status',
      timestamp,
      state: 'demo',
      source: 'demo',
      message,
      stale: false,
      resyncCount: 0,
      lastEventTimestamp: timestamp,
      latencyMs: 0,
      validity: 'valid',
      transportAlive: true,
      marketActive: true,
      synchronized: true,
      frozen: false,
      lastValidAt: timestamp,
    };
    this.emit(status);
  }

  private emit(event: MarketDataEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
