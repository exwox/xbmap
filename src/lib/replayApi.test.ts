import { describe, expect, it } from 'vitest';

import { normalizeReplaySession, replaySessionToEvents } from './replayApi';

describe('replay API normalization', () => {
  it('normalizes stored history and produces chronological UI events', () => {
    const session = normalizeReplaySession({
      session: {
        id: 'capture-1',
        symbol: 'btcusdt',
        from: 1_700_000_000_000,
        to: 1_700_000_001_000,
        speed: 2,
        expiresAt: 1_800_000_000_000,
        frames: [
          {
            timestamp: 1_700_000_001_000,
            price: 101,
            volume: 10,
            delta: 4,
            cvd: 8,
            imbalance: 0.3,
            trendScore: 70,
            trendDirection: 'up',
          },
          {
            timestamp: 1_700_000_000_000,
            price: 100,
            volume: 6,
            delta: -2,
            cvd: 4,
            imbalance: -0.2,
            trendScore: 55,
            trendDirection: 'down',
          },
        ],
      },
    });

    expect(session?.symbol).toBe('BTCUSDT');
    expect(session?.frames[0]?.price).toBe(100);
    if (!session) throw new Error('Expected replay session');

    const events = replaySessionToEvents(session);
    const trades = events.filter((event) => event.type === 'trade_bucket');
    const trends = events.filter((event) => event.type === 'trend_signal');
    expect(trades[0]).toMatchObject({ buyVolume: 2, sellVolume: 4, delta: -2 });
    expect(trends[1]).toMatchObject({ direction: 'up', score: 70, active: true });
    expect(events.every((event, index) => index === 0 || event.timestamp >= events[index - 1]!.timestamp)).toBe(true);
  });

  it('rejects malformed sessions', () => {
    expect(normalizeReplaySession({ session: { symbol: 'BTCUSDT' } })).toBeNull();
  });
});
