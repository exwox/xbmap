// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { UseMarketDataResult } from './useMarketData';
import { useMarketData } from './useMarketData';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
    this.dispatch('close', new Event('close'));
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open', new Event('open'));
  }

  message(value: string): void {
    this.dispatch('message', { data: value } as MessageEvent);
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

describe('useMarketData validity epochs', () => {
  it('clears the old epoch on market_reset and waits for snapshot plus valid status', () => {
    const socket = new FakeSocket();
    let latest: UseMarketDataResult | null = null;
    const createSocket = () => socket as unknown as WebSocket;
    const current = (): UseMarketDataResult => {
      if (latest === null) throw new Error('Hook has not rendered');
      return latest;
    };

    function Harness() {
      latest = useMarketData({
        mode: 'live',
        autoConnect: true,
        createSocket,
        heartbeatIntervalMs: 60_000,
        staleAfterMs: 60_000,
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<Harness />));
    act(() => socket.open());

    const send = (type: string, sequence: number, data: unknown) => {
      socket.message(JSON.stringify({
        type,
        schemaVersion: 1,
        exchange: 'binance',
        symbol: 'BTCUSDT',
        serverTimestamp: 1_700_000_000_000 + sequence,
        exchangeTimestamp: 1_700_000_000_000 + sequence,
        sequence,
        streamId: 'hook-stream',
        deliverySequence: sequence,
        data,
      }));
    };
    const validStatus = (message: string) => ({
      state: 'live',
      source: 'binance',
      message,
      stale: false,
      resyncCount: 0,
      lastEventTimestamp: 1_700_000_000_000,
      validity: 'valid',
      transportAlive: true,
      marketActive: true,
      synchronized: true,
      frozen: false,
      sessionId: 'session-b',
    });

    act(() => {
      send('snapshot', 1, {
        lastUpdateId: 1,
        bids: [[100, 1]],
        asks: [[101, 1]],
        sessionId: 'session-a',
      });
      send('status', 2, { ...validStatus('first epoch'), sessionId: 'session-a' });
      send('trade_bucket', 3, {
        bucketStart: 1,
        bucketEnd: 2,
        price: 100,
        buyVolume: 2,
        sellVolume: 1,
        totalVolume: 3,
      });
      send('metric', 4, { lastPrice: 100, stale: false });
      send('trend_signal', 5, {
        direction: 'up', score: 80, confidence: 0.8, active: true,
      });
    });
    expect(current().depthFrames).toHaveLength(1);
    expect(current().trades).toHaveLength(1);
    expect(current().metrics).not.toBeNull();
    expect(current().trend?.active).toBe(true);

    act(() => send('market_reset', 6, {
      previousSessionId: 'session-a',
      sessionId: 'session-b',
      reason: 'Atomic reconciliation committed',
      frozen: false,
    }));
    expect(current().depthFrames).toEqual([]);
    expect(current().trades).toEqual([]);
    expect(current().priceSeries).toEqual([]);
    expect(current().metrics).toBeNull();
    expect(current().trend).toBeNull();
    expect(current().status).toMatchObject({
      state: 'syncing',
      sessionId: 'session-b',
      frozen: true,
    });

    // A derived frame cannot populate a new epoch before its snapshot.
    act(() => send('depth_frame', 7, {
      lastUpdateId: 7,
      bids: [[999, 1]],
      asks: [[1_000, 1]],
      stale: false,
    }));
    expect(current().depthFrames).toEqual([]);

    act(() => {
      send('snapshot', 8, {
        lastUpdateId: 8,
        bids: [[200, 2]],
        asks: [[201, 2]],
        sessionId: 'session-b',
      });
      send('status', 9, validStatus('second epoch'));
    });
    expect(current().depthFrames).toHaveLength(1);
    expect(current().depthFrames[0]?.lastUpdateId).toBe(8);
    expect(current().isStale).toBe(false);
    expect(current().status).toMatchObject({ state: 'live', sessionId: 'session-b' });
  });
});
