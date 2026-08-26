import { EventEmitter } from "node:events";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { DataQualityMonitor } from "../core/dataQuality.js";
import { OrderBook } from "../core/orderBook.js";
import type {
  BookCheckpoint,
  ClockDriftStats,
  DataQualityCounters,
  DepthSnapshot,
  DepthUpdate,
  NormalizedTrade,
  StatusFrame,
} from "../types.js";

interface BinanceDepthPayload {
  e: "depthUpdate";
  E: number;
  T?: number;
  s: string;
  U: number;
  u: number;
  pu?: number;
  b: Array<[string, string]>;
  a: Array<[string, string]>;
}

interface BinanceTradePayload {
  e: "aggTrade" | "trade";
  E: number;
  T: number;
  s: string;
  /** aggTrade aggregate id (`a`) or raw trade id (`t`). */
  a?: number;
  t?: number;
  p: string;
  q: string;
  m: boolean;
}

interface CombinedMessage {
  stream?: string;
  data?: BinanceDepthPayload | BinanceTradePayload;
}

export interface BinanceReconciliation {
  /** Buffered deltas have already been folded into this final snapshot. */
  snapshot: DepthSnapshot;
  checkpoint: BookCheckpoint;
  appliedUpdateCount: number;
  reconciledAt: number;
}

export interface BinanceRawEvent {
  receivedTimestamp: number;
  stream: "snapshot" | "depth" | "trade";
  connectionId: string;
  /** Exact UTF-8 websocket message before JSON parsing or normalization. */
  payload: string;
}

export interface BinanceFeedDiagnostics {
  running: boolean;
  synchronizing: boolean;
  transportAlive: boolean;
  marketActive: boolean;
  generation: number;
  bufferedDepth: number;
  lastMessageAt: number | null;
  counters: DataQualityCounters;
  clockDrift: ClockDriftStats;
  checkpoint: BookCheckpoint | null;
}

export type BinanceSocketFactory = (url: string, options: ClientOptions) => WebSocket;

export interface BinanceFeedOptions {
  symbol: string;
  tickSize: number;
  snapshotLimit?: number;
  restBaseUrl?: string;
  websocketBaseUrl?: string;
  /**
   * Trade stream type. Global endpoints serve `aggTrade`; regional mirrors
   * (e.g. binance.bh) expose `trade` instead.
   */
  tradeStream?: "aggTrade" | "trade";
  maxBufferedDepth?: number;
  /** Dependency seams keep reconciliation and fault tests deterministic. */
  snapshotFetcher?: () => Promise<DepthSnapshot>;
  socketFactory?: BinanceSocketFactory;
}

export interface BinanceStreamUrls {
  depth: string;
  trade: string;
}

interface FetchedSnapshot {
  snapshot: DepthSnapshot;
  rawPayload: string;
}

/** Official USD-M routing separates public depth and market trade streams. */
export function buildBinanceStreamUrls(
  websocketBaseUrl: string,
  symbol: string,
  tradeStream: "aggTrade" | "trade" = "aggTrade",
): BinanceStreamUrls {
  const base = websocketBaseUrl.replace(/\/+$/, "");
  const streamSymbol = symbol.toLowerCase();
  return {
    depth: `${base}/public/ws/${streamSymbol}@depth@100ms`,
    trade: `${base}/market/ws/${streamSymbol}@${tradeStream}`,
  };
}

/**
 * Binance USD-M adapter with independent routed sockets and atomic
 * stream -> buffer -> REST snapshot reconciliation. No partial book escapes.
 */
export class BinanceFeed extends EventEmitter {
  private depthSocket: WebSocket | null = null;
  private tradeSocket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private running = false;
  private synchronizing = false;
  private reconciliationReady = false;
  private live = false;
  private reconnectAttempts = 0;
  private connectionGeneration = 0;
  private bufferedDepth: DepthUpdate[] = [];
  private reconciliationSnapshot: DepthSnapshot | null = null;
  private reconciliationAppliedUpdates = 0;
  private reconciliationExchangeTimestamp = 0;
  private validator: OrderBook;
  private lastMessageAt = 0;
  private lastDepthMessageAt = 0;
  private lastTradeMessageAt = 0;
  private readonly quality = new DataQualityMonitor();

  readonly symbol: string;
  readonly tickSize: number;
  readonly snapshotLimit: number;
  readonly maxBufferedDepth: number;
  private readonly restBaseUrl: string;
  private readonly websocketBaseUrl: string;
  private readonly tradeStream: "aggTrade" | "trade";
  private readonly snapshotFetcher?: () => Promise<DepthSnapshot>;
  private readonly socketFactory: BinanceSocketFactory;

  constructor(options: BinanceFeedOptions) {
    super();
    this.symbol = options.symbol.toUpperCase();
    this.tickSize = options.tickSize;
    this.snapshotLimit = options.snapshotLimit ?? 1_000;
    this.maxBufferedDepth = clampInteger(options.maxBufferedDepth ?? 20_000, 1, 100_000);
    this.restBaseUrl = options.restBaseUrl ?? "https://fapi.binance.com";
    this.websocketBaseUrl = options.websocketBaseUrl ?? "wss://fstream.binance.com";
    this.tradeStream = options.tradeStream === "trade" ? "trade" : "aggTrade";
    this.snapshotFetcher = options.snapshotFetcher;
    this.socketFactory = options.socketFactory ?? ((url, clientOptions) =>
      new WebSocket(url, clientOptions));
    this.validator = new OrderBook(this.tickSize);
  }

  get resyncCount(): number {
    return this.quality.counters.resyncs;
  }

  get diagnostics(): BinanceFeedDiagnostics {
    return {
      running: this.running,
      synchronizing: this.synchronizing,
      transportAlive: this.transportAlive(),
      marketActive: this.live && this.lastMessageAt > 0 && Date.now() - this.lastMessageAt <= 25_000,
      generation: this.connectionGeneration,
      bufferedDepth: this.bufferedDepth.length,
      lastMessageAt: this.lastMessageAt || null,
      counters: this.quality.counters,
      clockDrift: this.quality.clockDrift,
      checkpoint: this.live && this.validator.isSynchronized
        ? this.validator.checkpoint()
        : null,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempts = 0;
    this.connect(false);
  }

  stop(): void {
    if (!this.running && !this.depthSocket && !this.tradeSocket) return;
    this.running = false;
    this.connectionGeneration += 1;
    this.clearTimers();
    this.terminateSockets();
    this.resetConnectionState();
  }

  requestResync(reason: string): void {
    if (!this.running) return;
    this.restart(`Order book resync: ${reason}`, true, "syncing");
  }

  private connect(isReconnect: boolean): void {
    if (!this.running) return;
    const generation = ++this.connectionGeneration;
    this.validator = new OrderBook(this.tickSize);
    this.resetConnectionState();
    this.synchronizing = true;
    this.emitStatus(
      isReconnect ? "reconnecting" : "connecting",
      isReconnect ? "Reconnecting routed Binance USD-M streams" : "Connecting to Binance USD-M",
    );

    const urls = buildBinanceStreamUrls(this.websocketBaseUrl, this.symbol, this.tradeStream);
    const clientOptions: ClientOptions = {
      handshakeTimeout: 8_000,
      perMessageDeflate: false,
      maxPayload: 2 * 1024 * 1024,
    };
    let depthSocket: WebSocket | null = null;
    let tradeSocket: WebSocket | null = null;
    try {
      depthSocket = this.socketFactory(urls.depth, clientOptions);
      this.depthSocket = depthSocket;
      tradeSocket = this.socketFactory(urls.trade, clientOptions);
      this.tradeSocket = tradeSocket;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Socket construction failed";
      this.restart(`Binance socket failed: ${message}`, false, "error");
      return;
    }
    this.bindDepthSocket(generation, depthSocket);
    this.bindTradeSocket(generation, tradeSocket);
    this.startHealthTimer(generation);
  }

  private bindDepthSocket(generation: number, socket: WebSocket): void {
    socket.on("open", () => {
      if (!this.isCurrentDepth(generation, socket)) return;
      this.lastDepthMessageAt = Date.now();
      this.touchMessage(this.lastDepthMessageAt);
      this.emitStatus("syncing", "Depth transport alive; buffering deltas and loading snapshot");
      void this.synchronize(generation, socket);
    });
    socket.on("message", (raw: RawData) => {
      if (!this.isCurrentDepth(generation, socket)) return;
      const receivedTimestamp = Date.now();
      this.lastDepthMessageAt = receivedTimestamp;
      this.touchMessage(receivedTimestamp);
      this.emit("raw", {
        receivedTimestamp,
        stream: "depth",
        connectionId: `binance-${generation}`,
        payload: rawToString(raw),
      } satisfies BinanceRawEvent);
      this.handleDepthMessage(raw, receivedTimestamp);
    });
    socket.on("pong", () => {
      if (!this.isCurrentDepth(generation, socket)) return;
      this.lastDepthMessageAt = Date.now();
      this.touchMessage(this.lastDepthMessageAt);
    });
    socket.on("error", (error) => {
      if (this.isCurrentDepth(generation, socket)) this.emit("diagnostic", error);
    });
    socket.on("close", (code, reason) => {
      if (!this.isCurrentDepth(generation, socket)) return;
      this.restart(formatClose("depth", code, reason), false, "reconnecting");
    });
  }

  private bindTradeSocket(generation: number, socket: WebSocket): void {
    socket.on("open", () => {
      if (!this.isCurrentTrade(generation, socket)) return;
      this.lastTradeMessageAt = Date.now();
      this.touchMessage(this.lastTradeMessageAt);
      this.maybeBecomeLive(generation);
    });
    socket.on("message", (raw: RawData) => {
      if (!this.isCurrentTrade(generation, socket)) return;
      const receivedTimestamp = Date.now();
      this.lastTradeMessageAt = receivedTimestamp;
      this.touchMessage(receivedTimestamp);
      this.emit("raw", {
        receivedTimestamp,
        stream: "trade",
        connectionId: `binance-${generation}`,
        payload: rawToString(raw),
      } satisfies BinanceRawEvent);
      this.handleTradeMessage(raw, receivedTimestamp);
    });
    socket.on("pong", () => {
      if (!this.isCurrentTrade(generation, socket)) return;
      this.lastTradeMessageAt = Date.now();
      this.touchMessage(this.lastTradeMessageAt);
    });
    socket.on("error", (error) => {
      if (this.isCurrentTrade(generation, socket)) this.emit("diagnostic", error);
    });
    socket.on("close", (code, reason) => {
      if (!this.isCurrentTrade(generation, socket)) return;
      this.restart(formatClose("trade", code, reason), false, "reconnecting");
    });
  }

  private async synchronize(generation: number, depthSocket: WebSocket): Promise<void> {
    try {
      const fetched = await this.fetchSnapshot(generation, depthSocket);
      if (!this.isCurrentDepth(generation, depthSocket)) return;
      const snapshot = fetched.snapshot;
      try {
        this.validator.loadSnapshot(snapshot);
      } catch (error) {
        if (error instanceof Error && error.message.toLowerCase().includes("crossed")) {
          this.quality.crossed();
        } else {
          this.quality.malformed();
        }
        throw error;
      }

      this.reconciliationSnapshot = snapshot;
      this.reconciliationAppliedUpdates = 0;
      this.reconciliationExchangeTimestamp = snapshot.exchangeTimestamp ?? Date.now();
      this.drainReconciliation(generation, depthSocket);
    } catch (error) {
      if (!this.isCurrentDepth(generation, depthSocket)) return;
      const message = error instanceof Error ? error.message : "Snapshot synchronization failed";
      this.restart(`Binance synchronization failed: ${message}`, true, "error");
    }
  }

  private async fetchSnapshot(
    generation: number,
    depthSocket: WebSocket,
  ): Promise<FetchedSnapshot> {
    if (this.snapshotFetcher) {
      const snapshot = await this.snapshotFetcher();
      const rawPayload = JSON.stringify(snapshot);
      if (this.isCurrentDepth(generation, depthSocket)) {
        this.emitRawSnapshot(generation, rawPayload);
      }
      return { snapshot, rawPayload };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7_000);
    try {
      const url = new URL("/fapi/v1/depth", this.restBaseUrl);
      url.searchParams.set("symbol", this.symbol);
      url.searchParams.set("limit", String(this.snapshotLimit));
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": "xbmap/1.0" },
      });
      if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
      const rawPayload = await response.text();
      // Capture the exact body before JSON parsing so malformed snapshots are
      // auditable and deterministic replay has its required starting state.
      if (this.isCurrentDepth(generation, depthSocket)) {
        this.emitRawSnapshot(generation, rawPayload);
      }
      let payload: Partial<DepthSnapshot>;
      try {
        payload = JSON.parse(rawPayload) as Partial<DepthSnapshot>;
      } catch {
        this.quality.malformed();
        throw new Error("Malformed Binance depth snapshot JSON");
      }
      if (
        !Number.isSafeInteger(payload.lastUpdateId) ||
        !Array.isArray(payload.bids) ||
        !Array.isArray(payload.asks)
      ) {
        this.quality.malformed();
        throw new Error("Malformed Binance depth snapshot");
      }
      return {
        snapshot: {
          lastUpdateId: payload.lastUpdateId as number,
          exchangeTimestamp: Date.now(),
          bids: payload.bids,
          asks: payload.asks,
        },
        rawPayload,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleDepthMessage(raw: RawData, receivedTimestamp: number): void {
    const payload = parsePayload(raw);
    if (!isDepthPayload(payload) || payload.s !== this.symbol) {
      this.quality.malformed();
      return;
    }
    const update = normalizeDepth(payload, receivedTimestamp);
    if (!update) {
      this.quality.malformed();
      return;
    }
    this.quality.observeClock(update.exchangeTimestamp, update.receivedTimestamp);
    if (this.synchronizing) {
      if (this.bufferedDepth.length >= this.maxBufferedDepth) {
        this.quality.queueOverflow();
        this.requestResync(`Depth buffer exceeded ${this.maxBufferedDepth} events`);
        return;
      }
      this.bufferedDepth.push(update);
      if (this.reconciliationSnapshot && this.depthSocket) {
        try {
          this.drainReconciliation(this.connectionGeneration, this.depthSocket);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Buffered reconciliation failed";
          this.restart(`Binance synchronization failed: ${message}`, true, "error");
        }
      }
      return;
    }
    const result = this.validator.applyUpdate(update);
    if (result.status === "applied") {
      this.emit("depth", update);
      return;
    }
    this.quality.recordApplyResult(result);
    if (result.status !== "ignored") {
      this.requestResync(result.reason ?? `Depth update rejected: ${result.status}`);
    }
  }

  private handleTradeMessage(raw: RawData, receivedTimestamp: number): void {
    const payload = parsePayload(raw);
    if (!isTradePayload(payload) || payload.s !== this.symbol) {
      this.quality.malformed();
      return;
    }
    const trade = normalizeTrade(payload, receivedTimestamp);
    if (!trade) {
      this.quality.malformed();
      return;
    }
    this.quality.observeClock(trade.exchangeTimestamp, trade.receivedTimestamp);
    // Never mix a pre-sync trade window with a post-sync book.
    if (this.live) this.emit("trade", trade);
  }

  private maybeBecomeLive(generation: number): void {
    if (
      !this.running ||
      generation !== this.connectionGeneration ||
      this.live ||
      !this.reconciliationReady ||
      !this.transportAlive()
    ) return;
    this.live = true;
    this.reconnectAttempts = 0;
    this.emitStatus("live", "Binance routed market streams synchronized atomically");
  }

  private drainReconciliation(generation: number, depthSocket: WebSocket): void {
    if (!this.reconciliationSnapshot || !this.isCurrentDepth(generation, depthSocket)) return;
    const snapshot = this.reconciliationSnapshot;
    const queued = this.bufferedDepth;
    this.bufferedDepth = [];
    // No message callback can interleave with this synchronous candidate drain.
    for (const update of queued) {
      if (update.sequenceEnd <= snapshot.lastUpdateId) continue;
      const result = this.validator.applyUpdate(update);
      if (result.status === "ignored") {
        this.quality.recordApplyResult(result);
        continue;
      }
      if (result.status !== "applied") {
        this.quality.recordApplyResult(result);
        throw new Error(result.reason ?? `Buffered depth ${result.status}`);
      }
      this.reconciliationAppliedUpdates += 1;
      this.reconciliationExchangeTimestamp = update.exchangeTimestamp;
    }
    // A REST snapshot alone is not sufficient proof of continuity. Wait for
    // the first stream event that bridges it before exposing any state.
    if (!this.validator.hasBridgedSnapshot) return;

    this.synchronizing = false;
    this.reconciliationReady = true;
    const finalSnapshot = this.validator.exportSnapshot(this.reconciliationExchangeTimestamp);
    const reconciliation: BinanceReconciliation = {
      snapshot: finalSnapshot,
      checkpoint: this.validator.checkpoint(),
      appliedUpdateCount: this.reconciliationAppliedUpdates,
      reconciledAt: Date.now(),
    };
    this.reconciliationSnapshot = null;
    this.emit("reconciled", reconciliation);
    this.emit("snapshot", finalSnapshot);
    this.maybeBecomeLive(generation);
  }

  private restart(
    message: string,
    immediate: boolean,
    state: "syncing" | "reconnecting" | "error",
  ): void {
    if (!this.running) return;
    this.quality.resync();
    this.connectionGeneration += 1;
    this.clearTimers();
    this.terminateSockets();
    this.resetConnectionState();
    this.emitStatus(state, message);
    this.scheduleReconnect(immediate);
  }

  private scheduleReconnect(immediate: boolean): void {
    if (!this.running || this.reconnectTimer) return;
    const exponential = Math.min(30_000, 500 * 2 ** this.reconnectAttempts);
    const delay = immediate ? 100 : Math.round(exponential * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 10);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(true);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startHealthTimer(generation: number): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      if (!this.running || generation !== this.connectionGeneration) return;
      const now = Date.now();
      const depthSilent = this.lastDepthMessageAt > 0 && now - this.lastDepthMessageAt > 25_000;
      const tradeSilent = this.lastTradeMessageAt > 0 && now - this.lastTradeMessageAt > 25_000;
      if (depthSilent || tradeSilent) {
        const streams = [depthSilent ? "depth" : "", tradeSilent ? "trade" : ""]
          .filter(Boolean)
          .join(" and ");
        this.restart(`Binance ${streams} heartbeat timed out`, true, "reconnecting");
        return;
      }
      if (this.depthSocket?.readyState === WebSocket.OPEN) this.depthSocket.ping();
      if (this.tradeSocket?.readyState === WebSocket.OPEN) this.tradeSocket.ping();
    }, 10_000);
    this.healthTimer.unref?.();
  }

  private isCurrentDepth(generation: number, socket: WebSocket): boolean {
    return this.running && generation === this.connectionGeneration && socket === this.depthSocket;
  }

  private isCurrentTrade(generation: number, socket: WebSocket): boolean {
    return this.running && generation === this.connectionGeneration && socket === this.tradeSocket;
  }

  private transportAlive(): boolean {
    return this.depthSocket?.readyState === WebSocket.OPEN &&
      this.tradeSocket?.readyState === WebSocket.OPEN;
  }

  private touchMessage(timestamp: number): void {
    this.lastMessageAt = Math.max(this.lastMessageAt, timestamp);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.reconnectTimer = null;
    this.healthTimer = null;
  }

  private terminateSockets(): void {
    const depth = this.depthSocket;
    const trade = this.tradeSocket;
    this.depthSocket = null;
    this.tradeSocket = null;
    for (const socket of [depth, trade]) {
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
  }

  private resetConnectionState(): void {
    this.bufferedDepth = [];
    this.reconciliationSnapshot = null;
    this.reconciliationAppliedUpdates = 0;
    this.reconciliationExchangeTimestamp = 0;
    this.synchronizing = false;
    this.reconciliationReady = false;
    this.live = false;
    this.lastDepthMessageAt = 0;
    this.lastTradeMessageAt = 0;
  }

  private emitStatus(state: StatusFrame["state"], message: string): void {
    const diagnostics = this.diagnostics;
    const validity = state === "live"
      ? "valid"
      : state === "stale"
        ? "stale"
        : state === "closed"
          ? "closed"
          : ["connecting", "syncing", "reconnecting"].includes(state)
            ? "syncing"
            : "invalid";
    this.emit("status", {
      state,
      source: "binance",
      message,
      stale: validity !== "valid",
      resyncCount: diagnostics.counters.resyncs,
      lastEventTimestamp: diagnostics.lastMessageAt,
      validity,
      transportAlive: diagnostics.transportAlive,
      marketActive: diagnostics.marketActive,
      synchronized: validity === "valid",
      frozen: validity !== "valid",
      reason: message,
      sessionId: `binance-${diagnostics.generation}`,
      counters: diagnostics.counters,
      clockDriftMs: diagnostics.clockDrift.latestMs,
      clockDrift: diagnostics.clockDrift,
      checkpoint: diagnostics.checkpoint,
    } satisfies StatusFrame);
  }

  private emitRawSnapshot(generation: number, payload: string): void {
    this.emit("raw", {
      receivedTimestamp: Date.now(),
      stream: "snapshot",
      connectionId: `binance-${generation}`,
      payload,
    } satisfies BinanceRawEvent);
  }
}

function parsePayload(raw: RawData): unknown {
  try {
    const text = rawToString(raw);
    const message = JSON.parse(text) as CombinedMessage | unknown;
    if (message && typeof message === "object" && "data" in message) {
      return (message as CombinedMessage).data;
    }
    return message;
  } catch {
    return null;
  }
}

function rawToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

function isDepthPayload(payload: unknown): payload is BinanceDepthPayload {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Partial<BinanceDepthPayload>;
  return candidate.e === "depthUpdate" &&
    typeof candidate.s === "string" &&
    Number.isSafeInteger(candidate.E) &&
    Number.isSafeInteger(candidate.U) &&
    Number.isSafeInteger(candidate.u) &&
    Array.isArray(candidate.b) &&
    Array.isArray(candidate.a);
}

function isTradePayload(payload: unknown): payload is BinanceTradePayload {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Partial<BinanceTradePayload>;
  return (candidate.e === "aggTrade" || candidate.e === "trade") &&
    typeof candidate.s === "string" &&
    Number.isSafeInteger(candidate.E) &&
    Number.isSafeInteger(candidate.T) &&
    (Number.isSafeInteger(candidate.a) || Number.isSafeInteger(candidate.t)) &&
    typeof candidate.p === "string" &&
    typeof candidate.q === "string" &&
    typeof candidate.m === "boolean";
}

function normalizeDepth(payload: BinanceDepthPayload, receivedTimestamp: number): DepthUpdate | null {
  if (payload.U < 0 || payload.u < payload.U) return null;
  const exchangeTimestamp = payload.T ?? payload.E;
  if (!Number.isSafeInteger(exchangeTimestamp) || exchangeTimestamp < 0) return null;
  return {
    exchangeTimestamp,
    receivedTimestamp,
    sequenceStart: payload.U,
    sequenceEnd: payload.u,
    ...(Number.isSafeInteger(payload.pu) ? { previousSequence: payload.pu } : {}),
    bids: payload.b,
    asks: payload.a,
  };
}

function normalizeTrade(payload: BinanceTradePayload, receivedTimestamp: number): NormalizedTrade | null {
  const price = Number(payload.p);
  const quantity = Number(payload.q);
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    payload.T < 0
  ) return null;
  return {
    id: String(payload.a ?? payload.t ?? 0),
    exchangeTimestamp: payload.T,
    receivedTimestamp,
    price,
    quantity,
    side: payload.m ? "sell" : "buy",
  };
}

function formatClose(stream: string, code: number, reason: Buffer): string {
  return `Binance ${stream} stream closed (${code}${reason.length ? `: ${reason.toString()}` : ""})`;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
