import { describe, expect, it, vi } from 'vitest';

import type { PriceTick } from '../types/market';
import { ReplayController } from './replayController';

function priceEvent(timestamp: number, price: number): PriceTick {
  return {
    type: 'price',
    schemaVersion: 1,
    exchange: 'demo',
    symbol: 'BTCUSDT',
    exchangeTimestamp: timestamp,
    serverTimestamp: timestamp,
    sequence: timestamp,
    timestamp,
    price,
    quantity: 1,
    side: 'buy',
  };
}

describe('ReplayController', () => {
  it('sorts, seeks, and steps through deterministic events', () => {
    const replay = new ReplayController();
    const received: number[] = [];
    replay.subscribeEvents((event) => {
      if (event.type === 'price') received.push(event.price);
    });

    replay.load([priceEvent(3_000, 3), priceEvent(1_000, 1), priceEvent(2_000, 2)]);
    replay.seek(2_000);
    replay.step();

    expect(received).toEqual([2]);
    expect(replay.state.cursorTimestamp).toBe(2_000);
    expect(replay.state.eventIndex).toBe(2);
    expect(replay.state.status).toBe('paused');
  });

  it('plays according to event time and speed', () => {
    vi.useFakeTimers();
    let clock = 10_000;
    const replay = new ReplayController({ now: () => clock, tickIntervalMs: 10 });
    const received: number[] = [];
    replay.subscribeEvents((event) => {
      if (event.type === 'price') received.push(event.price);
    });
    replay.load([priceEvent(1_000, 1), priceEvent(1_100, 2), priceEvent(1_200, 3)]);
    replay.setSpeed(2);
    replay.play();
    expect(received).toEqual([1]);

    clock += 50;
    vi.advanceTimersByTime(10);
    expect(received).toEqual([1, 2]);

    clock += 50;
    vi.advanceTimersByTime(10);
    expect(received).toEqual([1, 2, 3]);
    expect(replay.state.status).toBe('ended');
    replay.destroy();
    vi.useRealTimers();
  });

  it('bounds playback speed and handles an empty capture', () => {
    const replay = new ReplayController();
    replay.setSpeed(100);
    replay.load([]);

    expect(replay.state.speed).toBe(20);
    expect(replay.state.status).toBe('ready');
    expect(replay.state.eventCount).toBe(0);
  });
});
