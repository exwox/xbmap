import type {
  DepthSnapshot,
  DepthUpdate,
  NormalizedTrade,
  StatusFrame,
  WirePriceLevel,
} from "../../server/types.js";
import type {
  FixtureEvent,
  FixtureMarketMetadata,
  FixtureScenario,
  FixtureScenarioId,
} from "./schema.js";

const BASE_TIME = Date.UTC(2025, 0, 1, 0, 0, 0);

const MARKET: FixtureMarketMetadata = {
  exchange: "binance",
  symbol: "BTCUSDT",
  product: "usd-m-perpetual",
  tickSize: 0.1,
  priceBucketTicks: 1,
  timeBucketMs: 250,
  visibleDepth: 5,
};

interface SyntheticBook {
  bids: WirePriceLevel[];
  asks: WirePriceLevel[];
}

class ScenarioBuilder {
  readonly events: FixtureEvent[] = [];
  private ordinal = 0;
  private tradeId = 0;

  constructor(
    readonly id: FixtureScenarioId,
    readonly baseTime: number,
  ) {}

  snapshot(offsetMs: number, lastUpdateId: number, book: SyntheticBook): void {
    const at = this.baseTime + offsetMs;
    const data: DepthSnapshot = {
      lastUpdateId,
      exchangeTimestamp: at,
      bids: book.bids,
      asks: book.asks,
    };
    this.events.push({ ordinal: ++this.ordinal, at, kind: "snapshot", data });
  }

  depth(
    offsetMs: number,
    sequence: number,
    previousSequence: number,
    bids: WirePriceLevel[],
    asks: WirePriceLevel[],
    expectedBookResult: "applied" | "ignored" | "gap" | "invalid" | "unsynced" = "applied",
  ): void {
    const at = this.baseTime + offsetMs;
    const data: DepthUpdate = {
      exchangeTimestamp: at,
      receivedTimestamp: at + 2,
      sequenceStart: sequence,
      sequenceEnd: sequence,
      previousSequence,
      bids,
      asks,
    };
    this.events.push({
      ordinal: ++this.ordinal,
      at,
      kind: "depth",
      data,
      expectedBookResult,
    });
  }

  trade(
    offsetMs: number,
    price: number,
    quantity: number,
    side: NormalizedTrade["side"],
  ): void {
    const at = this.baseTime + offsetMs;
    const data: NormalizedTrade = {
      id: `${this.id}-${++this.tradeId}`,
      exchangeTimestamp: at,
      receivedTimestamp: at + 3,
      price: round(price, 1),
      quantity: round(quantity, 6),
      side,
    };
    this.events.push({ ordinal: ++this.ordinal, at, kind: "trade", data });
  }

  status(
    offsetMs: number,
    state: StatusFrame["state"],
    message: string,
    resyncCount = 0,
    stale = false,
    lastEventOffsetMs = offsetMs,
  ): void {
    const at = this.baseTime + offsetMs;
    const data: StatusFrame = {
      state,
      source: "binance",
      message,
      stale,
      resyncCount,
      lastEventTimestamp: this.baseTime + lastEventOffsetMs,
    };
    this.events.push({ ordinal: ++this.ordinal, at, kind: "status", data });
  }

  checkpoint(offsetMs: number, name: string, forceInvalid = false): void {
    const at = this.baseTime + offsetMs;
    this.events.push({
      ordinal: ++this.ordinal,
      at,
      kind: "checkpoint",
      data: { name, ...(forceInvalid ? { forceInvalid: true } : {}) },
    });
  }
}

export function createFixtureScenarios(): FixtureScenario[] {
  return [
    calmScenario(),
    strongUptrendScenario(),
    highVolatilityScenario(),
    reconnectSequenceGapScenario(),
  ];
}

function calmScenario(): FixtureScenario {
  const seed = 0x0ca1_0001;
  const random = new DeterministicRandom(seed);
  const builder = new ScenarioBuilder("calm", BASE_TIME);
  const initialBook = makeBook(64_000, 1.03, 1, 5);
  builder.snapshot(0, 100, initialBook);
  builder.status(1, "live", "Synthetic calm feed synchronized");

  for (let second = 1; second <= 8; second += 1) {
    const at = second * 1_000;
    const bidQuantity = 1.7 + random.next() * 0.25;
    const askQuantity = 1.68 + random.next() * 0.25;
    builder.depth(
      at,
      100 + second,
      99 + second,
      [[63_999.9, round(bidQuantity, 3)]],
      [[64_000.1, round(askQuantity, 3)]],
    );
    const buyQuantity = 0.12 + random.next() * 0.025;
    const sellQuantity = buyQuantity * (0.97 + random.next() * 0.06);
    builder.trade(at + 100, 64_000.1, buyQuantity, "buy");
    builder.trade(at + 450, 63_999.9, sellQuantity, "sell");
    if (second === 4) builder.checkpoint(at + 800, "calm-midpoint");
    if (second === 8) builder.checkpoint(at + 800, "calm-final");
  }

  return {
    id: "calm",
    title: "Calm, balanced market",
    description: "Narrow spread, balanced aggressor flow, and low price movement.",
    tags: ["calm", "balanced-flow", "neutral-trend"],
    seed,
    market: { ...MARKET },
    events: builder.events,
  };
}

function strongUptrendScenario(): FixtureScenario {
  const seed = 0x57a0_0002;
  const random = new DeterministicRandom(seed);
  const builder = new ScenarioBuilder("strong-uptrend", BASE_TIME + 60 * 60_000);
  let book = makeBook(64_000, 5.8, 1, 5);
  builder.snapshot(0, 200, book);
  builder.status(1, "live", "Synthetic uptrend feed synchronized");

  // Four low-volume seconds establish the baseline used by volumeRatio.
  builder.trade(100, 64_000.1, 0.09, "buy");
  builder.trade(1_100, 64_000, 0.08, "sell");
  builder.trade(2_100, 64_000.2, 0.1, "buy");
  builder.trade(3_100, 64_000.1, 0.08, "sell");

  let nextBook = makeBook(64_100, 7.2, 0.9, 5);
  let delta = diffBook(book, nextBook);
  builder.depth(4_900, 201, 200, delta.bids, delta.asks);
  book = nextBook;

  const firstBurst = [
    [5_000, 64_050, 1.2, "buy"],
    [5_300, 64_080, 1.05, "buy"],
    [5_600, 64_070, 0.14, "sell"],
    [5_900, 64_120, 1.45, "buy"],
    [6_200, 64_160, 1.12, "buy"],
  ] as const;
  for (const [offset, price, quantity, side] of firstBurst) {
    builder.trade(offset, price, quantity + random.next() * 0.03, side);
  }

  nextBook = makeBook(64_200, 8.1, 0.85, 5);
  delta = diffBook(book, nextBook);
  builder.depth(6_400, 202, 201, delta.bids, delta.asks);
  book = nextBook;

  const secondBurst = [
    [6_500, 64_190, 1.3, "buy"],
    [6_800, 64_220, 1.55, "buy"],
    [7_100, 64_210, 0.12, "sell"],
    [7_400, 64_255, 1.7, "buy"],
  ] as const;
  for (const [offset, price, quantity, side] of secondBurst) {
    builder.trade(offset, price, quantity + random.next() * 0.03, side);
  }

  nextBook = makeBook(64_300, 9.2, 0.8, 5);
  delta = diffBook(book, nextBook);
  builder.depth(7_600, 203, 202, delta.bids, delta.asks);
  builder.trade(7_700, 64_270, 1.8 + random.next() * 0.03, "buy");
  builder.trade(7_900, 64_290, 1.65 + random.next() * 0.03, "buy");
  builder.trade(8_100, 64_300.1, 2.1 + random.next() * 0.03, "buy");

  // Three identical high-score frames are required to cross enter hysteresis.
  builder.checkpoint(8_300, "uptrend-confirmation-1");
  builder.checkpoint(8_400, "uptrend-confirmation-2");
  builder.checkpoint(8_500, "uptrend-confirmed");

  return {
    id: "strong-uptrend",
    title: "Strong bullish trend",
    description: "Price breakout, buy delta, rising CVD, bid imbalance, and elevated volume align.",
    tags: ["trend", "bullish", "breakout", "signal-confirmation"],
    seed,
    market: { ...MARKET },
    events: builder.events,
  };
}

function highVolatilityScenario(): FixtureScenario {
  const seed = 0x701a_0003;
  const random = new DeterministicRandom(seed);
  const builder = new ScenarioBuilder("high-volatility", BASE_TIME + 2 * 60 * 60_000);
  let book = makeBook(64_000, 1, 1, 5);
  builder.snapshot(0, 300, book);
  builder.status(1, "live", "Synthetic volatile feed synchronized");

  const waves = [
    { offset: 1_000, target: 64_400, side: "buy" as const },
    { offset: 8_000, target: 63_500, side: "sell" as const },
    { offset: 15_000, target: 64_600, side: "buy" as const },
    { offset: 22_000, target: 63_400, side: "sell" as const },
    { offset: 29_000, target: 64_700, side: "buy" as const },
    { offset: 36_000, target: 63_300, side: "sell" as const },
  ];
  let previousPrice = 64_000;
  let sequence = 300;

  waves.forEach((wave, index) => {
    const bidScale = wave.side === "buy" ? 6.5 : 0.85;
    const askScale = wave.side === "sell" ? 6.5 : 0.85;
    const nextBook = makeBook(wave.target, bidScale, askScale, 5);
    const delta = diffBook(book, nextBook);
    sequence += 1;
    builder.depth(wave.offset, sequence, sequence - 1, delta.bids, delta.asks);
    book = nextBook;

    const move = wave.target - previousPrice;
    builder.trade(wave.offset + 50, previousPrice + move * 0.25, 2.5 + random.next() * 0.2, wave.side);
    builder.trade(wave.offset + 150, previousPrice + move * 0.5, 3.4 + random.next() * 0.2, wave.side);
    builder.trade(
      wave.offset + 250,
      previousPrice + move * 0.48,
      0.35 + random.next() * 0.05,
      wave.side === "buy" ? "sell" : "buy",
    );
    builder.trade(wave.offset + 300, previousPrice + move * 0.75, 4 + random.next() * 0.2, wave.side);
    builder.trade(wave.offset + 380, wave.target + (wave.side === "buy" ? 0.1 : -0.1), 5 + random.next() * 0.2, wave.side);
    builder.checkpoint(wave.offset + 500, `volatility-wave-${index + 1}`);
    previousPrice = wave.target;
  });

  return {
    id: "high-volatility",
    title: "High volatility, alternating direction",
    description: "Large alternating price and flow impulses exercise signal hysteresis without a sustained trend.",
    tags: ["volatile", "whipsaw", "alternating-flow", "hysteresis"],
    seed,
    market: { ...MARKET },
    events: builder.events,
  };
}

function reconnectSequenceGapScenario(): FixtureScenario {
  const seed = 0x6a90_0004;
  const builder = new ScenarioBuilder(
    "reconnect-sequence-gap",
    BASE_TIME + 3 * 60 * 60_000,
  );
  let book = makeBook(64_000, 1.1, 1, 5);
  builder.snapshot(0, 400, book);
  builder.status(1, "live", "Initial synthetic connection synchronized");
  builder.trade(100, 64_000.1, 0.3, "buy");
  builder.trade(200, 63_999.9, 0.29, "sell");
  builder.depth(300, 401, 400, [[63_999.9, 2.25]], [[64_000.1, 1.95]]);
  builder.depth(400, 401, 400, [[63_999.9, 2.25]], [], "ignored");
  builder.trade(500, 64_000.1, 0.22, "buy");
  builder.checkpoint(550, "before-sequence-gap");

  // Sequence 402 is intentionally absent; pu also proves the discontinuity.
  builder.depth(600, 403, 402, [[63_999.8, 3]], [], "gap");
  builder.status(601, "reconnecting", "Sequence gap detected; reconnect scheduled", 1, false, 600);
  builder.checkpoint(700, "signal-invalid-during-gap", true);
  builder.status(900, "syncing", "Loading replacement snapshot", 1, false, 600);

  book = makeBook(64_001, 1.2, 1, 5);
  builder.snapshot(1_000, 405, book);
  builder.status(1_001, "live", "Replacement snapshot synchronized", 1, false, 1_000);
  builder.depth(1_100, 406, 405, [[64_000.9, 2.4]], [[64_001.1, 1.8]]);
  builder.trade(1_200, 64_001.1, 0.28, "buy");
  builder.trade(1_300, 64_000.9, 0.27, "sell");
  builder.checkpoint(1_400, "recovered-after-resync");

  return {
    id: "reconnect-sequence-gap",
    title: "Sequence gap and reconnect recovery",
    description: "A missing depth sequence invalidates the signal until a replacement snapshot bridges live updates.",
    tags: ["reconnect", "sequence-gap", "duplicate", "resync", "data-quality"],
    seed,
    market: { ...MARKET },
    events: builder.events,
  };
}

function makeBook(
  center: number,
  bidScale: number,
  askScale: number,
  levels: number,
): SyntheticBook {
  const centerTicks = Math.round(center / MARKET.tickSize);
  const bids: WirePriceLevel[] = [];
  const asks: WirePriceLevel[] = [];
  for (let distance = 1; distance <= levels; distance += 1) {
    const shape = 1 + distance * 0.18;
    bids.push([
      round((centerTicks - distance) * MARKET.tickSize, 1),
      round(bidScale * shape, 3),
    ]);
    asks.push([
      round((centerTicks + distance) * MARKET.tickSize, 1),
      round(askScale * shape, 3),
    ]);
  }
  return { bids, asks };
}

function diffBook(previous: SyntheticBook, next: SyntheticBook): SyntheticBook {
  return {
    bids: diffSide(previous.bids, next.bids),
    asks: diffSide(previous.asks, next.asks),
  };
}

function diffSide(previous: WirePriceLevel[], next: WirePriceLevel[]): WirePriceLevel[] {
  const previousByPrice = new Map(previous.map(([price, quantity]) => [Number(price), Number(quantity)]));
  const nextByPrice = new Map(next.map(([price, quantity]) => [Number(price), Number(quantity)]));
  const result: WirePriceLevel[] = [];
  for (const [price] of previousByPrice) {
    if (!nextByPrice.has(price)) result.push([price, 0]);
  }
  for (const [price, quantity] of nextByPrice) {
    if (previousByPrice.get(price) !== quantity) result.push([price, quantity]);
  }
  return result;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

class DeterministicRandom {
  constructor(private state: number) {}

  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let value = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    value = value + Math.imul(value ^ (value >>> 7), 61 | value) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }
}
