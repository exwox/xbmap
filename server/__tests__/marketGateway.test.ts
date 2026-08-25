import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { OrderBook } from "../core/orderBook.js";
import type { BinanceReconciliation } from "../feeds/binanceFeed.js";
import { MarketGateway } from "../marketGateway.js";
import type { DepthSnapshot, DepthUpdate, ServerEnvelope, StatusFrame } from "../types.js";

describe("MarketGateway data validity", () => {
  it("commits a staged Binance reconciliation once and never exposes partial state", () => {
    const gateway = new MarketGateway();
    const feed = internalFeed(gateway);
    const events: ServerEnvelope[] = [];
    gateway.on("event", (event) => events.push(event));

    feed.emit("status", status("syncing", "binance-1"));
    expect(gateway.dataQuality).toMatchObject({
      validity: "syncing",
      synchronized: false,
      frozen: true,
    });

    const snapshot = bookSnapshot();
    const checkpointBook = new OrderBook(0.1);
    checkpointBook.loadSnapshot(snapshot);
    feed.emit("reconciled", {
      snapshot,
      checkpoint: checkpointBook.checkpoint(),
      appliedUpdateCount: 0,
      reconciledAt: 1_005,
    } satisfies BinanceReconciliation);
    feed.emit("depth", depthUpdate());

    expect(events.filter((event) => event.type === "snapshot")).toHaveLength(0);
    expect((gateway.getSnapshot().data as { valid: boolean }).valid).toBe(false);

    feed.emit("status", status("live", "binance-1"));
    const snapshots = events.filter((event) => event.type === "snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.data).toMatchObject({
      lastUpdateId: 11,
      bids: [[100, 2]],
      valid: true,
      frozen: false,
      sessionId: "binance-1",
    });
    expect(gateway.dataQuality).toMatchObject({
      sessionId: "binance-1",
      validity: "valid",
      synchronized: true,
      frozen: false,
    });

    feed.emit("status", status("syncing", "binance-2"));
    const invalidSnapshot = gateway.getSnapshot().data as {
      valid: boolean;
      bids: unknown[];
      checkpoint: unknown;
    };
    expect(invalidSnapshot).toMatchObject({ valid: false, bids: [], checkpoint: null });
    expect(gateway.dataQuality).toMatchObject({
      sessionId: "binance-2",
      validity: "syncing",
      synchronized: false,
      frozen: true,
      lastValidAt: null,
    });
    expect(events.some((event) =>
      event.type === "trend_signal" &&
      (event.data as { active?: boolean }).active === false)).toBe(true);
  });

  it("publishes valid checkpoints in demo mode and closes explicitly", async () => {
    const gateway = new MarketGateway({ forceDemo: true });
    const events: ServerEnvelope[] = [];
    gateway.on("event", (event) => events.push(event));
    gateway.start();

    expect(gateway.isMarketDataValid).toBe(true);
    expect(gateway.status).toMatchObject({
      state: "demo",
      validity: "valid",
      synchronized: true,
      frozen: false,
    });
    expect(gateway.dataQuality.checkpoint?.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    await gateway.shutdown();
    expect(gateway.isMarketDataValid).toBe(false);
    expect(gateway.status).toMatchObject({
      state: "closed",
      validity: "closed",
      synchronized: false,
      frozen: true,
    });
    expect(events.at(-1)?.type).toBe("status");
  });
});

function internalFeed(gateway: MarketGateway): EventEmitter {
  return (gateway as unknown as { binance: EventEmitter }).binance;
}

function bookSnapshot(): DepthSnapshot {
  return {
    lastUpdateId: 10,
    exchangeTimestamp: 1_000,
    bids: [[100, 1]],
    asks: [[100.1, 1]],
  };
}

function depthUpdate(): DepthUpdate {
  return {
    exchangeTimestamp: 1_010,
    receivedTimestamp: 1_012,
    sequenceStart: 11,
    sequenceEnd: 11,
    previousSequence: 10,
    bids: [[100, 2]],
    asks: [],
  };
}

function status(state: "syncing" | "live", sessionId: string): StatusFrame {
  return {
    state,
    source: "binance",
    message: state === "live" ? "Synchronized" : "Synchronizing",
    stale: state !== "live",
    resyncCount: 0,
    lastEventTimestamp: 1_012,
    sessionId,
    transportAlive: state === "live",
  };
}
