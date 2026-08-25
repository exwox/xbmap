export const MARKET_SCHEMA_VERSION = 1 as const;

export type MarketKind = 'spot' | 'perpetual' | 'futures';
export type MarketSide = 'buy' | 'sell' | 'unknown';
export type BookSide = 'bid' | 'ask';
export type DataSourceMode = 'live' | 'demo';
export type TrendDirection = 'up' | 'down' | 'neutral';
export type TrendStrength = 'neutral' | 'forming' | 'strong' | 'very_strong';
export type DataValidity = 'invalid' | 'syncing' | 'valid' | 'stale' | 'closed';
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'syncing'
  | 'live'
  | 'reconnecting'
  | 'demo'
  | 'stale'
  | 'error'
  | 'closed';

export interface MarketSelection {
  exchange: string;
  symbol: string;
  market: MarketKind;
  /** Number of levels requested from the gateway. */
  depth: number;
}

export interface PriceLevel {
  price: number;
  quantity: number;
}

export interface MarketEventBase {
  schemaVersion: number;
  exchange: string;
  symbol: string;
  /** Exchange time in UTC epoch milliseconds. */
  exchangeTimestamp: number;
  /** Gateway time in UTC epoch milliseconds. */
  serverTimestamp: number;
  sequence: number;
}

export interface DepthFrame extends MarketEventBase {
  type: 'depth_frame';
  timestamp: number;
  lastUpdateId: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  stale: boolean;
  source: string;
}

export interface TradeBucket extends MarketEventBase {
  type: 'trade_bucket';
  timestamp: number;
  bucketStart: number;
  bucketEnd: number;
  price: number;
  side: MarketSide;
  volume: number;
  tradeCount: number;
  vwap: number;
  maxTrade: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  delta: number;
}

export interface PriceTick extends MarketEventBase {
  type: 'price';
  timestamp: number;
  price: number;
  quantity: number;
  side: MarketSide;
}

export interface MetricFrame extends MarketEventBase {
  type: 'metric';
  timestamp: number;
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
  latencyMs: number;
  stale: boolean;
}

export interface TrendSignal extends MarketEventBase {
  type: 'trend_signal';
  timestamp: number;
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

export interface DataQualityCounters {
  sequenceGaps: number;
  duplicates: number;
  outOfOrder: number;
  malformedEvents: number;
  crossedBooks: number;
  resyncs: number;
  queueOverflows: number;
}

export interface StatusFrame extends MarketEventBase {
  type: 'status';
  timestamp: number;
  state: ConnectionState;
  source: string;
  message: string;
  stale: boolean;
  resyncCount: number;
  lastEventTimestamp: number | null;
  latencyMs: number | null;
  /** Explicit book validity fields are additive schema-v1 metadata. */
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
}

export interface HeartbeatFrame extends MarketEventBase {
  type: 'heartbeat';
  timestamp: number;
  clientId?: string;
  uptimeMs: number;
}

export interface MarketResetFrame extends MarketEventBase {
  type: 'market_reset';
  timestamp: number;
  sessionId: string;
  previousSessionId?: string;
  reason: string;
  frozen: boolean;
}

export type NormalizedMarketEvent =
  | DepthFrame
  | TradeBucket
  | PriceTick
  | MetricFrame
  | TrendSignal
  | StatusFrame
  | MarketResetFrame
  | HeartbeatFrame;

export type MarketDataEvent = Exclude<NormalizedMarketEvent, HeartbeatFrame>;

export interface WireEnvelope<T = unknown> {
  type: string;
  schemaVersion: number;
  exchange: string;
  symbol: string;
  serverTimestamp: number;
  exchangeTimestamp?: number;
  /** Optional client-delivery stream identity; global `sequence` is not contiguous per socket. */
  streamId?: string;
  /** Optional counter that is contiguous only within `streamId`. */
  deliverySequence?: number;
  sequence: number;
  data: T;
}

export interface SubscribeRequest {
  type: 'subscribe';
  schemaVersion: typeof MARKET_SCHEMA_VERSION;
  exchange: string;
  symbol: string;
  market: MarketKind;
  depth: number;
}

export interface UnsubscribeRequest {
  type: 'unsubscribe';
  schemaVersion: typeof MARKET_SCHEMA_VERSION;
  exchange: string;
  symbol: string;
}

export interface PingRequest {
  type: 'ping';
  schemaVersion: typeof MARKET_SCHEMA_VERSION;
  timestamp: number;
}

export interface SnapshotRequest {
  type: 'request_snapshot';
  schemaVersion: typeof MARKET_SCHEMA_VERSION;
  exchange: string;
  symbol: string;
}

export type ClientWebSocketMessage =
  | SubscribeRequest
  | UnsubscribeRequest
  | PingRequest
  | SnapshotRequest;

export const DEFAULT_MARKET_SELECTION: MarketSelection = {
  exchange: 'binance',
  symbol: 'BTCUSDT',
  market: 'perpetual',
  depth: 100,
};

export const EMPTY_STATUS: StatusFrame = {
  type: 'status',
  schemaVersion: MARKET_SCHEMA_VERSION,
  exchange: DEFAULT_MARKET_SELECTION.exchange,
  symbol: DEFAULT_MARKET_SELECTION.symbol,
  exchangeTimestamp: 0,
  serverTimestamp: 0,
  sequence: 0,
  timestamp: 0,
  state: 'idle',
  source: 'client',
  message: 'Waiting for market data',
  stale: true,
  resyncCount: 0,
  lastEventTimestamp: null,
  latencyMs: null,
};
