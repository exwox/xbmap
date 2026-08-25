import { describe, expect, it } from 'vitest';

import {
  normalizeMarketEvent,
  normalizePriceLevels,
  normalizeTimestamp,
  readWireEnvelopeMetadata,
} from './marketNormalization';

describe('normalizeTimestamp', () => {
  it('normalizes seconds and microseconds to milliseconds', () => {
    expect(normalizeTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeTimestamp(1_700_000_000_123_000)).toBe(1_700_000_000_123);
  });
});

describe('normalizePriceLevels', () => {
  it('accepts tuples and object aliases, filters invalid levels, and sorts books', () => {
    const bids = normalizePriceLevels(
      [
        ['100.25', '2.5'],
        { price: 101, size: 1 },
        [99, 0],
        ['bad', 3],
      ],
      { side: 'bid' },
    );

    expect(bids).toEqual([
      { price: 101, quantity: 1 },
      { price: 100.25, quantity: 2.5 },
    ]);
  });
});

describe('normalizeMarketEvent', () => {
  it('reads sequence metadata from control messages without normalizing them', () => {
    expect(readWireEnvelopeMetadata('{"type":"subscribed","sequence":12}')).toEqual({
      type: 'subscribed',
      sequence: 12,
      streamId: null,
      deliverySequence: null,
    });
    expect(readWireEnvelopeMetadata({
      type: 'status',
      sequence: 81,
      streamId: 'socket-7',
      deliverySequence: 4,
    })).toEqual({
      type: 'status',
      sequence: 81,
      streamId: 'socket-7',
      deliverySequence: 4,
    });
  });

  it('normalizes a gateway depth envelope and derives top-of-book values', () => {
    const event = normalizeMarketEvent({
      type: 'depth_frame',
      schemaVersion: 1,
      exchange: 'binance',
      symbol: 'BTCUSDT',
      serverTimestamp: 1_700_000_000_100,
      exchangeTimestamp: 1_700_000_000_000,
      sequence: 42,
      data: {
        lastUpdateId: 123,
        bids: [['100', '2']],
        asks: [['102', '3']],
        source: 'demo',
      },
    });

    expect(event?.type).toBe('depth_frame');
    if (event?.type !== 'depth_frame') throw new Error('Expected depth frame');
    expect(event.bestBid).toBe(100);
    expect(event.bestAsk).toBe(102);
    expect(event.midPrice).toBe(101);
    expect(event.spread).toBe(2);
    expect(event.timestamp).toBe(1_700_000_000_000);
  });

  it('normalizes a trade bucket and derives side and delta', () => {
    const event = normalizeMarketEvent({
      type: 'trade_bucket',
      serverTimestamp: 1_700_000_000_000,
      sequence: 7,
      data: {
        price: '100.5',
        buyVolume: '8',
        sellVolume: 3,
        bucketStart: 1_700_000_000,
      },
    });

    expect(event).toMatchObject({
      type: 'trade_bucket',
      side: 'buy',
      totalVolume: 11,
      delta: 5,
      timestamp: 1_700_000_000_000,
    });
  });

  it('clamps metrics and converts confidence percentages', () => {
    const metric = normalizeMarketEvent({
      type: 'metric',
      serverTimestamp: 1_700_000_000_000,
      sequence: 1,
      data: { imbalance: 5 },
    });
    const trend = normalizeMarketEvent({
      type: 'trend_signal',
      serverTimestamp: 1_700_000_000_000,
      sequence: 2,
      data: { direction: 'bullish', score: 84, confidence: 72, reasons: ['breakout'] },
    });

    expect(metric).toMatchObject({ type: 'metric', imbalance: 1 });
    expect(trend).toMatchObject({
      type: 'trend_signal',
      direction: 'up',
      strength: 'very_strong',
      confidence: 0.72,
    });
  });

  it('normalizes explicit data-quality validity and counters', () => {
    const status = normalizeMarketEvent({
      type: 'status',
      serverTimestamp: 1_700_000_000_000,
      sequence: 4,
      data: {
        state: 'syncing',
        stale: true,
        validity: 'syncing',
        transportAlive: true,
        marketActive: false,
        synchronized: false,
        frozen: true,
        reason: 'Sequence gap',
        sessionId: 'session-a',
        lastValidAt: 1_700_000_000_000,
        counters: {
          sequenceGaps: 2,
          duplicates: 3,
          outOfOrder: 1,
          malformedEvents: 4,
          crossedBooks: 0,
          resyncs: 5,
          queueOverflows: 1,
        },
        clockDriftMs: -12,
      },
    });

    expect(status).toMatchObject({
      type: 'status',
      validity: 'syncing',
      transportAlive: true,
      marketActive: false,
      synchronized: false,
      frozen: true,
      reason: 'Sequence gap',
      sessionId: 'session-a',
      resyncCount: 5,
      clockDriftMs: -12,
      counters: { sequenceGaps: 2, resyncs: 5 },
    });
  });

  it('normalizes a market reset so consumers can discard the previous validity epoch', () => {
    const reset = normalizeMarketEvent({
      type: 'market_reset',
      schemaVersion: 1,
      exchange: 'binance',
      symbol: 'BTCUSDT',
      serverTimestamp: 1_700_000_000_000,
      sequence: 9,
      data: {
        previousSessionId: 'session-a',
        sessionId: 'session-b',
        reason: 'Atomic reconciliation committed',
        frozen: false,
      },
    });

    expect(reset).toMatchObject({
      type: 'market_reset',
      previousSessionId: 'session-a',
      sessionId: 'session-b',
      reason: 'Atomic reconciliation committed',
      frozen: false,
    });
  });

  it('returns null for malformed or unsupported payloads', () => {
    expect(normalizeMarketEvent('{bad json')).toBeNull();
    expect(normalizeMarketEvent({ type: 'not_supported' })).toBeNull();
  });
});
