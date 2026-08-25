import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MarketDataEvent } from '../types/market';
import { WebSocketMarketDataClient } from './marketDataClient';

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
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

  message(value: unknown): void {
    this.dispatch('message', { data: value } as MessageEvent);
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

function envelope(
  type: string,
  sequence: number,
  data: unknown,
  delivery?: { streamId: string; deliverySequence: number },
) {
  const normalizedData = type === 'status' && typeof data === 'object' && data !== null
    ? {
        validity: 'valid',
        transportAlive: true,
        marketActive: true,
        synchronized: true,
        frozen: false,
        ...data,
      }
    : data;
  return JSON.stringify({
    type,
    schemaVersion: 1,
    exchange: 'binance',
    symbol: 'BTCUSDT',
    serverTimestamp: 1_700_000_000_000 + sequence,
    exchangeTimestamp: 1_700_000_000_000 + sequence,
    sequence,
    ...delivery,
    data: normalizedData,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WebSocketMarketDataClient', () => {
  it('does not infer delivery gaps from global sequence jumps caused by control or REST traffic', () => {
    let clock = 10_000;
    const socket = new FakeSocket();
    const events: MarketDataEvent[] = [];
    const client = new WebSocketMarketDataClient({
      createSocket: () => socket as unknown as WebSocket,
      now: () => clock,
      reconnectJitter: 0,
    });
    client.subscribe((event) => events.push(event));
    client.connect();
    socket.open();

    expect(socket.sent.map((value) => JSON.parse(value) as { type: string })).toContainEqual(
      expect.objectContaining({ type: 'subscribe' }),
    );
    socket.message(envelope('snapshot', 1, {
      lastUpdateId: 1,
      bids: [[100, 2]],
      asks: [[101, 3]],
      source: 'binance',
    }));
    socket.message(envelope('status', 2, {
      state: 'live',
      source: 'binance',
      message: 'ready',
      stale: false,
      resyncCount: 0,
      lastEventTimestamp: 1_700_000_000_000,
    }));
    // Global envelope sequence is shared by REST and all sockets. These jumps
    // therefore must remain informational in this client.
    socket.message(envelope('subscribed', 9, {}));
    socket.message(envelope('snapshot', 24, {
      lastUpdateId: 24,
      bids: [[100, 2]],
      asks: [[101, 3]],
      source: 'binance',
    }));

    clock += 2_000;
    socket.message(envelope('metric', 91, { lastPrice: 100, stale: false }));
    const messages = socket.sent.map((value) => JSON.parse(value) as { type: string });
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'request_snapshot' }));
    expect(events.filter((event) => event.type === 'status').at(-1)).toMatchObject({
      state: 'live',
      stale: false,
    });
    client.disconnect();
  });

  it('detects a client delivery gap but waits for reconciled status after a snapshot', () => {
    let clock = 10_000;
    const socket = new FakeSocket();
    const events: MarketDataEvent[] = [];
    const client = new WebSocketMarketDataClient({
      createSocket: () => socket as unknown as WebSocket,
      now: () => clock,
      reconnectJitter: 0,
    });
    client.subscribe((event) => events.push(event));
    client.connect();
    socket.open();

    const streamId = 'client-stream-a';
    socket.message(envelope('snapshot', 9, {
      lastUpdateId: 9,
      bids: [[100, 2]],
      asks: [[101, 3]],
      source: 'binance',
    }, { streamId, deliverySequence: 1 }));
    socket.message(envelope('status', 10, {
      state: 'live',
      source: 'binance',
      message: 'ready',
      stale: false,
      resyncCount: 0,
      lastEventTimestamp: 1_700_000_000_000,
    }, { streamId, deliverySequence: 2 }));

    clock += 2_000;
    socket.message(envelope('metric', 14, {
      lastPrice: 100,
      stale: false,
    }, { streamId, deliverySequence: 4 }));

    expect(socket.sent.map((value) => JSON.parse(value) as { type: string })).toContainEqual(
      expect.objectContaining({ type: 'request_snapshot' }),
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: 'status',
      state: 'syncing',
      stale: true,
      resyncCount: 1,
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'metric',
      sequence: 14,
    }));

    socket.message(envelope('snapshot', 15, {
      lastUpdateId: 15,
      bids: [[100, 4]],
      asks: [[101, 5]],
      source: 'binance',
    }, { streamId, deliverySequence: 5 }));

    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'status',
      state: 'live',
      message: 'Order book snapshot restored',
    }));
    expect(client.isStale).toBe(true);

    socket.message(envelope('status', 16, {
      state: 'live',
      source: 'binance',
      message: 'Snapshot reconciled',
      stale: false,
      resyncCount: 1,
      lastEventTimestamp: 1_700_000_000_016,
    }, { streamId, deliverySequence: 6 }));
    expect(client.isStale).toBe(false);
    expect(events.filter((event) => event.type === 'status').at(-1)).toMatchObject({
      state: 'live',
      message: 'Snapshot reconciled',
      stale: false,
    });
    client.disconnect();
  });

  it('fails closed on a gapped valid status, ignores replayed delivery positions, and freezes during cooldown', () => {
    let clock = 20_000;
    const socket = new FakeSocket();
    const events: MarketDataEvent[] = [];
    const client = new WebSocketMarketDataClient({
      createSocket: () => socket as unknown as WebSocket,
      now: () => clock,
      reconnectJitter: 0,
    });
    client.subscribe((event) => events.push(event));
    client.connect();
    socket.open();

    const streamId = 'strict-stream';
    socket.message(envelope('snapshot', 1, {
      lastUpdateId: 1,
      bids: [[100, 1]],
      asks: [[101, 1]],
    }, { streamId, deliverySequence: 1 }));
    socket.message(envelope('status', 2, {
      state: 'live', source: 'binance', message: 'initial valid', stale: false,
    }, { streamId, deliverySequence: 2 }));
    expect(client.isStale).toBe(false);

    clock += 2_000;
    socket.message(envelope('status', 20, {
      state: 'live', source: 'binance', message: 'must not recover gap', stale: false,
    }, { streamId, deliverySequence: 4 }));
    expect(client.isStale).toBe(true);
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'status',
      message: 'must not recover gap',
    }));

    // Duplicate and regressing positions are ignored exactly once.
    socket.message(envelope('metric', 21, {
      lastPrice: 999, stale: false,
    }, { streamId, deliverySequence: 4 }));
    socket.message(envelope('metric', 22, {
      lastPrice: 998, stale: false,
    }, { streamId, deliverySequence: 3 }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'metric',
      lastPrice: 999,
    }));

    socket.message(envelope('snapshot', 23, {
      lastUpdateId: 23,
      bids: [[100, 2]],
      asks: [[101, 2]],
    }, { streamId, deliverySequence: 5 }));
    socket.message(envelope('status', 24, {
      state: 'live', source: 'binance', message: 'first recovery', stale: false,
    }, { streamId, deliverySequence: 6 }));
    expect(client.isStale).toBe(false);

    const requestsBeforeCooldownGap = socket.sent
      .map((value) => JSON.parse(value) as { type: string })
      .filter((message) => message.type === 'request_snapshot').length;
    clock += 100;
    socket.message(envelope('status', 30, {
      state: 'live', source: 'binance', message: 'second gap', stale: false,
    }, { streamId, deliverySequence: 8 }));
    const requestsAfterCooldownGap = socket.sent
      .map((value) => JSON.parse(value) as { type: string })
      .filter((message) => message.type === 'request_snapshot').length;
    expect(client.isStale).toBe(true);
    expect(requestsAfterCooldownGap).toBe(requestsBeforeCooldownGap);
    expect(events.filter((event) => event.type === 'status').at(-1)).toMatchObject({
      state: 'syncing',
      resyncCount: 2,
      stale: true,
    });
    client.disconnect();
  });

  it('does not accept a nominal live status with malformed safety metadata', () => {
    const socket = new FakeSocket();
    const client = new WebSocketMarketDataClient({
      createSocket: () => socket as unknown as WebSocket,
      reconnectJitter: 0,
    });
    client.connect();
    socket.open();
    socket.message(envelope('snapshot', 1, {
      lastUpdateId: 1,
      bids: [[100, 1]],
      asks: [[101, 1]],
    }, { streamId: 'malformed-stream', deliverySequence: 1 }));
    socket.message(envelope('status', 2, {
      state: 'live',
      source: 'binance',
      message: 'invalid proof',
      stale: false,
      validity: 'garbage',
      frozen: 'false',
    }, { streamId: 'malformed-stream', deliverySequence: 2 }));

    expect(client.isStale).toBe(true);
    expect(socket.sent.map((value) => JSON.parse(value) as { type: string })).toContainEqual(
      expect.objectContaining({ type: 'request_snapshot' }),
    );
    client.disconnect();
  });

  it('starts a new delivery sequence without a false gap when stream identity changes', () => {
    let clock = 10_000;
    const socket = new FakeSocket();
    const client = new WebSocketMarketDataClient({
      createSocket: () => socket as unknown as WebSocket,
      now: () => clock,
      reconnectJitter: 0,
    });
    client.connect();
    socket.open();
    socket.message(envelope('snapshot', 0, {
      lastUpdateId: 1,
      bids: [[100, 1]],
      asks: [[101, 1]],
    }, { streamId: 'old-stream', deliverySequence: 79 }));
    socket.message(envelope('status', 1, {
      state: 'live', stale: false, source: 'binance', message: 'ready',
    }, { streamId: 'old-stream', deliverySequence: 80 }));
    clock += 2_000;
    socket.message(envelope('metric', 2, {
      lastPrice: 100, stale: false,
    }, { streamId: 'new-stream', deliverySequence: 5 }));

    expect(socket.sent.map((value) => JSON.parse(value) as { type: string }))
      .not.toContainEqual(expect.objectContaining({ type: 'request_snapshot' }));
    client.disconnect();
  });

  it('marks market data stale and reconnects with exponential backoff', () => {
    vi.useFakeTimers();
    let clock = 10_000;
    const sockets: FakeSocket[] = [];
    const statuses: string[] = [];
    const client = new WebSocketMarketDataClient({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      now: () => clock,
      reconnectInitialDelayMs: 100,
      reconnectJitter: 0,
      heartbeatIntervalMs: 10_000,
      staleAfterMs: 1_000,
      closeAfterStaleMs: 20_000,
    });
    client.subscribe((event) => {
      if (event.type === 'status') statuses.push(event.state);
    });
    client.connect();
    sockets[0]?.open();
    sockets[0]?.message(envelope('snapshot', 0, {
      lastUpdateId: 1,
      bids: [[100, 1]],
      asks: [[101, 1]],
    }));
    sockets[0]?.message(envelope('status', 1, {
      state: 'live',
      source: 'binance',
      message: 'Initial book reconciled',
      stale: false,
      resyncCount: 0,
      lastEventTimestamp: clock,
    }));
    sockets[0]?.message(envelope('depth_frame', 1, {
      lastUpdateId: 1,
      bids: [[100, 1]],
      asks: [[101, 1]],
      stale: false,
    }));

    clock += 1_100;
    vi.advanceTimersByTime(500);
    expect(statuses).toContain('stale');

    sockets[0]?.close();
    vi.advanceTimersByTime(99);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    client.disconnect();
  });
});
