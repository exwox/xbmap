export const SCHEMA_VERSION = 1 as const;

export const DEFAULT_EXCHANGE = "binance" as const;
export const DEFAULT_SYMBOL = "BTCUSDT" as const;
export const DEFAULT_TICK_SIZE = 0.1;

export type ExchangeName = typeof DEFAULT_EXCHANGE;
export type MarketSource = "binance" | "demo";
export type AggressorSide = "buy" | "sell";
export type ConnectionState =
  | "connecting"
  | "syncing"
  | "live"
  | "reconnecting"
  | "demo"
  | "stale"
  | "error"
  | "closed";

export type DataValidity = "invalid" | "syncing" | "valid" | "stale" | "closed";

export interface DataQualityCounters {
  sequenceGaps: number;
  duplicates: number;
  outOfOrder: number;
  malformedEvents: number;
  crossedBooks: number;
  resyncs: number;
  queueOverflows: number;
}

export interface ClockDriftStats {
  /** receivedTimestamp - exchangeTimestamp; a positive value means the exchange clock is behind. */
  latestMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  averageMs: number | null;
  samples: number;
}

export interface BookCheckpoint {
  algorithm: "sha256";
  fingerprint: string;
  lastUpdateId: number;
  bidLevelCount: number;
  askLevelCount: number;
  bestBid: number | null;
  bestAsk: number | null;
}

export interface DataQualityState {
  sessionId: string;
  validity: DataValidity;
  transportAlive: boolean;
  marketActive: boolean;
  synchronized: boolean;
  frozen: boolean;
  reason: string;
  lastValidAt: number | null;
  counters: DataQualityCounters;
  clockDrift: ClockDriftStats;
  checkpoint: BookCheckpoint | null;
}

export type PriceLevel = [price: number, quantity: number];
export type WirePriceLevel = [price: string | number, quantity: string | number];

export interface DepthSnapshot {
  lastUpdateId: number;
  exchangeTimestamp?: number;
  bids: WirePriceLevel[];
  asks: WirePriceLevel[];
}

export interface DepthUpdate {
  exchangeTimestamp: number;
  receivedTimestamp: number;
  sequenceStart: number;
  sequenceEnd: number;
  previousSequence?: number;
  bids: WirePriceLevel[];
  asks: WirePriceLevel[];
}

export interface NormalizedTrade {
  id: string;
  exchangeTimestamp: number;
  receivedTimestamp: number;
  price: number;
  quantity: number;
  side: AggressorSide;
}

export interface TradeBucket {
  bucketStart: number;
  bucketEnd: number;
  price: number;
  side: AggressorSide;
  volume: number;
  tradeCount: number;
  vwap: number;
  maxTrade: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  delta: number;
}

export interface BookFrame {
  lastUpdateId: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  stale: boolean;
  source: MarketSource;
  /** Additive v1 quality metadata; old clients may ignore these fields. */
  valid?: boolean;
  sessionId?: string;
  checkpoint?: BookCheckpoint;
}

export interface MetricFrame {
  lastPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  delta: number;
  cvd: number;
  buyVolume: number;
  sellVolume: number;
  buySellRatio: number;
  imbalance: number;
  tradeRate: number;
  volumeRatio: number;
  momentumShort: number;
  momentumMedium: number;
  latencyMs: number | null;
  stale: boolean;
}

export type TrendDirection = "up" | "down" | "neutral";
export type TrendStrength = "neutral" | "forming" | "strong" | "very_strong";

export interface TrendSignal {
  direction: TrendDirection;
  score: number;
  upScore: number;
  downScore: number;
  confidence: number;
  active: boolean;
  strength: TrendStrength;
  reasons: string[];
  since: number | null;
}

export interface StatusFrame {
  state: ConnectionState;
  source: MarketSource;
  message: string;
  stale: boolean;
  resyncCount: number;
  lastEventTimestamp: number | null;
  /** Additive v1 data-quality fields retained as optional for wire compatibility. */
  validity?: DataValidity;
  transportAlive?: boolean;
  marketActive?: boolean;
  synchronized?: boolean;
  frozen?: boolean;
  reason?: string;
  sessionId?: string;
  lastValidAt?: number | null;
  counters?: DataQualityCounters;
  clockDriftMs?: number | null;
  clockDrift?: ClockDriftStats;
  checkpoint?: BookCheckpoint | null;
}

export type ServerEventType =
  | "snapshot"
  | "depth_frame"
  | "trade_bucket"
  | "price"
  | "metric"
  | "trend_signal"
  | "status"
  | "heartbeat"
  | "error"
  | "subscribed"
  | "unsubscribed"
  | "replay_frame"
  | "market_reset";

export interface ServerEnvelope<T = unknown> {
  type: ServerEventType;
  schemaVersion: typeof SCHEMA_VERSION;
  exchange: ExchangeName;
  symbol: string;
  serverTimestamp: number;
  exchangeTimestamp?: number;
  sequence: number;
  /** Optional WebSocket connection-scoped delivery metadata, added at send time. */
  streamId?: string;
  deliverySequence?: number;
  data: T;
}

export interface ClientSubscribeMessage {
  type: "subscribe";
  exchange?: ExchangeName;
  symbol?: string;
  depth?: number;
}

export interface ClientUnsubscribeMessage {
  type: "unsubscribe";
  exchange?: ExchangeName;
  symbol?: string;
}

export interface ClientPingMessage {
  type: "ping";
  timestamp?: number;
}

export interface ClientSnapshotMessage {
  type: "request_snapshot";
}

export type ClientMessage =
  | ClientSubscribeMessage
  | ClientUnsubscribeMessage
  | ClientPingMessage
  | ClientSnapshotMessage;

export interface HistoryPoint {
  timestamp: number;
  price: number | null;
  volume: number;
  delta: number;
  cvd: number;
  imbalance: number;
  trendScore: number;
  trendDirection: TrendDirection;
}

export interface GatewaySettings {
  frameIntervalMs: number;
  bubbleBucketMs: number;
  visibleDepth: number;
  staleAfterMs: number;
  demoFallbackAfterMs: number;
  trendEnterScore: number;
  trendExitScore: number;
}

export const DEFAULT_SETTINGS: GatewaySettings = {
  frameIntervalMs: 100,
  bubbleBucketMs: 250,
  visibleDepth: 80,
  staleAfterMs: 3_000,
  demoFallbackAfterMs: 4_000,
  trendEnterScore: 65,
  trendExitScore: 50,
};
