import { describe, expect, it } from 'vitest';

import { EMPTY_STATUS, type TrendSignal } from '../types/market';
import { assessDataQuality, validatedTrend } from './dataQuality';

const liveStatus = {
  ...EMPTY_STATUS,
  state: 'live' as const,
  source: 'binance',
  message: 'Order book reconciled',
  stale: false,
  validity: 'valid' as const,
  transportAlive: true,
  marketActive: true,
  synchronized: true,
  frozen: false,
};

describe('assessDataQuality', () => {
  it('requires a non-stale book in addition to a live transport', () => {
    expect(assessDataQuality({
      mode: 'live',
      status: liveStatus,
      isStale: false,
      hasBook: true,
    })).toMatchObject({ code: 'valid', valid: true, label: 'VALIDATED' });

    expect(assessDataQuality({
      mode: 'live',
      status: liveStatus,
      isStale: false,
      hasBook: false,
    })).toMatchObject({ code: 'waiting', valid: false });
  });

  it('explains reconnect, resync, and stale states without calling them live', () => {
    expect(assessDataQuality({
      mode: 'live',
      status: {
        ...liveStatus,
        state: 'syncing',
        message: 'Sequence gap detected; requesting snapshot',
        resyncCount: 2,
      },
      isStale: true,
      hasBook: true,
    })).toMatchObject({ code: 'resyncing', action: 'snapshot', valid: false });

    expect(assessDataQuality({
      mode: 'live',
      status: { ...liveStatus, state: 'reconnecting', message: 'retrying' },
      isStale: true,
      hasBook: true,
    })).toMatchObject({ code: 'reconnecting', action: 'reconnect', valid: false });

    expect(assessDataQuality({
      mode: 'live',
      status: { ...liveStatus, state: 'stale', stale: true },
      isStale: true,
      hasBook: true,
    })).toMatchObject({ code: 'stale', action: 'snapshot', valid: false });
  });

  it('accepts replay only after its first valid book frame', () => {
    expect(assessDataQuality({
      mode: 'replay',
      status: { ...liveStatus, state: 'syncing' },
      isStale: false,
      hasBook: true,
    })).toMatchObject({ code: 'valid', label: 'REPLAY VALID' });
  });

  it('prefers explicit gateway validity over a nominal live state', () => {
    expect(assessDataQuality({
      mode: 'live',
      status: {
        ...liveStatus,
        validity: 'syncing',
        synchronized: false,
        frozen: true,
        reason: 'Buffered sequence chain is incomplete',
      },
      isStale: false,
      hasBook: true,
    })).toMatchObject({
      code: 'resyncing',
      valid: false,
      detail: 'Buffered sequence chain is incomplete',
    });

    expect(assessDataQuality({
      mode: 'live',
      status: {
        ...liveStatus,
        validity: 'valid',
        transportAlive: true,
        marketActive: false,
        synchronized: true,
        frozen: false,
      },
      isStale: false,
      hasBook: true,
    })).toMatchObject({ code: 'inactive', valid: false });
  });

  it('fails closed when a nominal live status omits required quality proof', () => {
    expect(assessDataQuality({
      mode: 'live',
      status: {
        ...liveStatus,
        validity: undefined,
        synchronized: undefined,
        frozen: undefined,
      },
      isStale: false,
      hasBook: true,
    })).toMatchObject({ code: 'syncing', valid: false, label: 'QUALITY UNVERIFIED' });
  });
});

describe('validatedTrend', () => {
  const trend = {
    type: 'trend_signal',
    schemaVersion: 1,
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchangeTimestamp: 1,
    serverTimestamp: 1,
    sequence: 1,
    timestamp: 1,
    direction: 'up',
    score: 80,
    upScore: 80,
    downScore: 20,
    confidence: 0.8,
    active: true,
    strength: 'very_strong',
    reasons: ['delta'],
    since: 1,
  } satisfies TrendSignal;

  it('clears active signals while book quality is invalid', () => {
    expect(validatedTrend(trend, { valid: false })).toBeNull();
    expect(validatedTrend(trend, { valid: true })).toBe(trend);
  });
});
