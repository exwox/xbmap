import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createMarketHttpServer,
  type MarketHttpServer,
} from "../httpServer.js";
import { MarketGateway } from "../marketGateway.js";
import { MarketSessionManager } from "../marketSessionManager.js";
import { DEFAULT_SYMBOL } from "../types.js";

interface WireEnvelope {
  type: string;
  symbol?: string;
  data?: Record<string, unknown>;
}

/** Minimal queued WebSocket client for deterministic server assertions. */
interface WaiterEntry {
  predicate: (envelope: WireEnvelope) => boolean;
  resolve: (envelope: WireEnvelope) => void;
  timer: NodeJS.Timeout;
}

class WsTestClient {
  readonly socket: WebSocket;
  private readonly queue: WireEnvelope[] = [];
  private readonly waiters: WaiterEntry[] = [];

  constructor(readonly id: string, port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket.on("message", (raw) => {
      const envelope = JSON.parse(String(raw)) as WireEnvelope;
      if (process.env.XBMAP_DEBUG_WS) {
        console.info(`[ws:${this.id}] <- ${envelope.type} ${envelope.symbol ?? ""}`);
      }
      this.dispatch(envelope);
    });
  }

  static open(id: string, port: number): Promise<WsTestClient> {
    const client = new WsTestClient(id, port);
    return new Promise((resolve, reject) => {
      client.socket.once("open", () => resolve(client));
      client.socket.once("error", reject);
    });
  }

  send(payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(payload));
  }

  /** Resolves the next envelope matching `predicate`, buffering the rest. */
  waitFor(predicate: (envelope: WireEnvelope) => boolean, timeoutMs = 3_000): Promise<WireEnvelope> {
    const buffered = this.queue.findIndex(predicate);
    if (buffered >= 0) return Promise.resolve(this.queue.splice(buffered, 1)[0]!);
    return new Promise((resolve, reject) => {
      const entry: WaiterEntry = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(entry);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`${this.id}: timed out waiting for envelope`));
        }, timeoutMs),
      };
      this.waiters.push(entry);
      // Replay anything buffered while no waiter was registered.
      const pending = this.queue.splice(0, this.queue.length);
      for (const envelope of pending) this.dispatch(envelope);
    });
  }

  async settle(ms = 80): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    this.queue.length = 0;
  }

  close(): void {
    this.socket.close();
  }

  private dispatch(envelope: WireEnvelope): void {
    const waiter = this.waiters[0];
    if (!waiter) {
      this.queue.push(envelope);
      return;
    }
    if (waiter.predicate(envelope)) {
      clearTimeout(waiter.timer);
      this.waiters.shift();
      waiter.resolve(envelope);
      return;
    }
    this.queue.push(envelope);
  }
}

function buildMultiSymbolService(
  options: { maxSubscriptionsPerClient?: number } = {},
): MarketHttpServer {
  const sessions = new MarketSessionManager({
    maxSessions: 3,
    idleTtlMs: 60_000,
    createGateway: (symbol, tickSize) =>
      new MarketGateway({ symbol, tickSize, forceDemo: true }),
  });
  return createMarketHttpServer(new MarketGateway({ forceDemo: true }), null, undefined, {
    sessions,
    ...options,
  });
}

async function listen(service: MarketHttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", resolve);
  });
  const address = service.server.address();
  if (typeof address === "object" && address) return address.port;
  throw new Error("listener did not bind a port");
}

function emitBook(gateway: MarketGateway, basePrice: number, lastUpdateId: number): void {
  const demo = (gateway as unknown as { demo: EventEmitter }).demo;
  const level = (price: number): [number, number] => [price, 1.5];
  demo.emit("snapshot", {
    lastUpdateId,
    exchangeTimestamp: Date.now(),
    bids: [level(basePrice - 0.5)],
    asks: [level(basePrice + 0.5)],
  });
  demo.emit("depth", {
    exchangeTimestamp: Date.now(),
    receivedTimestamp: Date.now(),
    sequenceStart: lastUpdateId + 1,
    sequenceEnd: lastUpdateId + 2,
    previousSequence: lastUpdateId,
    bids: [level(basePrice - 1)],
    asks: [level(basePrice + 1)],
  });
}

describe("phase 4 multi-symbol isolation", () => {
  let service: MarketHttpServer | null = null;
  const opened: WsTestClient[] = [];

  async function started(options: { maxSubscriptionsPerClient?: number } = {}) {
    service = buildMultiSymbolService(options);
    const port = await listen(service);
    return { port };
  }

  function track(client: WsTestClient): WsTestClient {
    opened.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of opened) client.close();
    opened.length = 0;
    await service?.close();
    service = null;
  });

  it("routes every frame strictly to clients subscribed to that symbol", async () => {
    const { port } = await started();
    const ethClient = track(await WsTestClient.open("eth", port));
    const solClient = track(await WsTestClient.open("sol", port));

    ethClient.send({ type: "subscribe", exchange: "binance", symbol: "ETHUSDT", depth: 20 });
    solClient.send({ type: "subscribe", exchange: "binance", symbol: "SOLUSDT", depth: 20 });
    await ethClient.waitFor((envelope) => envelope.type === "subscribed");
    await solClient.waitFor((envelope) => envelope.type === "subscribed");
    await ethClient.settle();
    await solClient.settle();

    const ethSession = service!.sessions.get("ETHUSDT");
    const solSession = service!.sessions.get("SOLUSDT");
    expect(ethSession).not.toBeNull();
    expect(solSession).not.toBeNull();
    expect(ethSession!.tickSize).toBe(0.01);

    // Frames emitted by the ETH session reach only the ETH subscriber.
    emitBook(ethSession!, 3_000, 10);
    const ethFrame = await ethClient.waitFor((envelope) => envelope.type === "depth_frame");
    expect(ethFrame.symbol).toBe("ETHUSDT");

    // And vice versa: SOL-tagged frames never leak into the ETH stream.
    emitBook(solSession!, 150, 20);
    const solFrame = await solClient.waitFor((envelope) => envelope.type === "depth_frame");
    expect(solFrame.symbol).toBe("SOLUSDT");
    const ethStray = ethClient.waitFor((envelope) => envelope.symbol === "SOLUSDT", 400);
    await expect(ethStray).rejects.toThrow(/timed out/);
  });

  it("drops the old market completely when a client switches symbols", async () => {
    const { port } = await started();
    const client = track(await WsTestClient.open("switcher", port));

    client.send({ type: "subscribe", exchange: "binance", symbol: DEFAULT_SYMBOL, depth: 20 });
    await client.waitFor((envelope) =>
      envelope.type === "subscribed" && envelope.symbol === DEFAULT_SYMBOL);
    await client.settle();

    client.send({ type: "unsubscribe", exchange: "binance", symbol: DEFAULT_SYMBOL });
    client.send({ type: "subscribe", exchange: "binance", symbol: "ETHUSDT", depth: 20 });
    await client.waitFor((envelope) =>
      envelope.type === "unsubscribed" && envelope.symbol === DEFAULT_SYMBOL);
    await client.waitFor((envelope) =>
      envelope.type === "subscribed" && envelope.symbol === "ETHUSDT");
    await client.settle();

    // After the switch, old-symbol frames must not reach the connection.
    const btcSession = service!.sessions.get(DEFAULT_SYMBOL);
    emitBook(btcSession!, 60_000, 30);
    const staleBtc = client.waitFor((envelope) => envelope.symbol === DEFAULT_SYMBOL, 400);
    await expect(staleBtc).rejects.toThrow(/timed out/);

    const ethSession = service!.sessions.get("ETHUSDT")!;
    emitBook(ethSession, 3_000, 40);
    const freshFrame = await client.waitFor((envelope) => envelope.type === "depth_frame");
    expect(freshFrame.symbol).toBe("ETHUSDT");

    // The abandoned BTC session lost its last reference.
    const btcStatus = service!.sessions.list().find((entry) => entry.symbol === DEFAULT_SYMBOL);
    expect(btcStatus?.refCount ?? 0).toBe(0);
  });

  it("enforces the per-client subscription cap without leaking references", async () => {
    const { port } = await started({ maxSubscriptionsPerClient: 2 });
    const client = track(await WsTestClient.open("capped", port));

    client.send({ type: "subscribe", exchange: "binance", symbol: "BTCUSDT", depth: 10 });
    client.send({ type: "subscribe", exchange: "binance", symbol: "ETHUSDT", depth: 10 });
    await client.waitFor((envelope) => envelope.type === "subscribed" && envelope.symbol === "ETHUSDT");

    client.send({ type: "subscribe", exchange: "binance", symbol: "SOLUSDT", depth: 10 });
    const rejected = await client.waitFor((envelope) => envelope.type === "error");
    expect(rejected.data).toMatchObject({ code: "SUBSCRIPTION_LIMIT" });

    // Rejected acquire was released again: no dangling reference on SOLUSDT.
    const solStatus = service!.sessions.list().find((entry) => entry.symbol === "SOLUSDT");
    expect(solStatus?.refCount ?? 0).toBe(0);

    // Existing subscriptions still deliver after the rejection.
    const ethSession = service!.sessions.get("ETHUSDT")!;
    emitBook(ethSession, 3_000, 50);
    const frame = await client.waitFor(
      (envelope) => envelope.type === "depth_frame" && envelope.symbol === "ETHUSDT",
    );
    expect(frame.symbol).toBe("ETHUSDT");
  });

  it("releases every symbol reference when the socket disconnects", async () => {
    const { port } = await started();
    const client = track(await WsTestClient.open("leaver", port));
    client.send({ type: "subscribe", exchange: "binance", symbol: "ETHUSDT", depth: 10 });
    client.send({ type: "subscribe", exchange: "binance", symbol: "SOLUSDT", depth: 10 });
    await client.waitFor((envelope) => envelope.type === "subscribed" && envelope.symbol === "SOLUSDT");

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const status of service!.sessions.list()) {
      expect(status.refCount).toBe(0);
    }
  });

  it("exposes the registry over REST and serves snapshots per symbol", { timeout: 20_000 }, async () => {
    const { port } = await started();
    const base = `http://127.0.0.1:${port}`;

    const markets = await fetch(`${base}/api/v1/markets`);
    expect(markets.status).toBe(200);
    const marketPayload = (await markets.json()) as { markets: Array<Record<string, unknown>> };
    expect(marketPayload.markets.map((market) => market.symbol)).toEqual([
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
    ]);
    const ethEntry = marketPayload.markets.find((market) => market.symbol === "ETHUSDT");
    expect(ethEntry).toMatchObject({ tickSize: 0.01, active: false });

    const inactive = await fetch(`${base}/api/v1/snapshot?symbol=SOLUSDT`);
    expect(inactive.status).toBe(409);
    expect(await inactive.json()).toMatchObject({ error: { code: "SYMBOL_NOT_ACTIVE" } });

    const unknownMarket = await fetch(`${base}/api/v1/snapshot?symbol=DOGEUSDT`);
    expect(unknownMarket.status).toBe(404);
    expect(await unknownMarket.json()).toMatchObject({ error: { code: "UNSUPPORTED_MARKET" } });

    // Activating a session through /ws makes its REST surface available.
    const client = track(await WsTestClient.open("rest", port));
    client.send({ type: "subscribe", exchange: "binance", symbol: "ETHUSDT", depth: 20 });
    await client.waitFor((envelope) => envelope.type === "subscribed");
    const ethSession = service!.sessions.get("ETHUSDT")!;
    emitBook(ethSession, 3_000, 60);

    let snapshotStatus = 0;
    let snapshotPayload: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${base}/api/v1/snapshot?symbol=ETHUSDT&depth=10`);
      snapshotStatus = response.status;
      snapshotPayload = (await response.json()) as Record<string, unknown>;
      if (snapshotStatus === 200 && snapshotPayload.valid === true) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(snapshotStatus).toBe(200);
    expect(snapshotPayload).toMatchObject({ symbol: "ETHUSDT" });
    const frameData = snapshotPayload.data as Record<string, unknown> | undefined;
    expect(frameData).toMatchObject({ valid: true, frozen: false });
  });
});
