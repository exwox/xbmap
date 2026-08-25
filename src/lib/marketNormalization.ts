import {
  MARKET_SCHEMA_VERSION,
  type ConnectionState,
  type DataQualityCounters,
  type DataValidity,
  type DepthFrame,
  type HeartbeatFrame,
  type MarketResetFrame,
  type MarketSide,
  type MetricFrame,
  type NormalizedMarketEvent,
  type PriceLevel,
  type PriceTick,
  type StatusFrame,
  type TradeBucket,
  type TrendDirection,
  type TrendSignal,
  type TrendStrength,
} from '../types/market';

type UnknownRecord = Record<string, unknown>;

const CONNECTION_STATES = new Set<ConnectionState>([
  'idle',
  'connecting',
  'syncing',
  'live',
  'reconnecting',
  'demo',
  'stale',
  'error',
  'closed',
]);

const TREND_STRENGTHS = new Set<TrendStrength>([
  'neutral',
  'forming',
  'strong',
  'very_strong',
]);

const DATA_VALIDITIES = new Set<DataValidity>([
  'invalid',
  'syncing',
  'valid',
  'stale',
  'closed',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function firstNumber(record: UnknownRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstString(record: UnknownRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function nullableNumber(record: UnknownRecord, keys: readonly string[]): number | null {
  return firstNumber(record, keys) ?? null;
}

function nonNegative(value: number | undefined, fallback = 0): number {
  return value === undefined ? fallback : Math.max(0, value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeConfidence(value: number | undefined): number {
  if (value === undefined) return 0;
  return clamp(value > 1 ? value / 100 : value, 0, 1);
}

function normalizeSide(value: unknown, buyVolume = 0, sellVolume = 0): MarketSide {
  if (value === 'buy' || value === 'BUY' || value === 'bid') return 'buy';
  if (value === 'sell' || value === 'SELL' || value === 'ask') return 'sell';
  if (buyVolume > sellVolume) return 'buy';
  if (sellVolume > buyVolume) return 'sell';
  return 'unknown';
}

function normalizeDirection(value: unknown): TrendDirection {
  if (value === 'up' || value === 'bullish' || value === 'buy') return 'up';
  if (value === 'down' || value === 'bearish' || value === 'sell') return 'down';
  return 'neutral';
}

function normalizeStrength(value: unknown, score: number): TrendStrength {
  if (typeof value === 'string' && TREND_STRENGTHS.has(value as TrendStrength)) {
    return value as TrendStrength;
  }
  if (score >= 80) return 'very_strong';
  if (score >= 60) return 'strong';
  if (score >= 40) return 'forming';
  return 'neutral';
}

/** Normalizes seconds, milliseconds, microseconds, or nanoseconds to UTC epoch ms. */
export function normalizeTimestamp(value: unknown, fallback = 0): number {
  const parsed = finiteNumber(value);
  if (parsed === undefined || parsed <= 0) return fallback;

  const absolute = Math.abs(parsed);
  if (absolute < 100_000_000_000) return Math.round(parsed * 1_000);
  if (absolute >= 100_000_000_000_000_000) return Math.round(parsed / 1_000_000);
  if (absolute >= 100_000_000_000_000) return Math.round(parsed / 1_000);
  return Math.round(parsed);
}

export interface NormalizePriceLevelOptions {
  side?: 'bid' | 'ask';
  keepZeroQuantity?: boolean;
}

/** Accepts exchange tuples and common object variants, and always returns numeric levels. */
export function normalizePriceLevels(
  input: unknown,
  options: NormalizePriceLevelOptions = {},
): PriceLevel[] {
  if (!Array.isArray(input)) return [];

  const levels = new Map<number, number>();
  for (const rawLevel of input) {
    let price: number | undefined;
    let quantity: number | undefined;

    if (Array.isArray(rawLevel)) {
      price = finiteNumber(rawLevel[0]);
      quantity = finiteNumber(rawLevel[1]);
    } else if (isRecord(rawLevel)) {
      price = firstNumber(rawLevel, ['price', 'p']);
      quantity = firstNumber(rawLevel, ['quantity', 'qty', 'size', 'volume', 'q']);
    }

    if (
      price === undefined ||
      quantity === undefined ||
      price <= 0 ||
      quantity < 0 ||
      (!options.keepZeroQuantity && quantity === 0)
    ) {
      continue;
    }

    levels.set(price, quantity);
  }

  const result = Array.from(levels, ([price, quantity]) => ({ price, quantity }));
  if (options.side) {
    const multiplier = options.side === 'bid' ? -1 : 1;
    result.sort((left, right) => multiplier * (left.price - right.price));
  }
  return result;
}

function parseInput(input: unknown): UnknownRecord | null {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(input) ? input : null;
}

export interface WireEnvelopeMetadata {
  type: string | null;
  /** Global producer counter. Informational only; it is not delivery-contiguous. */
  sequence: number | null;
  /** Stable identity for a client-specific delivery stream, when provided. */
  streamId: string | null;
  /** Contiguous counter scoped to `streamId`, when provided. */
  deliverySequence: number | null;
}

/**
 * Reads envelope metadata even for control messages the chart does not consume.
 * `sequence` is intentionally kept separate from the optional client delivery
 * counter: the gateway's global sequence can jump because of REST requests or
 * traffic sent to another socket.
 */
export function readWireEnvelopeMetadata(input: unknown): WireEnvelopeMetadata {
  const root = parseInput(input);
  if (!root) {
    return {
      type: null,
      sequence: null,
      streamId: null,
      deliverySequence: null,
    };
  }
  return {
    type: firstString(root, ['type', 'event']) ?? null,
    sequence: firstNumber(root, ['sequence', 'sequenceEnd', 'sequence_end']) ?? null,
    streamId: firstString(root, ['streamId', 'stream_id', 'deliveryStreamId', 'delivery_stream_id']) ?? null,
    deliverySequence:
      firstNumber(root, ['deliverySequence', 'delivery_sequence']) ?? null,
  };
}

interface EventContext {
  type: string;
  data: UnknownRecord;
  schemaVersion: number;
  exchange: string;
  symbol: string;
  exchangeTimestamp: number;
  serverTimestamp: number;
  sequence: number;
}

function buildContext(root: UnknownRecord, receivedAt: number): EventContext | null {
  const type = firstString(root, ['type', 'event']);
  if (!type) return null;

  const data = isRecord(root.data) ? root.data : root;
  const serverTimestamp = normalizeTimestamp(
    firstNumber(root, ['serverTimestamp', 'server_timestamp', 'timestamp']),
    receivedAt,
  );
  const exchangeTimestamp = normalizeTimestamp(
    firstNumber(root, ['exchangeTimestamp', 'exchange_timestamp']) ??
      firstNumber(data, ['exchangeTimestamp', 'exchange_timestamp', 'timestamp', 'time']),
    serverTimestamp,
  );

  return {
    type,
    data,
    schemaVersion: firstNumber(root, ['schemaVersion', 'schema_version', 'version']) ?? MARKET_SCHEMA_VERSION,
    exchange: firstString(root, ['exchange']) ?? firstString(data, ['exchange']) ?? 'unknown',
    symbol: firstString(root, ['symbol']) ?? firstString(data, ['symbol']) ?? 'unknown',
    exchangeTimestamp,
    serverTimestamp,
    sequence:
      firstNumber(root, ['sequence', 'sequenceEnd', 'sequence_end']) ??
      firstNumber(data, ['sequence', 'sequenceEnd', 'sequence_end', 'lastUpdateId']) ??
      0,
  };
}

function eventBase(context: EventContext) {
  return {
    schemaVersion: context.schemaVersion,
    exchange: context.exchange,
    symbol: context.symbol,
    exchangeTimestamp: context.exchangeTimestamp,
    serverTimestamp: context.serverTimestamp,
    sequence: context.sequence,
  };
}

function normalizeDepth(context: EventContext): DepthFrame {
  const { data } = context;
  const bids = normalizePriceLevels(data.bids, { side: 'bid' });
  const asks = normalizePriceLevels(data.asks, { side: 'ask' });
  const bestBid = nullableNumber(data, ['bestBid', 'best_bid']) ?? bids[0]?.price ?? null;
  const bestAsk = nullableNumber(data, ['bestAsk', 'best_ask']) ?? asks[0]?.price ?? null;
  const midPrice =
    nullableNumber(data, ['midPrice', 'mid_price']) ??
    (bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null);
  const spread =
    nullableNumber(data, ['spread']) ??
    (bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null);

  return {
    ...eventBase(context),
    type: 'depth_frame',
    timestamp: context.exchangeTimestamp,
    lastUpdateId: firstNumber(data, ['lastUpdateId', 'last_update_id']) ?? context.sequence,
    bids,
    asks,
    bestBid,
    bestAsk,
    midPrice,
    spread,
    stale: data.stale === true,
    source: firstString(data, ['source']) ?? context.exchange,
  };
}

function normalizeTrade(context: EventContext): TradeBucket {
  const { data } = context;
  const buyVolume = nonNegative(firstNumber(data, ['buyVolume', 'buy_volume']));
  const sellVolume = nonNegative(firstNumber(data, ['sellVolume', 'sell_volume']));
  const totalVolume = nonNegative(
    firstNumber(data, ['totalVolume', 'total_volume', 'volume']),
    buyVolume + sellVolume,
  );
  const price = firstNumber(data, ['price', 'vwap']) ?? 0;
  const bucketStart = normalizeTimestamp(
    firstNumber(data, ['bucketStart', 'bucket_start', 'timestamp']),
    context.exchangeTimestamp,
  );
  const bucketEnd = normalizeTimestamp(
    firstNumber(data, ['bucketEnd', 'bucket_end']),
    bucketStart,
  );

  return {
    ...eventBase(context),
    type: 'trade_bucket',
    timestamp: bucketEnd,
    bucketStart,
    bucketEnd,
    price,
    side: normalizeSide(data.side, buyVolume, sellVolume),
    volume: nonNegative(firstNumber(data, ['volume']), totalVolume),
    tradeCount: Math.max(0, Math.trunc(firstNumber(data, ['tradeCount', 'trade_count']) ?? 0)),
    vwap: firstNumber(data, ['vwap']) ?? price,
    maxTrade: nonNegative(firstNumber(data, ['maxTrade', 'max_trade'])),
    buyVolume,
    sellVolume,
    totalVolume,
    delta: firstNumber(data, ['delta']) ?? buyVolume - sellVolume,
  };
}

function normalizePrice(context: EventContext): PriceTick {
  const { data } = context;
  return {
    ...eventBase(context),
    type: 'price',
    timestamp: context.exchangeTimestamp,
    price: firstNumber(data, ['price']) ?? 0,
    quantity: nonNegative(firstNumber(data, ['quantity', 'qty', 'size', 'volume'])),
    side: normalizeSide(data.side),
  };
}

function normalizeMetric(context: EventContext): MetricFrame {
  const { data } = context;
  return {
    ...eventBase(context),
    type: 'metric',
    timestamp: context.exchangeTimestamp,
    lastPrice: nullableNumber(data, ['lastPrice', 'last_price']),
    bestBid: nullableNumber(data, ['bestBid', 'best_bid']),
    bestAsk: nullableNumber(data, ['bestAsk', 'best_ask']),
    spread: nullableNumber(data, ['spread']),
    delta: firstNumber(data, ['delta']) ?? 0,
    cvd: firstNumber(data, ['cvd']) ?? 0,
    buyVolume: nonNegative(firstNumber(data, ['buyVolume', 'buy_volume'])),
    sellVolume: nonNegative(firstNumber(data, ['sellVolume', 'sell_volume'])),
    buySellRatio: nonNegative(firstNumber(data, ['buySellRatio', 'buy_sell_ratio'])),
    imbalance: clamp(firstNumber(data, ['imbalance']) ?? 0, -1, 1),
    tradeRate: nonNegative(firstNumber(data, ['tradeRate', 'trade_rate'])),
    volumeRatio: nonNegative(firstNumber(data, ['volumeRatio', 'volume_ratio'])),
    momentumShort: firstNumber(data, ['momentumShort', 'momentum_short']) ?? 0,
    momentumMedium: firstNumber(data, ['momentumMedium', 'momentum_medium']) ?? 0,
    latencyMs: nonNegative(firstNumber(data, ['latencyMs', 'latency_ms'])),
    stale: data.stale === true,
  };
}

function normalizeTrend(context: EventContext): TrendSignal {
  const { data } = context;
  const score = clamp(firstNumber(data, ['score']) ?? 0, 0, 100);
  const rawReasons = data.reasons;
  return {
    ...eventBase(context),
    type: 'trend_signal',
    timestamp: context.exchangeTimestamp,
    direction: normalizeDirection(data.direction),
    score,
    upScore: clamp(firstNumber(data, ['upScore', 'up_score']) ?? 0, 0, 100),
    downScore: clamp(firstNumber(data, ['downScore', 'down_score']) ?? 0, 0, 100),
    confidence: normalizeConfidence(firstNumber(data, ['confidence'])),
    active: data.active === true,
    strength: normalizeStrength(data.strength, score),
    reasons: Array.isArray(rawReasons)
      ? rawReasons.filter((reason): reason is string => typeof reason === 'string')
      : [],
    since:
      data.since === null
        ? null
        : normalizeTimestamp(firstNumber(data, ['since']), context.exchangeTimestamp),
  };
}

function normalizeStatus(context: EventContext): StatusFrame {
  const { data } = context;
  const rawState = firstString(data, ['state']);
  const state =
    rawState && CONNECTION_STATES.has(rawState as ConnectionState)
      ? (rawState as ConnectionState)
      : 'error';
  const lastEvent = firstNumber(data, ['lastEventTimestamp', 'last_event_timestamp']);
  const lastValidAt = firstNumber(data, ['lastValidAt', 'last_valid_at']);
  const rawValidity = firstString(data, ['validity']);
  const validity = rawValidity && DATA_VALIDITIES.has(rawValidity as DataValidity)
    ? rawValidity as DataValidity
    : undefined;
  const rawCounters = isRecord(data.counters) ? data.counters : null;
  const counters: DataQualityCounters | undefined = rawCounters
    ? {
        sequenceGaps: Math.max(0, Math.trunc(firstNumber(rawCounters, ['sequenceGaps', 'sequence_gaps']) ?? 0)),
        duplicates: Math.max(0, Math.trunc(firstNumber(rawCounters, ['duplicates']) ?? 0)),
        outOfOrder: Math.max(0, Math.trunc(firstNumber(rawCounters, ['outOfOrder', 'out_of_order']) ?? 0)),
        malformedEvents: Math.max(0, Math.trunc(firstNumber(rawCounters, ['malformedEvents', 'malformed_events']) ?? 0)),
        crossedBooks: Math.max(0, Math.trunc(firstNumber(rawCounters, ['crossedBooks', 'crossed_books']) ?? 0)),
        resyncs: Math.max(0, Math.trunc(firstNumber(rawCounters, ['resyncs']) ?? 0)),
        queueOverflows: Math.max(0, Math.trunc(firstNumber(rawCounters, ['queueOverflows', 'queue_overflows']) ?? 0)),
      }
    : undefined;
  const resyncCount = Math.max(
    0,
    Math.trunc(firstNumber(data, ['resyncCount', 'resync_count']) ?? counters?.resyncs ?? 0),
  );

  return {
    ...eventBase(context),
    type: 'status',
    timestamp: context.serverTimestamp,
    state,
    source: firstString(data, ['source']) ?? context.exchange,
    message: firstString(data, ['message']) ?? '',
    stale: data.stale === true || state === 'stale',
    resyncCount,
    lastEventTimestamp: lastEvent === undefined ? null : normalizeTimestamp(lastEvent, 0),
    latencyMs: nullableNumber(data, ['latencyMs', 'latency_ms']),
    ...(validity ? { validity } : {}),
    ...(typeof data.transportAlive === 'boolean' ? { transportAlive: data.transportAlive } : {}),
    ...(typeof data.marketActive === 'boolean' ? { marketActive: data.marketActive } : {}),
    ...(typeof data.synchronized === 'boolean' ? { synchronized: data.synchronized } : {}),
    ...(typeof data.frozen === 'boolean' ? { frozen: data.frozen } : {}),
    ...(firstString(data, ['reason']) ? { reason: firstString(data, ['reason']) } : {}),
    ...(firstString(data, ['sessionId', 'session_id'])
      ? { sessionId: firstString(data, ['sessionId', 'session_id']) }
      : {}),
    ...(lastValidAt !== undefined ? { lastValidAt: normalizeTimestamp(lastValidAt, 0) } : {}),
    ...(counters ? { counters } : {}),
    ...(firstNumber(data, ['clockDriftMs', 'clock_drift_ms']) !== undefined
      ? { clockDriftMs: nullableNumber(data, ['clockDriftMs', 'clock_drift_ms']) }
      : {}),
  };
}

function normalizeHeartbeat(context: EventContext): HeartbeatFrame {
  const { data } = context;
  const clientId = firstString(data, ['clientId', 'client_id']);
  return {
    ...eventBase(context),
    type: 'heartbeat',
    timestamp: context.serverTimestamp,
    ...(clientId ? { clientId } : {}),
    uptimeMs: nonNegative(firstNumber(data, ['uptimeMs', 'uptime_ms'])),
  };
}

function normalizeMarketReset(context: EventContext): MarketResetFrame {
  const { data } = context;
  const previousSessionId = firstString(data, ['previousSessionId', 'previous_session_id']);
  return {
    ...eventBase(context),
    type: 'market_reset',
    timestamp: context.serverTimestamp,
    sessionId: firstString(data, ['sessionId', 'session_id']) ?? 'unknown',
    ...(previousSessionId ? { previousSessionId } : {}),
    reason: firstString(data, ['reason']) ?? 'Market session reset',
    frozen: data.frozen !== false,
  };
}

/**
 * Converts versioned gateway envelopes to the one UI-facing schema. Malformed or
 * unsupported messages return null instead of destabilizing the render loop.
 */
export function normalizeMarketEvent(
  input: unknown,
  receivedAt = Date.now(),
): NormalizedMarketEvent | null {
  const root = parseInput(input);
  if (!root) return null;
  const context = buildContext(root, receivedAt);
  if (!context) return null;

  switch (context.type) {
    case 'snapshot':
    case 'depth_frame':
      return normalizeDepth(context);
    case 'trade':
    case 'trade_bucket':
      return normalizeTrade(context);
    case 'price':
      return normalizePrice(context);
    case 'metrics':
    case 'metric':
      return normalizeMetric(context);
    case 'trend':
    case 'trend_signal':
      return normalizeTrend(context);
    case 'status':
      return normalizeStatus(context);
    case 'market_reset':
      return normalizeMarketReset(context);
    case 'heartbeat':
    case 'pong':
      return normalizeHeartbeat(context);
    default:
      return null;
  }
}
