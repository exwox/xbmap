import { createDeterministicDemoData } from './components/MarketHeatmap';
import type {
  MetricFrame,
  NormalizedMarketEvent,
  StatusFrame,
  TrendDirection,
} from './types';

const SYMBOL = 'BTCUSDT';
const EXCHANGE = 'replay';

/** Build a deterministic four-minute recording for the built-in replay demo. */
export function createDemoReplay(now = Date.now()): NormalizedMarketEvent[] {
  const source = createDeterministicDemoData(29);
  const sourceStart = source.depthFrames[0]?.timestamp ?? 0;
  const replayStart = now - 4 * 60_000;
  const shift = (timestamp: number) => replayStart + (timestamp - sourceStart);
  const events: NormalizedMarketEvent[] = [];
  let sequence = 0;

  const base = (timestamp: number) => ({
    schemaVersion: 1,
    exchange: EXCHANGE,
    symbol: SYMBOL,
    exchangeTimestamp: shift(timestamp),
    serverTimestamp: shift(timestamp),
    sequence: ++sequence,
  });

  const statusTimestamp = sourceStart;
  const status: StatusFrame = {
    ...base(statusTimestamp),
    type: 'status',
    timestamp: shift(statusTimestamp),
    state: 'syncing',
    source: 'replay',
    message: 'Rekaman demo siap diputar',
    stale: false,
    resyncCount: 0,
    lastEventTimestamp: shift(statusTimestamp),
    latencyMs: 0,
  };
  events.push(status);

  for (const [index, frame] of source.depthFrames.entries()) {
    const timestamp = shift(frame.timestamp);
    const bestBid = frame.bids[0]?.price ?? null;
    const bestAsk = frame.asks[0]?.price ?? null;
    events.push({
      ...base(frame.timestamp),
      type: 'depth_frame',
      timestamp,
      lastUpdateId: index + 1,
      bids: frame.bids.map((level) => ({
        price: level.price,
        quantity: level.quantity ?? level.size ?? 0,
      })),
      asks: frame.asks.map((level) => ({
        price: level.price,
        quantity: level.quantity ?? level.size ?? 0,
      })),
      bestBid,
      bestAsk,
      midPrice: frame.midPrice ?? (bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null),
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      stale: false,
      source: 'replay',
    });

    const point = source.priceSeries[index];
    if (!point) continue;
    const previous = source.priceSeries[Math.max(0, index - 12)]?.price ?? point.price;
    const momentum = previous === 0 ? 0 : (point.price - previous) / previous;
    const wave = Math.sin(index / 27);
    const buyVolume = 24 + Math.max(0, wave) * 62;
    const sellVolume = 24 + Math.max(0, -wave) * 62;
    const delta = buyVolume - sellVolume;
    const direction: TrendDirection = Math.abs(momentum) < 0.00005 ? 'neutral' : momentum > 0 ? 'up' : 'down';
    const score = Math.min(94, Math.max(22, Math.abs(momentum) * 42_000 + Math.abs(wave) * 34));

    events.push({
      ...base(point.timestamp),
      type: 'price',
      timestamp,
      price: point.price,
      quantity: buyVolume + sellVolume,
      side: delta >= 0 ? 'buy' : 'sell',
    });

    const metric: MetricFrame = {
      ...base(point.timestamp),
      type: 'metric',
      timestamp,
      lastPrice: point.price,
      bestBid,
      bestAsk,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      delta,
      cvd: wave * 410 + index * 0.6,
      buyVolume,
      sellVolume,
      buySellRatio: buyVolume / Math.max(0.0001, sellVolume),
      imbalance: wave * 0.62,
      tradeRate: 48 + Math.abs(wave) * 115,
      volumeRatio: 0.85 + Math.abs(wave) * 2.2,
      momentumShort: momentum,
      momentumMedium: (point.price - (source.priceSeries[Math.max(0, index - 45)]?.price ?? point.price)) / point.price,
      latencyMs: 0,
      stale: false,
    };
    events.push(metric);

    if (index % 3 === 0) {
      events.push({
        ...base(point.timestamp),
        type: 'trend_signal',
        timestamp,
        direction,
        score,
        upScore: direction === 'up' ? score : Math.max(10, 52 - score / 2),
        downScore: direction === 'down' ? score : Math.max(10, 52 - score / 2),
        confidence: Math.max(0.25, score / 100),
        active: score >= 65,
        strength: score >= 80 ? 'very_strong' : score >= 60 ? 'strong' : score >= 40 ? 'forming' : 'neutral',
        reasons: direction === 'neutral'
          ? ['Order flow seimbang']
          : [
              direction === 'up' ? 'Momentum harga positif' : 'Momentum harga negatif',
              direction === 'up' ? 'Delta beli meningkat' : 'Delta jual meningkat',
              'Kecepatan transaksi terkonfirmasi',
            ],
        since: score >= 65 ? timestamp - 3_000 : null,
      });
    }
  }

  for (const trade of source.trades) {
    const timestamp = shift(trade.timestamp);
    const buyVolume = trade.buyVolume ?? 0;
    const sellVolume = trade.sellVolume ?? 0;
    const totalVolume = trade.totalVolume ?? trade.volume ?? buyVolume + sellVolume;
    const side = trade.side ?? (buyVolume >= sellVolume ? 'buy' : 'sell');
    const price = trade.vwap ?? trade.price ?? 0;
    events.push({
      ...base(trade.timestamp),
      type: 'trade_bucket',
      timestamp,
      bucketStart: timestamp - 250,
      bucketEnd: timestamp,
      price,
      side,
      volume: totalVolume,
      tradeCount: trade.tradeCount ?? 1,
      vwap: price,
      maxTrade: totalVolume * 0.7,
      buyVolume,
      sellVolume,
      totalVolume,
      delta: buyVolume - sellVolume,
    });
  }

  return events
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((event, index) => ({ ...event, sequence: index + 1 }));
}
