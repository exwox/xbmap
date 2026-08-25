import {
  MARKET_SCHEMA_VERSION,
  type MetricFrame,
  type NormalizedMarketEvent,
  type PriceTick,
  type TradeBucket,
  type TrendSignal,
} from '../types/market';
import type {
  ReplayHistoryPoint,
  ReplaySession,
  ReplaySessionRequest,
} from '../types/replay';
import { normalizeTimestamp } from './marketNormalization';

type UnknownRecord = Record<string, unknown>;

export interface ReplayApiOptions {
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  exchange?: string;
}

export interface ReplayCapture {
  session: ReplaySession;
  events: NormalizedMarketEvent[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function apiUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path) || path.startsWith('/')) return path;
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

async function readJson(response: Response): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const record = isRecord(payload) ? payload : null;
    const error = record && isRecord(record.error) ? record.error : null;
    throw new Error(text(error?.message, `Replay request failed (${response.status})`));
  }
  return payload;
}

function normalizeHistoryPoint(value: unknown): ReplayHistoryPoint | null {
  if (!isRecord(value)) return null;
  const timestamp = normalizeTimestamp(value.timestamp, 0);
  if (timestamp <= 0) return null;
  const rawPrice = value.price;
  const parsedPrice = rawPrice === null ? null : finite(rawPrice, Number.NaN);
  return {
    timestamp,
    price: parsedPrice !== null && !Number.isFinite(parsedPrice) ? null : parsedPrice,
    volume: Math.max(0, finite(value.volume)),
    delta: finite(value.delta),
    cvd: finite(value.cvd),
    imbalance: Math.max(-1, Math.min(1, finite(value.imbalance))),
    trendScore: Math.max(0, Math.min(100, finite(value.trendScore))),
    trendDirection:
      value.trendDirection === 'up' || value.trendDirection === 'down'
        ? value.trendDirection
        : 'neutral',
  };
}

export function normalizeReplaySession(value: unknown): ReplaySession | null {
  const root = isRecord(value) ? value : null;
  const session = root && isRecord(root.session) ? root.session : root;
  if (!session) return null;
  const id = text(session.id);
  const symbol = text(session.symbol).toUpperCase();
  if (!id || !symbol) return null;
  const rawFrames = Array.isArray(session.frames) ? session.frames : [];
  const frames = rawFrames
    .map(normalizeHistoryPoint)
    .filter((frame): frame is ReplayHistoryPoint => frame !== null)
    .sort((left, right) => left.timestamp - right.timestamp);

  return {
    id,
    symbol,
    from: normalizeTimestamp(session.from, frames[0]?.timestamp ?? 0),
    to: normalizeTimestamp(session.to, frames[frames.length - 1]?.timestamp ?? 0),
    speed: Math.max(0.1, Math.min(20, finite(session.speed, 1))),
    expiresAt: normalizeTimestamp(session.expiresAt, 0),
    frames,
  };
}

/** Converts stored analytics frames into the same event stream consumed by the UI. */
export function replaySessionToEvents(
  session: ReplaySession,
  exchange = 'binance',
): NormalizedMarketEvent[] {
  const events: NormalizedMarketEvent[] = [];
  let sequence = 0;
  let previousTimestamp = session.from;
  let lastPrice: number | null = null;

  for (const frame of session.frames) {
    if (frame.price !== null) lastPrice = frame.price;
    const timestamp = frame.timestamp;
    const volume = Math.max(0, frame.volume);
    const delta = Math.max(-volume, Math.min(volume, frame.delta));
    const buyVolume = Math.max(0, (volume + delta) / 2);
    const sellVolume = Math.max(0, (volume - delta) / 2);
    const common = () => ({
      schemaVersion: MARKET_SCHEMA_VERSION,
      exchange,
      symbol: session.symbol,
      exchangeTimestamp: timestamp,
      serverTimestamp: timestamp,
      sequence: ++sequence,
    });

    if (lastPrice !== null) {
      const trade: TradeBucket = {
        ...common(),
        type: 'trade_bucket',
        timestamp,
        bucketStart: Math.min(previousTimestamp, timestamp),
        bucketEnd: timestamp,
        price: lastPrice,
        side: delta > 0 ? 'buy' : delta < 0 ? 'sell' : 'unknown',
        volume,
        tradeCount: volume > 0 ? 1 : 0,
        vwap: lastPrice,
        maxTrade: volume,
        buyVolume,
        sellVolume,
        totalVolume: volume,
        delta,
      };
      events.push(trade);

      const price: PriceTick = {
        ...common(),
        type: 'price',
        timestamp,
        price: lastPrice,
        quantity: volume,
        side: trade.side,
      };
      events.push(price);
    }

    const metric: MetricFrame = {
      ...common(),
      type: 'metric',
      timestamp,
      lastPrice,
      bestBid: null,
      bestAsk: null,
      spread: null,
      delta,
      cvd: frame.cvd,
      buyVolume,
      sellVolume,
      buySellRatio: sellVolume > 0 ? buyVolume / sellVolume : buyVolume,
      imbalance: frame.imbalance,
      tradeRate: 0,
      volumeRatio: 0,
      momentumShort: 0,
      momentumMedium: 0,
      latencyMs: 0,
      stale: false,
    };
    events.push(metric);

    const score = frame.trendScore;
    const trend: TrendSignal = {
      ...common(),
      type: 'trend_signal',
      timestamp,
      direction: frame.trendDirection,
      score,
      upScore: frame.trendDirection === 'up' ? score : 0,
      downScore: frame.trendDirection === 'down' ? score : 0,
      confidence: Math.max(0, Math.min(1, (score - 25) / 75)),
      active: frame.trendDirection !== 'neutral' && score >= 65,
      strength:
        score >= 80 ? 'very_strong' : score >= 60 ? 'strong' : score >= 40 ? 'forming' : 'neutral',
      reasons:
        frame.trendDirection === 'neutral'
          ? []
          : [
              delta >= 0 ? 'Positive volume delta' : 'Negative volume delta',
              frame.imbalance >= 0 ? 'Bid liquidity imbalance' : 'Ask liquidity imbalance',
            ],
      since: frame.trendDirection !== 'neutral' && score >= 65 ? timestamp : null,
    };
    events.push(trend);
    previousTimestamp = timestamp;
  }

  return events;
}

export async function fetchReplayCapture(
  request: ReplaySessionRequest = {},
  options: ReplayApiOptions = {},
): Promise<ReplayCapture> {
  const fetcher = options.fetcher ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? '/api/v1';
  const creationPayload = await readJson(
    await fetcher(apiUrl(apiBaseUrl, 'replay/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: options.signal,
    }),
  );
  const root = isRecord(creationPayload) ? creationPayload : null;
  const summary = root && isRecord(root.session) ? root.session : null;
  const sessionId = text(summary?.id);
  if (!sessionId) throw new Error('Replay session response did not include an id');
  const framesUrl = text(summary?.framesUrl, `replay/session/${encodeURIComponent(sessionId)}`);
  const sessionPayload = await readJson(
    await fetcher(apiUrl(apiBaseUrl, framesUrl), { signal: options.signal }),
  );
  const session = normalizeReplaySession(sessionPayload);
  if (!session) throw new Error('Replay session payload is malformed');
  return {
    session,
    events: replaySessionToEvents(session, options.exchange),
  };
}
