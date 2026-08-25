import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import {
  BinanceFeed,
  buildBinanceStreamUrls,
  type BinanceRawEvent,
  type BinanceReconciliation,
} from "../feeds/binanceFeed.js";
import type { DepthSnapshot, StatusFrame } from "../types.js";

describe("BinanceFeed reliability", () => {
  it("builds the officially routed depth and trade websocket paths", () => {
    expect(buildBinanceStreamUrls("wss://fstream.binance.com/", "BTCUSDT")).toEqual({
      depth: "wss://fstream.binance.com/public/ws/btcusdt@depth@100ms",
      trade: "wss://fstream.binance.com/market/ws/btcusdt@aggTrade",
    });
  });

  it("publishes one atomic reconciled book after buffered continuity is proven", async () => {
    const snapshot = deferred<DepthSnapshot>();
    const harness = feedHarness({ snapshotFetcher: () => snapshot.promise });
    const reconciliations: BinanceReconciliation[] = [];
    const snapshots: DepthSnapshot[] = [];
    const statuses: StatusFrame[] = [];
    const rawEvents: BinanceRawEvent[] = [];
    harness.feed.on("reconciled", (value) => reconciliations.push(value));
    harness.feed.on("snapshot", (value) => snapshots.push(value));
    harness.feed.on("status", (value) => statuses.push(value));
    harness.feed.on("raw", (value) => rawEvents.push(value));

    harness.feed.start();
    expect(harness.urls).toEqual([
      "wss://test.invalid/public/ws/btcusdt@depth@100ms",
      "wss://test.invalid/market/ws/btcusdt@aggTrade",
    ]);
    const [depth, trade] = harness.sockets;
    depth!.open();
    trade!.open();
    const rawDepth = JSON.stringify(depthPayload({ U: 10, u: 11, pu: 9, b: [["100", "2"]] }));
    depth!.message(rawDepth);
    expect(snapshots).toHaveLength(0);

    snapshot.resolve(bookSnapshot());
    await eventually(() => statuses.some((status) => status.state === "live"));

    expect(reconciliations).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      lastUpdateId: 11,
      bids: [[100, 2]],
      asks: [[101, 1]],
    });
    expect(reconciliations[0]!.checkpoint).toMatchObject({
      lastUpdateId: 11,
      bestBid: 100,
      bestAsk: 101,
    });
    expect(rawEvents.map((event) => event.stream)).toEqual(["depth", "snapshot"]);
    expect(rawEvents[0]!.payload).toBe(rawDepth);
    expect(rawEvents[0]!.connectionId).toBe(rawEvents[1]!.connectionId);
    harness.feed.stop();
  });

  it("counts duplicate, out-of-order, malformed and gap events then resyncs", async () => {
    const harness = feedHarness({ snapshotFetcher: async () => bookSnapshot() });
    harness.feed.start();
    const [depth, trade] = harness.sockets;
    depth!.open();
    trade!.open();
    depth!.message(JSON.stringify(depthPayload({ U: 10, u: 11, pu: 9 })));
    await eventually(() => harness.feed.diagnostics.marketActive);

    depth!.message(JSON.stringify(depthPayload({ U: 11, u: 11, pu: 10 })));
    depth!.message(JSON.stringify(depthPayload({ U: 9, u: 10, pu: 8 })));
    depth!.message("{not-json");
    depth!.message(JSON.stringify(depthPayload({ U: 13, u: 13, pu: 12 })));

    const counters = harness.feed.diagnostics.counters;
    expect(counters).toMatchObject({
      duplicates: 1,
      outOfOrder: 1,
      malformedEvents: 1,
      sequenceGaps: 1,
      resyncs: 1,
    });
    expect(harness.feed.diagnostics.synchronizing).toBe(false);
    harness.feed.stop();
  });

  it("discards a snapshot that resolves after its transport generation closed", async () => {
    const snapshot = deferred<DepthSnapshot>();
    const harness = feedHarness({ snapshotFetcher: () => snapshot.promise });
    const published: DepthSnapshot[] = [];
    harness.feed.on("snapshot", (value) => published.push(value));
    harness.feed.start();
    const [depth, trade] = harness.sockets;
    depth!.open();
    trade!.open();
    depth!.message(JSON.stringify(depthPayload({ U: 10, u: 11, pu: 9 })));
    depth!.remoteClose();
    snapshot.resolve(bookSnapshot());
    await flushTasks();

    expect(published).toHaveLength(0);
    expect(harness.feed.diagnostics.counters.resyncs).toBe(1);
    expect(harness.feed.diagnostics.marketActive).toBe(false);
    harness.feed.stop();
  });

  it("bounds the pre-snapshot queue and records overflow before reconnect", () => {
    const snapshot = deferred<DepthSnapshot>();
    const harness = feedHarness({
      snapshotFetcher: () => snapshot.promise,
      maxBufferedDepth: 1,
    });
    harness.feed.start();
    const [depth, trade] = harness.sockets;
    depth!.open();
    trade!.open();
    depth!.message(JSON.stringify(depthPayload({ U: 10, u: 11, pu: 9 })));
    depth!.message(JSON.stringify(depthPayload({ U: 11, u: 12, pu: 11 })));

    expect(harness.feed.diagnostics.counters).toMatchObject({
      queueOverflows: 1,
      resyncs: 1,
    });
    expect(harness.feed.diagnostics.bufferedDepth).toBe(0);
    harness.feed.stop();
  });
});

function feedHarness(options: {
  snapshotFetcher: () => Promise<DepthSnapshot>;
  maxBufferedDepth?: number;
}) {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const socketFactory = (url: string, _options: ClientOptions): WebSocket => {
    urls.push(url);
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  const feed = new BinanceFeed({
    symbol: "BTCUSDT",
    tickSize: 1,
    websocketBaseUrl: "wss://test.invalid",
    snapshotFetcher: options.snapshotFetcher,
    socketFactory,
    ...(options.maxBufferedDepth ? { maxBufferedDepth: options.maxBufferedDepth } : {}),
  });
  return { feed, sockets, urls };
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  message(payload: string): void {
    this.emit("message", Buffer.from(payload) satisfies RawData);
  }

  remoteClose(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006, Buffer.alloc(0));
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006, Buffer.alloc(0));
  }

  ping(): void {}
}

function bookSnapshot(): DepthSnapshot {
  return {
    lastUpdateId: 10,
    exchangeTimestamp: Date.now() - 5,
    bids: [[100, 1]],
    asks: [[101, 1]],
  };
}

function depthPayload(overrides: Partial<Record<"U" | "u" | "pu" | "b" | "a", unknown>> = {}) {
  const now = Date.now();
  return {
    e: "depthUpdate",
    E: now,
    T: now,
    s: "BTCUSDT",
    U: 10,
    u: 11,
    pu: 9,
    b: [],
    a: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushTasks();
  }
  throw new Error("Condition did not become true");
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
