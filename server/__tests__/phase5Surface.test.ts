import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createMarketHttpServer, type MarketHttpServer } from "../httpServer.js";
import { MarketGateway } from "../marketGateway.js";
import { MarketSessionManager } from "../marketSessionManager.js";

interface WireEnvelope {
  type: string;
  symbol?: string;
  data?: Record<string, unknown>;
}

class WsClient {
  readonly socket: WebSocket;
  private readonly queue: WireEnvelope[] = [];
  private readonly waiters: Array<{
    predicate: (envelope: WireEnvelope) => boolean;
    resolve: (envelope: WireEnvelope) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(readonly id: string, port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket.on("message", (raw) => {
      const envelope = JSON.parse(String(raw)) as WireEnvelope;
      const waiter = this.waiters[0];
      if (!waiter) {
        this.queue.push(envelope);
        return;
      }
      if (waiter.predicate(envelope)) {
        clearTimeout(waiter.timer);
        this.waiters.shift();
        waiter.resolve(envelope);
      } else {
        this.queue.push(envelope);
      }
    });
  }

  static open(id: string, port: number): Promise<WsClient> {
    const client = new WsClient(id, port);
    return new Promise((resolve, reject) => {
      client.socket.once("open", () => resolve(client));
      client.socket.once("error", reject);
    });
  }

  send(payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(payload));
  }

  waitFor(predicate: (envelope: WireEnvelope) => boolean, timeoutMs = 5_000): Promise<WireEnvelope> {
    const buffered = this.queue.findIndex(predicate);
    if (buffered >= 0) return Promise.resolve(this.queue.splice(buffered, 1)[0]!);
    return new Promise((resolve, reject) => {
      const entry: {
        predicate: (envelope: WireEnvelope) => boolean;
        resolve: (envelope: WireEnvelope) => void;
        timer: NodeJS.Timeout;
      } = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(entry);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("timed out waiting for envelope"));
        }, timeoutMs),
      };
      this.waiters.push(entry);
    });
  }

  async settle(ms = 80): Promise<void> {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
    this.queue.length = 0;
  }

  close(): void {
    this.socket.close();
  }
}

function buildService(): MarketHttpServer {
  const sessions = new MarketSessionManager({
    maxSessions: 3,
    idleTtlMs: 60_000,
    createGateway: (symbol, tickSize) =>
      new MarketGateway({ symbol, tickSize, forceDemo: true }),
  });
  return createMarketHttpServer(new MarketGateway({ forceDemo: true }), null, undefined, {
    sessions,
  });
}

async function listen(service: MarketHttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", resolve);
  });
  const address = service.server.address();
  if (typeof address === "object" && address) return address.port;
  throw new Error("listener did not bind");
}

// PHASE5_SURFACE_TESTS

describe("phase 5 ws/rest surface", () => {
  let service: MarketHttpServer | null = null;
  const opened: WsClient[] = [];

  afterEach(async () => {
    for (const client of opened) client.close();
    opened.length = 0;
    await service?.close();
    service = null;
  });

  async function started(): Promise<number> {
    service = buildService();
    return listen(service);
  }

  async function connect(port: number): Promise<WsClient> {
    const client = await WsClient.open(`ws-${opened.length}`, port);
    opened.push(client);
    return client;
  }

  it("streams insight frames to subscribed clients", async () => {
    const port = await started();
    const client = await connect(port);
    client.send({ type: "subscribe", exchange: "binance", symbol: "ETHUSDT", depth: 10 });
    const insight = await client.waitFor((envelope) => envelope.type === "insight");
    expect(insight.symbol).toBe("ETHUSDT");
    expect(insight.data).toMatchObject({ algoVersion: "insights-v1" });
  });

  it("delivers a liquidity-wall alert end to end with an audit trail", async () => {
    const port = await started();
    const base = `http://127.0.0.1:${port}`;
    const client = await connect(port);
    client.send({ type: "subscribe", exchange: "binance", symbol: "ETHUSDT", depth: 10 });
    await client.waitFor((envelope) => envelope.type === "subscribed");

    const created = await fetch(`${base}/api/v1/alerts/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "liquidity_wall",
        symbol: "ETHUSDT",
        thresholdMode: "baseline",
        multiplier: 4,
        wallState: "appeared",
        cooldownMs: 5_000,
      }),
    });
    expect(created.status).toBe(201);

    // Drive the ETH demo book so a qualifying bid wall appears and persists
    // (median qty 1 → threshold 6; our level is 10).
    const ethSession = service!.sessions.get("ETHUSDT")!;
    const demo = (ethSession as unknown as { demo: EventEmitter }).demo;
    const startTs = Date.now();
    for (const offset of [0, 800, 1_700]) {
      demo.emit("snapshot", {
        lastUpdateId: startTs + offset,
        exchangeTimestamp: startTs + offset,
        bids: [[3_000, 10], [2_999, 1]],
        asks: [[3_001, 1], [3_002, 1]],
      });
    }

    const alert = await client.waitFor(
      (envelope) => envelope.type === "alert",
      8_000,
    );
    expect(alert.data).toMatchObject({ kind: "liquidity_wall", symbol: "ETHUSDT" });
    expect(String(alert.data?.reason)).toContain("appeared");

    const events = await fetch(`${base}/api/v1/alerts/events?limit=50`);
    const payload = (await events.json()) as { events: Array<{ kind: string }> };
    expect(payload.events.map((entry) => entry.kind)).toContain("triggered");
    expect(payload.events.map((entry) => entry.kind)).toContain("delivered");
    client.close();
  });

  it("validates alert rule CRUD over REST", async () => {
    const port = await started();
    const base = `http://127.0.0.1:${port}`;

    const invalid = await fetch(`${base}/api/v1/alerts/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "nonsense", symbol: "*" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_ALERT_RULE" } });

    const createdResponse = await fetch(`${base}/api/v1/alerts/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "trend_score", symbol: "*", thresholdMode: "absolute",
        absoluteValue: 70, op: "above", cooldownMs: 30_000,
      }),
    });
    expect(createdResponse.status).toBe(201);
    const { rule } = (await createdResponse.json()) as { rule: { id: string } };

    const patched = await fetch(`${base}/api/v1/alerts/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { rule: { enabled: boolean } }).rule.enabled).toBe(false);

    const deleted = await fetch(`${base}/api/v1/alerts/rules/${rule.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const repeat = await fetch(`${base}/api/v1/alerts/rules/${rule.id}`, { method: "DELETE" });
    expect(repeat.status).toBe(404);

    const missingPatch = await fetch(`${base}/api/v1/alerts/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(missingPatch.status).toBe(404);
  });
});
