import { EventEmitter } from "node:events";
import type {
  DepthSnapshot,
  DepthUpdate,
  NormalizedTrade,
  StatusFrame,
  WirePriceLevel,
} from "../types.js";

export interface DemoFeedOptions {
  symbol: string;
  tickSize: number;
  initialPrice?: number;
  seed?: number;
}

/** Realistic, bounded synthetic source used automatically when Binance is unavailable. */
export class DemoFeed extends EventEmitter {
  private readonly random: SeededRandom;
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private mid: number;
  private sequence = 1;
  private tradeId = 1;
  private driftDirection: -1 | 1 = 1;
  private driftStrength = 0.15;
  private regimeEndsAt = 0;

  readonly symbol: string;
  readonly tickSize: number;

  constructor(options: DemoFeedOptions) {
    super();
    this.symbol = options.symbol.toUpperCase();
    this.tickSize = options.tickSize;
    this.mid = options.initialPrice ?? 64_000;
    this.random = new SeededRandom(options.seed ?? 0x58424d41);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.regimeEndsAt = 0;
    this.rebuildBook(true);
    this.emit("snapshot", this.snapshot());
    this.emitStatus("demo", "Synthetic market active while Binance reconnects");
    this.timer = setInterval(() => this.step(), 100);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private step(): void {
    const now = Date.now();
    if (now >= this.regimeEndsAt) this.chooseRegime(now);

    const noise = this.random.normal() * this.tickSize * 0.7;
    const impulse = this.driftDirection * this.driftStrength * this.tickSize;
    this.mid = Math.max(100, this.mid + noise + impulse);

    const previousSequence = this.sequence;
    const update = this.rebuildBook(false);
    this.sequence += 1;
    this.emit("depth", {
      exchangeTimestamp: now,
      receivedTimestamp: now,
      sequenceStart: this.sequence,
      sequenceEnd: this.sequence,
      previousSequence,
      bids: update.bids,
      asks: update.asks,
    } satisfies DepthUpdate);

    const tradeCount = 1 + Math.floor(this.random.next() * 5);
    const buyProbability = 0.5 + this.driftDirection * this.driftStrength * 0.22;
    const centerTicks = Math.round(this.mid / this.tickSize);
    for (let index = 0; index < tradeCount; index += 1) {
      const side: NormalizedTrade["side"] = this.random.next() < buyProbability ? "buy" : "sell";
      const priceTicks = side === "buy" ? centerTicks + 1 : centerTicks - 1;
      const wallTrade = this.random.next() > 0.97;
      const quantity = wallTrade
        ? 2 + this.random.next() * 6
        : Math.max(0.001, Math.exp(this.random.normal() * 0.8 - 2.5));
      this.emit("trade", {
        id: `demo-${this.tradeId++}`,
        exchangeTimestamp: now + index,
        receivedTimestamp: now,
        price: priceTicks * this.tickSize,
        quantity,
        side,
      } satisfies NormalizedTrade);
    }
  }

  private chooseRegime(now: number): void {
    this.driftDirection = this.random.next() < 0.5 ? -1 : 1;
    // Most regimes are quiet; some deliberately create visible strong trends.
    this.driftStrength = this.random.next() > 0.62
      ? 0.9 + this.random.next() * 1.3
      : 0.05 + this.random.next() * 0.25;
    this.regimeEndsAt = now + 8_000 + this.random.next() * 22_000;
  }

  private rebuildBook(initial: boolean): { bids: WirePriceLevel[]; asks: WirePriceLevel[] } {
    const centerTicks = Math.round(this.mid / this.tickSize);
    const nextBids = new Map<number, number>();
    const nextAsks = new Map<number, number>();
    for (let distance = 1; distance <= 140; distance += 1) {
      const decay = Math.exp(-distance / 85);
      const wall = distance % 17 === 0 ? 5 + this.random.next() * 12 : 0;
      const base = (0.25 + this.random.next() * 2.5) * decay + wall;
      const bias = 1 + this.driftDirection * this.driftStrength * 0.12;
      nextBids.set(centerTicks - distance, roundQuantity(base * bias));
      nextAsks.set(centerTicks + distance, roundQuantity(base / bias));
    }

    if (initial) {
      this.bids.clear();
      this.asks.clear();
      for (const entry of nextBids) this.bids.set(...entry);
      for (const entry of nextAsks) this.asks.set(...entry);
      return { bids: [], asks: [] };
    }

    const bidUpdates = diffLevels(this.bids, nextBids, this.tickSize);
    const askUpdates = diffLevels(this.asks, nextAsks, this.tickSize);
    this.bids.clear();
    this.asks.clear();
    for (const entry of nextBids) this.bids.set(...entry);
    for (const entry of nextAsks) this.asks.set(...entry);
    return { bids: bidUpdates, asks: askUpdates };
  }

  private snapshot(): DepthSnapshot {
    return {
      lastUpdateId: this.sequence,
      exchangeTimestamp: Date.now(),
      bids: [...this.bids.entries()].map(([ticks, quantity]) => [ticks * this.tickSize, quantity]),
      asks: [...this.asks.entries()].map(([ticks, quantity]) => [ticks * this.tickSize, quantity]),
    };
  }

  private emitStatus(state: StatusFrame["state"], message: string): void {
    this.emit("status", {
      state,
      source: "demo",
      message,
      stale: false,
      resyncCount: 0,
      lastEventTimestamp: Date.now(),
    } satisfies StatusFrame);
  }
}

function diffLevels(
  previous: Map<number, number>,
  next: Map<number, number>,
  tickSize: number,
): WirePriceLevel[] {
  const updates: WirePriceLevel[] = [];
  for (const ticks of previous.keys()) {
    if (!next.has(ticks)) updates.push([ticks * tickSize, 0]);
  }
  for (const [ticks, quantity] of next) {
    if (previous.get(ticks) !== quantity) updates.push([ticks * tickSize, quantity]);
  }
  return updates;
}

function roundQuantity(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

class SeededRandom {
  constructor(private state: number) {}

  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let value = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    value = value + Math.imul(value ^ (value >>> 7), 61 | value) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  normal(): number {
    const first = Math.max(this.next(), Number.EPSILON);
    const second = this.next();
    return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
  }
}
