/**
 * Phase 5 real-market liquidation feed: subscribes to Binance USD-M
 * `!forceOrder@arr`, parses each forced order, and forwards the LIQUIDATED
 * POSITION side (a SELL force-order closes a LONG, and vice versa).
 *
 * The socket is injected so unit tests never touch the network and production
 * keeps a single combined-stream connection per process. Opt-in via env:
 * storing/redistributing this feed may have licensing implications.
 */

export interface LiquidationEvent {
  symbol: string;
  /** Position side that was closed: SELL force-order ⇒ long, BUY ⇒ short. */
  liquidatedSide: "long" | "short";
  price: number;
  quantity: number;
  timestamp: number;
}

export type LiquidationSink = (event: LiquidationEvent) => void;

export interface LiquidationSocketHandle {
  close(): void;
}

export interface BinanceLiquidationStreamOptions {
  /** Symbols to keep; empty array accepts every forced order. */
  symbols?: string[];
  url?: string;
  /**
   * Opens the socket and wires handlers. Production passes a thin `ws`
   * adapter from `index.ts`; tests inject an in-memory fake. Required — this
   * module never opens network sockets on its own.
   */
  open: (
    url: string,
    handlers: { onOpen(): void; onMessage(raw: unknown): void; onError(error: unknown): void },
  ) => LiquidationSocketHandle;
}

const DEFAULT_URL = "wss://fstream.binance.com/stream?streams=!forceOrder@arr";

interface ForceOrderPayload {
  stream?: unknown;
  data?: {
    e?: unknown;
    o?: {
      s?: unknown; // symbol
      S?: unknown; // force-order side: SELL closes long, BUY closes short
      q?: unknown; // original quantity
      p?: unknown; // average price
      T?: unknown; // trade time
    };
  };
}

export class BinanceLiquidationStream {
  private readonly symbols = new Set<string>();
  private readonly url: string;
  private readonly openFn: NonNullable<BinanceLiquidationStreamOptions["open"]>;
  private sink: LiquidationSink | null = null;
  private socket: LiquidationSocketHandle | null = null;
  private running = false;

  constructor(options: BinanceLiquidationStreamOptions) {
    for (const symbol of options.symbols ?? []) {
      this.symbols.add(symbol.trim().toUpperCase());
    }
    this.url = options.url ?? DEFAULT_URL;
    this.openFn = options.open;
  }

  start(sink: LiquidationSink): void {
    if (this.running) return;
    if (typeof this.openFn !== "function") {
      throw new TypeError("BinanceLiquidationStream requires an `open` socket adapter");
    }
    this.running = true;
    this.sink = sink;
    this.socket = this.openFn(this.url, {
      onOpen: () => {
        /* combined stream needs no subscription message */
      },
      onMessage: (raw) => {
        if (!this.running) return;
        const event = BinanceLiquidationStream.parseForceOrder(raw);
        if (!event) return;
        if (this.symbols.size > 0 && !this.symbols.has(event.symbol)) return;
        this.sink?.(event);
      },
      onError: () => {
        // The underlying socket retries are owned by the caller; surface via
        // silence so a dead feed simply stops producing events.
      },
    });
  }

  stop(): void {
    this.running = false;
    this.sink = null;
    this.socket?.close();
    this.socket = null;
  }

  /** Parses one combined-stream frame into a liquidation event. */
  static parseForceOrder(raw: unknown): LiquidationEvent | null {
    let parsed: ForceOrderPayload | null = null;
    try {
      parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as ForceOrderPayload;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const order = parsed.data?.o;
    if (!order || parsed.data?.e !== "forceOrder") return null;

    const symbol = typeof order.s === "string" ? order.s.toUpperCase() : "";
    if (!symbol) return null;
    const sideRaw = typeof order.S === "string" ? order.S.toUpperCase() : "";
    if (sideRaw !== "SELL" && sideRaw !== "BUY") return null;
    const price = Number(order.p);
    const quantity = Number(order.q);
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) return null;
    const timestamp = Number(order.T);

    return {
      symbol,
      liquidatedSide: sideRaw === "SELL" ? "long" : "short",
      price,
      quantity,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    };
  }
}