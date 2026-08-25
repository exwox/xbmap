import { describe, expect, it, vi } from "vitest";
import {
  BinanceLiquidationStream,
  type LiquidationEvent,
  type LiquidationSocketHandle,
} from "../feeds/binanceLiquidations.js";

interface FakeSocketHarness {
  socket: LiquidationSocketHandle;
  handlers: {
    onOpen(): void;
    onMessage(raw: unknown): void;
    onError(error: unknown): void;
  };
}

function frame(symbol: string, side: "SELL" | "BUY", price: number, qty: number, ts: number): string {
  return JSON.stringify({
    stream: "!forceOrder@arr",
    data: { e: "forceOrder", o: { s: symbol, S: side, q: String(qty), p: String(price), T: ts } },
  });
}

describe("binance liquidation stream", () => {
  it("parses combined-stream force orders into liquidated-position events", () => {
    const long = BinanceLiquidationStream.parseForceOrder(
      frame("BTCUSDT", "SELL", 60_000, 1.5, 1_700),
    );
    expect(long).toEqual({
      symbol: "BTCUSDT",
      liquidatedSide: "long",
      price: 60_000,
      quantity: 1.5,
      timestamp: 1_700,
    });

    const short = BinanceLiquidationStream.parseForceOrder(
      frame("ETHUSDT", "BUY", 3_100, 12, 1_800),
    );
    expect(short?.liquidatedSide).toBe("short");
  });

  it("returns null for malformed or non-force-order frames", () => {
    expect(BinanceLiquidationStream.parseForceOrder("not json")).toBeNull();
    expect(BinanceLiquidationStream.parseForceOrder({ data: { e: "kline" } })).toBeNull();
    expect(BinanceLiquidationStream.parseForceOrder(
      JSON.stringify({ data: { e: "forceOrder", o: { s: "BTCUSDT", S: "SIDEWAYS", q: "1", p: "1" } } }),
    )).toBeNull();
    expect(BinanceLiquidationStream.parseForceOrder(
      JSON.stringify({ data: { e: "forceOrder", o: { s: "BTCUSDT", S: "SELL", q: "x", p: "1" } } }),
    )).toBeNull();
  });

  it("filters by configured symbols and forwards matching events to the sink", () => {
    let harness: FakeSocketHarness | null = null;
    const closed = vi.fn();
    const stream = new BinanceLiquidationStream({
      symbols: ["BTCUSDT"],
      open: (_url, handlers) => {
        harness = { handlers, socket: { close: closed } };
        return harness.socket;
      },
    });

    const sink = vi.fn((event: LiquidationEvent) => event);
    stream.start(sink);

    harness!.handlers.onMessage(frame("ETHUSDT", "SELL", 3_000, 5, 1)); // filtered out
    harness!.handlers.onMessage(frame("BTCUSDT", "BUY", 60_000, 0.4, 2)); // forwarded
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      symbol: "BTCUSDT",
      liquidatedSide: "short",
      quantity: 0.4,
    });

    stream.stop();
    expect(closed).toHaveBeenCalledTimes(1);
    // Events after stop are ignored.
    harness!.handlers.onMessage(frame("BTCUSDT", "SELL", 61_000, 1, 3));
    expect(sink).toHaveBeenCalledTimes(1);
  });
});