import type {
  BookApplyStatus,
} from "../../server/core/orderBook.js";
import type {
  DepthSnapshot,
  DepthUpdate,
  MetricFrame,
  NormalizedTrade,
  PriceLevel,
  StatusFrame,
  TrendDirection,
  TrendSignal,
} from "../../server/types.js";

export const FIXTURE_SCHEMA_VERSION = 1 as const;
export const FIXTURE_GENERATOR_VERSION = "1.0.0" as const;

export type FixtureScenarioId =
  | "calm"
  | "strong-uptrend"
  | "high-volatility"
  | "reconnect-sequence-gap";

interface FixtureEventBase {
  /** Contiguous, one-based source ordering. */
  ordinal: number;
  /** Deterministic replay clock in Unix epoch milliseconds. */
  at: number;
}

export interface FixtureSnapshotEvent extends FixtureEventBase {
  kind: "snapshot";
  data: DepthSnapshot;
}

export interface FixtureDepthEvent extends FixtureEventBase {
  kind: "depth";
  data: DepthUpdate;
  /** Golden outcome for OrderBook.applyUpdate. */
  expectedBookResult: BookApplyStatus;
}

export interface FixtureTradeEvent extends FixtureEventBase {
  kind: "trade";
  data: NormalizedTrade;
}

export interface FixtureStatusEvent extends FixtureEventBase {
  kind: "status";
  data: StatusFrame;
}

export interface FixtureCheckpointEvent extends FixtureEventBase {
  kind: "checkpoint";
  data: {
    name: string;
    /** Force signal invalidation even if the retained book can still be read. */
    forceInvalid?: boolean;
  };
}

export type FixtureEvent =
  | FixtureSnapshotEvent
  | FixtureDepthEvent
  | FixtureTradeEvent
  | FixtureStatusEvent
  | FixtureCheckpointEvent;

export interface FixtureMarketMetadata {
  exchange: "binance";
  symbol: "BTCUSDT";
  product: "usd-m-perpetual";
  tickSize: number;
  priceBucketTicks: number;
  timeBucketMs: number;
  visibleDepth: number;
}

export interface FixtureScenario {
  id: FixtureScenarioId;
  title: string;
  description: string;
  tags: string[];
  seed: number;
  market: FixtureMarketMetadata;
  events: FixtureEvent[];
}

export interface FixtureDepthResult {
  ordinal: number;
  sequenceStart: number;
  sequenceEnd: number;
  status: BookApplyStatus;
  lastUpdateId: number;
}

export interface FixtureCheckpointOutcome {
  name: string;
  at: number;
  bookValid: boolean;
  lastUpdateId: number;
  metric: MetricFrame;
  trend: TrendSignal;
}

export interface FixtureExpectedOutcome {
  sequence: {
    snapshotsLoaded: number;
    depthApplied: number;
    depthIgnored: number;
    depthGaps: number;
    depthInvalid: number;
    depthUnsynced: number;
    resyncs: number;
    finalLastUpdateId: number;
    depthResults: FixtureDepthResult[];
  };
  orderBook: {
    depth: number;
    bids: PriceLevel[];
    asks: PriceLevel[];
    bestBid: number | null;
    bestAsk: number | null;
    midPrice: number | null;
    spread: number | null;
    imbalance: number;
    fingerprint: string;
  };
  trades: {
    count: number;
    buyCount: number;
    sellCount: number;
    buyVolume: number;
    sellVolume: number;
    delta: number;
    firstPrice: number | null;
    lastPrice: number | null;
    lowPrice: number | null;
    highPrice: number | null;
    priceChangeBps: number;
    realizedVolatilityBps: number;
  };
  trend: {
    finalDirection: TrendDirection;
    finalScore: number;
    finalActive: boolean;
    activatedDirections: TrendDirection[];
    maxUpScore: number;
    maxDownScore: number;
    directionTransitions: number;
  };
  connection: {
    states: Array<{
      at: number;
      state: StatusFrame["state"];
      stale: boolean;
      resyncCount: number;
    }>;
    gapDetected: boolean;
    recoveredAfterGap: boolean;
  };
  checkpoints: FixtureCheckpointOutcome[];
}

export interface FixtureManifest {
  fixtureSchemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  eventSchemaVersion: 1;
  id: FixtureScenarioId;
  title: string;
  description: string;
  tags: string[];
  generator: {
    name: "liquidmap-phase0-fixture-generator";
    version: typeof FIXTURE_GENERATOR_VERSION;
    seed: number;
  };
  provenance: {
    source: "synthetic";
    containsExchangeCapture: false;
    redistribution: "project-owned-generated-data";
  };
  market: FixtureMarketMetadata;
  capture: {
    from: number;
    to: number;
    durationMs: number;
    eventCount: number;
    eventCounts: Record<FixtureEvent["kind"], number>;
  };
  data: {
    path: string;
    format: "ndjson";
    encoding: "utf-8";
    bytes: number;
    lines: number;
    sha256: string;
  };
  expected: FixtureExpectedOutcome;
}

export interface FixtureIndexEntry {
  id: FixtureScenarioId;
  tags: string[];
  manifest: string;
  data: string;
  eventCount: number;
  dataSha256: string;
  manifestSha256: string;
}

export interface FixtureIndex {
  fixtureSchemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  fixtureSet: "phase-0-market-regression";
  generatorVersion: typeof FIXTURE_GENERATOR_VERSION;
  deterministic: true;
  scenarios: FixtureIndexEntry[];
}
