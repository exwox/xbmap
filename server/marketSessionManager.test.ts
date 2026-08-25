import { describe, expect, it, vi } from "vitest";
import { MarketGateway } from "./marketGateway.js";
import {
  MarketSessionManager,
  SessionCapacityError,
  UnknownSymbolError,
} from "./marketSessionManager.js";

function demoFactory() {
  const created: MarketGateway[] = [];
  return {
    created,
    create: (symbol: string, tickSize: number) => {
      const gateway = new MarketGateway({ symbol, tickSize, forceDemo: true });
      created.push(gateway);
      return gateway;
    },
  };
}

describe("market session manager", () => {
  it("lazily creates isolated gateways per symbol with registry tick sizes", () => {
    const factory = demoFactory();
    const manager = new MarketSessionManager({
      createGateway: factory.create,
      idleTtlMs: 60_000,
    });
    const btc = manager.acquire("BTCUSDT");
    const eth = manager.acquire("ethusdt");

    expect(factory.created).toHaveLength(2);
    expect(btc).not.toBe(eth);
    expect(btc.symbol).toBe("BTCUSDT");
    expect(btc.tickSize).toBe(0.1);
    expect(eth.symbol).toBe("ETHUSDT");
    expect(eth.tickSize).toBe(0.01);
    // Re-acquire returns the same instance (no duplicate sessions).
    expect(manager.acquire("BTCUSDT")).toBe(btc);
    expect(factory.created).toHaveLength(2);
    expect(manager.list()).toEqual([
      { symbol: "BTCUSDT", refCount: 2, running: true, evictAtMs: null },
      { symbol: "ETHUSDT", refCount: 1, running: true, evictAtMs: null },
    ]);
    manager.stopAll();
  });

  it("evicts an idle symbol after the TTL and restarts on re-acquire", async () => {
    vi.useFakeTimers();
    try {
      const factory = demoFactory();
      const manager = new MarketSessionManager({
        createGateway: factory.create,
        idleTtlMs: 50,
      });
      const gateway = manager.acquire("SOLUSDT");
      manager.release("SOLUSDT");
      expect(manager.has("SOLUSDT")).toBe(true);

      vi.advanceTimersByTime(60);
      expect(manager.has("SOLUSDT")).toBe(false);
      // Eviction destroyed the session; re-acquire builds a fresh gateway
      // through the restart-safe create+start path.
      const again = manager.acquire("SOLUSDT");
      expect(again).not.toBe(gateway);
      expect(again.symbol).toBe("SOLUSDT");
      expect(again.source).toBe("demo");
      manager.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending eviction when a client re-acquires in time", () => {
    vi.useFakeTimers();
    try {
      const manager = new MarketSessionManager({
        createGateway: demoFactory().create,
        idleTtlMs: 50,
      });
      manager.acquire("ETHUSDT");
      manager.release("ETHUSDT");
      vi.advanceTimersByTime(30);
      manager.acquire("ETHUSDT");
      vi.advanceTimersByTime(60);
      expect(manager.has("ETHUSDT")).toBe(true);
      manager.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unknown symbols and enforces session capacity", () => {
    const factory = demoFactory();
    const manager = new MarketSessionManager({
      createGateway: factory.create,
      maxSessions: 2,
      idleTtlMs: 60_000,
    });
    expect(() => manager.acquire("DOGEUSDT")).toThrow(UnknownSymbolError);
    manager.acquire("BTCUSDT");
    manager.acquire("ETHUSDT");
    expect(() => manager.acquire("SOLUSDT")).toThrow(SessionCapacityError);
    manager.release("ETHUSDT");
    manager.evict("ETHUSDT");
    expect(() => manager.acquire("SOLUSDT")).not.toThrow();
    manager.stopAll();
  });
});
