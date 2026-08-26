import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { AnalyticsEngine } from "./core/analytics.js";
import {
  addDataQualityCounters,
  DataQualityMonitor,
  MarketSession,
} from "./core/dataQuality.js";
import { OrderBook } from "./core/orderBook.js";
import { RingBuffer } from "./core/ringBuffer.js";
import { TradeAggregator } from "./core/tradeAggregator.js";
import {
  BinanceFeed,
  type BinanceRawEvent,
  type BinanceReconciliation,
} from "./feeds/binanceFeed.js";
import { DemoFeed } from "./feeds/demoFeed.js";
import {
  nearestHistoryResolution,
  type HistoryPersistence,
} from "./historyPersistence.js";
import {
  RawCaptureRecorder,
  rawCaptureOptionsFromEnvironment,
  type RawCaptureStats,
} from "./recording/rawCapture.js";
import type { GatewayMetricsHooks } from "./observability/types.js";
import {
  DEFAULT_EXCHANGE,
  DEFAULT_SETTINGS,
  DEFAULT_SYMBOL,
  DEFAULT_TICK_SIZE,
  SCHEMA_VERSION,
  type BookFrame,
  type DataQualityState,
  type DepthSnapshot,
  type DepthUpdate,
  type GatewaySettings,
  type HistoryPoint,
  type MarketSource,
  type NormalizedTrade,
  type ServerEnvelope,
  type ServerEventType,
  type StatusFrame,
} from "./types.js";

export interface MarketGatewayOptions {
  symbol?: string;
  tickSize?: number;
  settings?: Partial<GatewaySettings>;
  forceDemo?: boolean;
  /** Override Binance WS stream base (regional mirror / proxy). */
  binanceWebsocketBaseUrl?: string;
  /** Override Binance REST snapshot base (fapi-compatible host). */
  binanceRestBaseUrl?: string;
  /** Trade stream type: global serves aggTrade; mirrors may serve trade. */
  binanceTradeStream?: "aggTrade" | "trade";
  /** `undefined` reads the opt-in environment config; `null` explicitly disables it. */
  rawCapture?: RawCaptureRecorder | null;
  /** Pre-opened durable projection; omitted in isolated unit tests. */
  historyPersistence?: HistoryPersistence | null;
  /** Optional Phase 3 observability bridge; a no-op when omitted. */
  metrics?: GatewayMetricsHooks | null;
}

export type GatewayCaptureStatus =
  | { enabled: false }
  | Pick<
      RawCaptureStats,
      | "enabled"
      | "captureId"
      | "startedAt"
      | "closedAt"
      | "acceptedRecords"
      | "writtenRecords"
      | "droppedRecords"
      | "invalidRecords"
      | "rawBytes"
      | "queuedRecords"
      | "queuedBytes"
      | "queueOverflows"
      | "captureLimitReached"
      | "expired"
      | "failed"
      | "maxDurationMs"
      | "retentionMs"
    >;

export interface ReplaySession {
  id: string;
  symbol: string;
  from: number;
  to: number;
  speed: number;
  createdAt: number;
  expiresAt: number;
  frames: HistoryPoint[];
}

/** Owns one vertical market-data slice and publishes normalized versioned events. */
export class MarketGateway extends EventEmitter {
  readonly symbol: string;
  readonly tickSize: number;

  private settingsValue: GatewaySettings;
  private book: OrderBook;
  private analytics: AnalyticsEngine;
  private tradeAggregator: TradeAggregator;
  private readonly binance: BinanceFeed;
  private readonly demo: DemoFeed;
  private readonly historyBuffer = new RingBuffer<HistoryPoint>(21_600);
  private readonly replaySessions = new Map<string, ReplaySession>();
  private readonly forceDemo: boolean;
  private readonly rawCapture: RawCaptureRecorder | null;
  private readonly historyPersistence: HistoryPersistence | null;
  private readonly metricsHooks: GatewayMetricsHooks | null;
  private frameTimer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private activeSource: MarketSource = "binance";
  private started = false;
  private outboundSequence = 0;
  private lastMarketEventAt: number | null = null;
  private lastExchangeTimestamp: number | undefined;
  private lastPersistedMetricEnd = 0;
  private lastPersistedSnapshotAt = 0;
  private readonly historyTradeIntervals = new Map<number, {
    buyVolume: number;
    sellVolume: number;
    tradeCount: number;
  }>();
  private lastPriceEmitAt = 0;
  private latestTrendScore = 0;
  private latestTrendDirection: HistoryPoint["trendDirection"] = "neutral";
  private readonly qualityMonitor = new DataQualityMonitor();
  private readonly marketSession = new MarketSession({
    sessionId: randomUUID(),
    source: "binance",
    reason: "Gateway not started",
  });
  private shuttingDown = false;
  private currentStatus: StatusFrame = {
    state: "connecting",
    source: "binance",
    message: "Gateway not started",
    stale: true,
    resyncCount: 0,
    lastEventTimestamp: null,
  };
  private pendingBinanceReconciliation: BinanceReconciliation | null = null;
  private pendingBinanceUpdates: DepthUpdate[] = [];
  private readonly maxPendingBinanceUpdates = 20_000;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: MarketGatewayOptions = {}) {
    super();
    this.symbol = (options.symbol ?? DEFAULT_SYMBOL).toUpperCase();
    this.tickSize = options.tickSize ?? DEFAULT_TICK_SIZE;
    this.settingsValue = validateSettings({ ...DEFAULT_SETTINGS, ...options.settings });
    this.forceDemo = options.forceDemo ?? process.env.XBMAP_DEMO === "1";
    const captureOptions = rawCaptureOptionsFromEnvironment(this.symbol);
    this.rawCapture = options.rawCapture !== undefined
      ? options.rawCapture
      : captureOptions
        ? new RawCaptureRecorder(captureOptions)
        : null;
    this.historyPersistence = options.historyPersistence ?? null;
    this.metricsHooks = options.metrics ?? null;
    this.book = new OrderBook(this.tickSize);
    this.analytics = new AnalyticsEngine(this.settingsValue);
    this.tradeAggregator = new TradeAggregator(
      this.settingsValue.bubbleBucketMs,
      this.tickSize,
    );
    this.binance = new BinanceFeed({
      symbol: this.symbol,
      tickSize: this.tickSize,
      ...(options.binanceRestBaseUrl ? { restBaseUrl: options.binanceRestBaseUrl } : {}),
      ...(options.binanceWebsocketBaseUrl ? { websocketBaseUrl: options.binanceWebsocketBaseUrl } : {}),
      ...(options.binanceTradeStream ? { tradeStream: options.binanceTradeStream } : {}),
    });
    this.demo = new DemoFeed({ symbol: this.symbol, tickSize: this.tickSize });
    this.bindFeeds();
  }

  get settings(): GatewaySettings {
    return { ...this.settingsValue };
  }

  get status(): StatusFrame {
    return cloneStatus(this.enrichStatus(this.currentStatus));
  }

  get source(): MarketSource {
    return this.activeSource;
  }

  /** Path and failure details stay server-local; public health only exposes bounded counters. */
  get captureStatus(): GatewayCaptureStatus {
    if (!this.rawCapture) return { enabled: false };
    const {
      enabled,
      captureId,
      startedAt,
      closedAt,
      acceptedRecords,
      writtenRecords,
      droppedRecords,
      invalidRecords,
      rawBytes,
      queuedRecords,
      queuedBytes,
      queueOverflows,
      captureLimitReached,
      expired,
      failed,
      maxDurationMs,
      retentionMs,
    } = this.rawCapture.stats;
    return {
      enabled,
      captureId,
      startedAt,
      closedAt,
      acceptedRecords,
      writtenRecords,
      droppedRecords,
      invalidRecords,
      rawBytes,
      queuedRecords,
      queuedBytes,
      queueOverflows,
      captureLimitReached,
      expired,
      failed,
      maxDurationMs,
      retentionMs,
    };
  }

  get historyStatus() {
    return this.historyPersistence?.stats ?? { enabled: false as const };
  }

  get dataQuality(): DataQualityState {
    const gatewayCounters = this.qualityMonitor.counters;
    const feedDiagnostics = this.binance.diagnostics;
    const counters = addDataQualityCounters(gatewayCounters, feedDiagnostics.counters);
    counters.queueOverflows += this.rawCapture?.stats.queueOverflows ?? 0;
    counters.queueOverflows += this.historyPersistence?.stats.writer.queueOverflows ?? 0;
    const gatewayDrift = this.qualityMonitor.clockDrift;
    const clockDrift = this.activeSource === "binance" && feedDiagnostics.clockDrift.samples > 0
      ? feedDiagnostics.clockDrift
      : gatewayDrift;
    return this.marketSession.snapshot(counters, clockDrift);
  }

  get isMarketDataValid(): boolean {
    return this.marketSession.isValid && this.book.isSynchronized;
  }

  start(): void {
    if (this.started) return;
    if (this.shutdownPromise) throw new Error("A closed gateway cannot be restarted");
    this.started = true;
    this.shuttingDown = false;
    this.lastPersistedMetricEnd = Math.floor(Date.now() / 1_000) * 1_000;
    this.historyTradeIntervals.clear();
    this.marketSession.begin(randomUUID(), this.forceDemo ? "demo" : "binance", "Gateway starting");
    this.startFrameTimer();
    this.cleanupTimer = setInterval(() => this.cleanupReplaySessions(), 60_000);
    this.cleanupTimer.unref?.();
    if (this.forceDemo) {
      // `stop()` retains the last source for diagnostics; normalize it so a
      // subsequent start can enter demo mode through the regular atomic path.
      this.activeSource = "binance";
      this.switchToDemo("Demo mode selected by XBMAP_DEMO");
    } else {
      this.activeSource = "binance";
      this.binance.start();
      this.scheduleDemoFallback();
    }
  }

  stop(): void {
    if (!this.started && !this.shuttingDown) return;
    this.started = false;
    this.binance.stop();
    this.demo.stop();
    if (this.frameTimer) clearInterval(this.frameTimer);
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.frameTimer = null;
    this.fallbackTimer = null;
    this.cleanupTimer = null;
  }

  /** Stop ingress first, flush final buffers/capture, then freeze state. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true;
    const wasStarted = this.started;
    this.stop();
    if (wasStarted && this.marketSession.isValid) {
      for (const bucket of this.tradeAggregator.flushAll()) {
        this.publish("trade_bucket", { ...bucket, source: this.activeSource }, bucket.bucketEnd);
      }
    }
    this.marketSession.close("Gateway shutting down");
    this.resetDerivedState();
    this.publish("market_reset", {
      sessionId: this.marketSession.sessionId,
      reason: "Gateway shutting down",
      frozen: true,
    });
    this.publishStatus({
      state: "closed",
      source: this.activeSource,
      message: "Gateway shutting down",
      stale: true,
      resyncCount: this.binance.resyncCount,
      lastEventTimestamp: this.lastMarketEventAt,
    });
    if (this.rawCapture) {
      try {
        await this.rawCapture.close("gateway_shutdown");
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          component: "raw-capture",
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    if (this.historyPersistence) {
      try {
        await this.historyPersistence.close();
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          component: "history-persistence",
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }

  updateSettings(patch: Partial<GatewaySettings>): GatewaySettings {
    const previous = this.settingsValue;
    this.settingsValue = validateSettings({ ...previous, ...patch });
    if (previous.frameIntervalMs !== this.settingsValue.frameIntervalMs && this.started) {
      this.startFrameTimer();
    }
    if (previous.bubbleBucketMs !== this.settingsValue.bubbleBucketMs) {
      this.tradeAggregator = new TradeAggregator(
        this.settingsValue.bubbleBucketMs,
        this.tickSize,
      );
    }
    if (
      previous.trendEnterScore !== this.settingsValue.trendEnterScore ||
      previous.trendExitScore !== this.settingsValue.trendExitScore
    ) {
      this.analytics = new AnalyticsEngine(this.settingsValue);
    }
    return this.settings;
  }

  getSnapshot(depth = this.settingsValue.visibleDepth): ServerEnvelope {
    const safeDepth = clampInteger(depth, 10, 200);
    const valid = this.isMarketDataValid;
    const levels = valid ? this.book.getLevels(safeDepth) : { bids: [], asks: [] };
    const checkpoint = valid ? this.book.checkpoint() : null;
    return this.makeEnvelope("snapshot", {
      lastUpdateId: valid ? this.book.lastUpdateId : 0,
      tickSize: this.tickSize,
      bids: levels.bids,
      asks: levels.asks,
      source: this.activeSource,
      valid,
      frozen: !valid,
      sessionId: this.marketSession.sessionId,
      checkpoint,
    });
  }

  createEvent(type: ServerEventType, data: unknown): ServerEnvelope {
    return this.makeEnvelope(type, data);
  }

  async getHistory(
    from: number,
    to: number,
    resolutionMs = 1_000,
    limit = 10_000,
  ): Promise<HistoryPoint[]> {
    const safeFrom = Number.isFinite(from) ? from : 0;
    const safeTo = Number.isFinite(to) ? to : Date.now();
    const safeResolution = nearestHistoryResolution(resolutionMs);
    if (this.historyPersistence) {
      const result = await this.historyPersistence.queryHistory(
        safeFrom,
        safeTo,
        safeResolution,
        limit,
      );
      return result.items;
    }
    const points = this.historyBuffer
      .toArray()
      .filter((point) => point.timestamp >= safeFrom && point.timestamp <= safeTo);
    if (safeResolution <= 1_000) return points.slice(0, limit);

    const buckets = new Map<number, HistoryPoint[]>();
    for (const point of points) {
      const key = Math.floor(point.timestamp / safeResolution) * safeResolution;
      const bucket = buckets.get(key) ?? [];
      bucket.push(point);
      buckets.set(key, bucket);
    }
    return [...buckets.entries()]
      .map(([timestamp, bucket]) => aggregateHistory(timestamp, bucket))
      .slice(0, limit);
  }

  historyResolution(resolutionMs: number): number {
    return nearestHistoryResolution(resolutionMs);
  }

  async createReplaySession(options: {
    from?: number;
    to?: number;
    speed?: number;
    resolutionMs?: number;
  }): Promise<ReplaySession> {
    const now = Date.now();
    const to = finiteOr(options.to, now);
    const from = finiteOr(options.from, to - 5 * 60_000);
    const speed = Math.max(0.25, Math.min(20, finiteOr(options.speed, 1)));
    const frames = await this.getHistory(
      from,
      to,
      finiteOr(options.resolutionMs, 1_000),
      10_000,
    );
    const session: ReplaySession = {
      id: randomUUID(),
      symbol: this.symbol,
      from,
      to,
      speed,
      createdAt: now,
      expiresAt: now + 30 * 60_000,
      frames,
    };
    this.replaySessions.set(session.id, session);
    return session;
  }

  getReplaySession(id: string): ReplaySession | undefined {
    const session = this.replaySessions.get(id);
    return session && session.expiresAt > Date.now() ? session : undefined;
  }

  private bindFeeds(): void {
    this.binance.on("raw", (event: BinanceRawEvent) => {
      if (!this.rawCapture) return;
      this.rawCapture.record({
        capturedAt: event.receivedTimestamp,
        exchange: "binance",
        symbol: this.symbol,
        source: "binance",
        stream: event.stream,
        connectionId: event.connectionId,
        payload: event.payload,
      });
    });
    this.binance.on("reconciled", (reconciliation: BinanceReconciliation) => {
      this.pendingBinanceReconciliation = reconciliation;
      this.pendingBinanceUpdates = [];
    });
    this.binance.on("depth", (update: DepthUpdate) => {
      if (this.activeSource !== "binance" || !this.marketSession.isValid) {
        if (!this.pendingBinanceReconciliation) return;
        if (this.pendingBinanceUpdates.length >= this.maxPendingBinanceUpdates) {
          this.qualityMonitor.queueOverflow();
          this.pendingBinanceReconciliation = null;
          this.pendingBinanceUpdates = [];
          this.binance.requestResync("Gateway reconciliation queue overflow");
          return;
        }
        this.pendingBinanceUpdates.push(update);
        return;
      }
      this.processDepth("binance", update);
    });
    this.binance.on("trade", (trade: NormalizedTrade) => {
      if (this.activeSource === "binance") this.processTrade("binance", trade);
    });
    this.binance.on("status", (status: StatusFrame) => this.handleBinanceStatus(status));
    this.binance.on("diagnostic", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ level: "warn", component: "binance", message }));
    });

    this.demo.on("snapshot", (snapshot: DepthSnapshot) => {
      if (this.activeSource === "demo") this.processSnapshot("demo", snapshot, true);
    });
    this.demo.on("depth", (update: DepthUpdate) => {
      if (this.activeSource === "demo") this.processDepth("demo", update);
    });
    this.demo.on("trade", (trade: NormalizedTrade) => {
      if (this.activeSource === "demo") this.processTrade("demo", trade);
    });
    this.demo.on("status", (status: StatusFrame) => {
      if (this.activeSource === "demo") this.publishStatus(status);
    });
  }

  private handleBinanceStatus(status: StatusFrame): void {
    if (status.state === "live") {
      this.switchToBinance(status);
      return;
    }
    if (["connecting", "syncing", "reconnecting", "error", "stale"].includes(status.state)) {
      // A transport generation change invalidates every staged state from the
      // previous generation. A later `reconciled` event repopulates it.
      this.pendingBinanceReconciliation = null;
      this.pendingBinanceUpdates = [];
    }
    if (this.activeSource === "binance") {
      const validity = status.state === "stale"
        ? "stale"
        : ["connecting", "syncing", "reconnecting"].includes(status.state)
          ? "syncing"
          : "invalid";
      this.invalidateMarketData(
        status.message,
        validity,
        status.transportAlive ?? false,
        status.sessionId,
      );
      this.publishStatus(status);
      if (["reconnecting", "error", "stale"].includes(status.state)) {
        this.scheduleDemoFallback();
      }
    } else {
      this.publishStatus({
        ...this.currentStatus,
        state: "demo",
        source: "demo",
        stale: false,
        message: `Synthetic market active; Binance ${status.state}: ${status.message}`,
        resyncCount: status.resyncCount,
      });
    }
  }

  private switchToBinance(status: StatusFrame): void {
    const reconciliation = this.pendingBinanceReconciliation;
    if (!reconciliation) {
      this.binance.requestResync("Live status arrived without a staged snapshot");
      return;
    }
    const candidate = new OrderBook(this.tickSize);
    try {
      candidate.loadSnapshot(reconciliation.snapshot);
      if (candidate.fingerprint() !== reconciliation.checkpoint.fingerprint) {
        throw new Error("Reconciled snapshot fingerprint mismatch");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid reconciled snapshot";
      if (message.toLowerCase().includes("crossed")) this.qualityMonitor.crossed();
      else this.qualityMonitor.malformed();
      this.pendingBinanceReconciliation = null;
      this.pendingBinanceUpdates = [];
      this.binance.requestResync(message);
      return;
    }
    let lastReceivedTimestamp = reconciliation.reconciledAt;
    let lastExchangeTimestamp = reconciliation.snapshot.exchangeTimestamp ?? reconciliation.reconciledAt;
    for (const update of this.pendingBinanceUpdates) {
      const result = candidate.applyUpdate(update);
      if (result.status === "ignored") {
        this.qualityMonitor.recordApplyResult(result);
        continue;
      }
      if (result.status !== "applied") {
        this.qualityMonitor.recordApplyResult(result);
        this.pendingBinanceReconciliation = null;
        this.pendingBinanceUpdates = [];
        this.binance.requestResync(result.reason ?? "Staged update sequence gap");
        return;
      }
      lastReceivedTimestamp = update.receivedTimestamp;
      lastExchangeTimestamp = update.exchangeTimestamp;
    }

    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
    const previousSessionId = this.marketSession.sessionId;
    this.demo.stop();
    this.activeSource = "binance";
    this.book = candidate;
    this.resetDerivedState(false);
    this.lastMarketEventAt = lastReceivedTimestamp;
    this.lastExchangeTimestamp = lastExchangeTimestamp;
    this.qualityMonitor.observeClock(lastExchangeTimestamp, lastReceivedTimestamp);
    this.marketSession.begin(
      status.sessionId ?? randomUUID(),
      "binance",
      "Committing reconciled Binance state",
    );
    this.marketSession.valid(candidate.checkpoint(), status.message, lastReceivedTimestamp);
    this.persistBookSnapshot(
      candidate.exportSnapshot(lastExchangeTimestamp),
      lastReceivedTimestamp,
    );
    this.publish("market_reset", {
      previousSessionId,
      sessionId: this.marketSession.sessionId,
      reason: "Atomic Binance reconciliation committed",
      frozen: false,
    }, lastExchangeTimestamp);
    this.publishBookSnapshot("binance", lastExchangeTimestamp);
    this.publishStatus({ ...status, stale: false });
    this.pendingBinanceReconciliation = null;
    this.pendingBinanceUpdates = [];
  }

  private switchToDemo(reason: string): void {
    if (!this.started || this.activeSource === "demo") return;
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
    const previousSessionId = this.marketSession.sessionId;
    this.activeSource = "demo";
    this.marketSession.begin(randomUUID(), "demo", reason);
    this.resetDerivedState();
    this.publish("market_reset", {
      previousSessionId,
      sessionId: this.marketSession.sessionId,
      reason,
      frozen: true,
    });
    this.demo.start();
    this.publishStatus({
      state: "demo",
      source: "demo",
      message: `${reason}; using realistic synthetic data`,
      stale: false,
      resyncCount: this.binance.resyncCount,
      lastEventTimestamp: Date.now(),
    });
  }

  private processSnapshot(
    source: MarketSource,
    snapshot: DepthSnapshot,
    resetAnalytics = false,
  ): void {
    if (source !== this.activeSource) return;
    const started = performance.now();
    this.metricsHooks?.received("snapshot");
    try {
      const candidate = new OrderBook(this.tickSize);
      candidate.loadSnapshot(snapshot);
      this.book = candidate;
      if (resetAnalytics) this.resetDerivedState(false);
      const timestamp = snapshot.exchangeTimestamp ?? Date.now();
      this.lastMarketEventAt = Date.now();
      this.lastExchangeTimestamp = timestamp;
      this.qualityMonitor.observeClock(timestamp, this.lastMarketEventAt);
      this.marketSession.valid(candidate.checkpoint(), `${source} snapshot committed`);
      this.persistBookSnapshot(candidate.exportSnapshot(timestamp), this.lastMarketEventAt);
      this.metricsHooks?.processed("snapshot", performance.now() - started);
      this.publishBookSnapshot(source, timestamp);
    } catch (error) {
      this.metricsHooks?.rejected("snapshot");
      const message = error instanceof Error ? error.message : "Invalid depth snapshot";
      if (message.toLowerCase().includes("crossed")) this.qualityMonitor.crossed();
      else this.qualityMonitor.malformed();
      if (source === "binance") this.binance.requestResync(message);
      else this.publishStatus({
        state: "error",
        source,
        message,
        stale: true,
        resyncCount: this.binance.resyncCount,
        lastEventTimestamp: Date.now(),
      });
    }
  }

  private processDepth(source: MarketSource, update: DepthUpdate): void {
    if (source !== this.activeSource || !this.marketSession.isValid) return;
    const started = performance.now();
    this.metricsHooks?.received("depth");
    const result = this.book.applyUpdate(update);
    if (result.status === "applied") {
      this.metricsHooks?.processed("depth", performance.now() - started);
      this.lastMarketEventAt = update.receivedTimestamp;
      this.lastExchangeTimestamp = update.exchangeTimestamp;
      this.qualityMonitor.observeClock(update.exchangeTimestamp, update.receivedTimestamp);
      this.marketSession.refresh(this.book.checkpoint(), update.receivedTimestamp);
      this.historyPersistence?.recordDepth(this.marketSession.sessionId, update);
      if (update.receivedTimestamp - this.lastPersistedSnapshotAt >= 30_000) {
        this.persistBookSnapshot(
          this.book.exportSnapshot(update.exchangeTimestamp),
          update.receivedTimestamp,
        );
      }
      if (this.currentStatus.state === "stale") {
        this.publishStatus({
          state: source === "binance" ? "live" : "demo",
          source,
          message: "Market data recovered",
          stale: false,
          resyncCount: this.binance.resyncCount,
          lastEventTimestamp: this.lastMarketEventAt,
        });
      }
      return;
    }
    this.qualityMonitor.recordApplyResult(result);
    this.metricsHooks?.rejected(result.status);
    if (result.status === "ignored") return;
    this.invalidateMarketData(
      result.reason ?? result.status,
      "invalid",
      true,
    );
    if (source === "binance") this.binance.requestResync(result.reason ?? result.status);
    else {
      this.demo.stop();
      this.demo.start();
    }
  }

  private processTrade(source: MarketSource, trade: NormalizedTrade): void {
    if (source !== this.activeSource || !this.marketSession.isValid) return;
    const started = performance.now();
    this.metricsHooks?.received("trade");
    if (
      !Number.isFinite(trade.exchangeTimestamp) ||
      !Number.isFinite(trade.receivedTimestamp) ||
      !Number.isFinite(trade.price) ||
      trade.price <= 0 ||
      !Number.isFinite(trade.quantity) ||
      trade.quantity <= 0 ||
      (trade.side !== "buy" && trade.side !== "sell") ||
      trade.exchangeTimestamp < 0 ||
      trade.receivedTimestamp < 0
    ) {
      this.qualityMonitor.malformed();
      this.metricsHooks?.rejected("malformed_trade");
      return;
    }
    this.analytics.onTrade(trade);
    this.tradeAggregator.add(trade);
    this.historyPersistence?.recordTrade(this.marketSession.sessionId, trade);
    const intervalStart = Math.floor(trade.receivedTimestamp / 1_000) * 1_000;
    const interval = this.historyTradeIntervals.get(intervalStart) ?? {
      buyVolume: 0,
      sellVolume: 0,
      tradeCount: 0,
    };
    if (trade.side === "buy") interval.buyVolume += trade.quantity;
    else interval.sellVolume += trade.quantity;
    interval.tradeCount += 1;
    this.historyTradeIntervals.set(intervalStart, interval);
    this.lastMarketEventAt = trade.receivedTimestamp;
    this.lastExchangeTimestamp = trade.exchangeTimestamp;
    this.qualityMonitor.observeClock(trade.exchangeTimestamp, trade.receivedTimestamp);
    if (trade.receivedTimestamp - this.lastPriceEmitAt >= 50) {
      this.lastPriceEmitAt = trade.receivedTimestamp;
      this.publish("price", {
        price: trade.price,
        quantity: trade.quantity,
        side: trade.side,
        source,
      }, trade.exchangeTimestamp);
    }
    this.metricsHooks?.processed("trade", performance.now() - started);
  }

  private emitFrame(): void {
    if (!this.started || !this.isMarketDataValid) return;
    const started = performance.now();
    const now = Date.now();
    const stale =
      this.lastMarketEventAt === null ||
      now - this.lastMarketEventAt > this.settingsValue.staleAfterMs;
    if (stale && this.currentStatus.state !== "stale") {
      this.invalidateMarketData(
        `No market event for more than ${this.settingsValue.staleAfterMs}ms`,
        "stale",
        this.currentStatus.transportAlive ?? true,
        undefined,
        false,
      );
      this.publishStatus({
        state: "stale",
        source: this.activeSource,
        message: `No market event for more than ${this.settingsValue.staleAfterMs}ms`,
        stale: true,
        resyncCount: this.binance.resyncCount,
        lastEventTimestamp: this.lastMarketEventAt,
      });
      if (this.activeSource === "binance") {
        this.binance.requestResync("Gateway market data became stale");
      } else {
        this.demo.stop();
        this.demo.start();
      }
      return;
    }

    const frame = this.buildBookFrame(200, stale);
    this.publish("depth_frame", frame, this.lastExchangeTimestamp);
    for (const bucket of this.tradeAggregator.flushCompleted(now)) {
      this.publish("trade_bucket", { ...bucket, source: this.activeSource }, bucket.bucketEnd);
    }
    const { metric, trend } = this.analytics.compute(this.book, now, stale);
    this.latestTrendScore = trend.score;
    this.latestTrendDirection = trend.direction;
    this.publish("metric", metric, this.lastExchangeTimestamp);
    this.publish("trend_signal", trend, this.lastExchangeTimestamp);

    const intervalEnd = Math.floor(now / 1_000) * 1_000;
    if (intervalEnd > this.lastPersistedMetricEnd) {
      const intervalStart = intervalEnd - 1_000;
      const facts = this.historyTradeIntervals.get(intervalStart) ?? {
        buyVolume: 0,
        sellVolume: 0,
        tradeCount: 0,
      };
      const volume = facts.buyVolume + facts.sellVolume;
      const delta = facts.buyVolume - facts.sellVolume;
      const point: HistoryPoint = {
        timestamp: intervalStart,
        price: metric.lastPrice,
        volume,
        delta,
        cvd: metric.cvd,
        imbalance: metric.imbalance,
        trendScore: this.latestTrendScore,
        trendDirection: this.latestTrendDirection,
      };
      this.historyBuffer.push(point);
      this.historyPersistence?.recordMetric(
        this.marketSession.sessionId,
        metric,
        trend,
        {
          intervalStart,
          intervalEnd,
          buyVolume: facts.buyVolume,
          sellVolume: facts.sellVolume,
          tradeCount: facts.tradeCount,
        },
        this.book.checkpoint().fingerprint,
      );
      this.lastPersistedMetricEnd = intervalEnd;
      for (const timestamp of this.historyTradeIntervals.keys()) {
        if (timestamp <= intervalStart) this.historyTradeIntervals.delete(timestamp);
      }
    }
    this.metricsHooks?.frameBuilt(performance.now() - started);
  }

  private buildBookFrame(depth: number, stale: boolean): BookFrame {
    const levels = this.book.getLevels(depth);
    const bestBid = levels.bids[0]?.[0] ?? null;
    const bestAsk = levels.asks[0]?.[0] ?? null;
    return {
      lastUpdateId: this.book.lastUpdateId,
      bids: levels.bids,
      asks: levels.asks,
      bestBid,
      bestAsk,
      midPrice: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      stale,
      source: this.activeSource,
      valid: this.marketSession.isValid && !stale,
      sessionId: this.marketSession.sessionId,
      checkpoint: this.book.checkpoint(),
    };
  }

  private persistBookSnapshot(snapshot: DepthSnapshot, receivedTimestamp: number): void {
    if (!this.historyPersistence || !this.book.isSynchronized) return;
    this.historyPersistence.recordSnapshot(
      this.marketSession.sessionId,
      snapshot,
      this.book.checkpoint().fingerprint,
      receivedTimestamp,
    );
    this.lastPersistedSnapshotAt = receivedTimestamp;
  }

  private resetDerivedState(resetBook = true): void {
    if (resetBook) this.book = new OrderBook(this.tickSize);
    this.analytics.reset();
    this.tradeAggregator.clear();
    this.lastMarketEventAt = null;
    this.lastExchangeTimestamp = undefined;
    this.lastPriceEmitAt = 0;
    this.lastPersistedMetricEnd = Math.floor(Date.now() / 1_000) * 1_000;
    this.lastPersistedSnapshotAt = 0;
    this.historyTradeIntervals.clear();
  }

  private startFrameTimer(): void {
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = setInterval(
      () => this.emitFrame(),
      this.settingsValue.frameIntervalMs,
    );
    this.frameTimer.unref?.();
  }

  private scheduleDemoFallback(): void {
    if (!this.started || this.forceDemo || this.activeSource === "demo" || this.fallbackTimer) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (this.currentStatus.state !== "live") {
        this.switchToDemo("Binance did not become live in time");
      }
    }, this.settingsValue.demoFallbackAfterMs);
    this.fallbackTimer.unref?.();
  }

  private publishStatus(status: StatusFrame): void {
    const enriched = this.enrichStatus(status);
    this.currentStatus = cloneStatus(enriched);
    this.publish("status", enriched);
  }

  private enrichStatus(status: StatusFrame): StatusFrame {
    const quality = this.dataQuality;
    return {
      ...status,
      source: this.activeSource,
      stale: quality.validity !== "valid",
      resyncCount: quality.counters.resyncs,
      lastEventTimestamp: this.lastMarketEventAt ?? status.lastEventTimestamp,
      validity: quality.validity,
      transportAlive: quality.transportAlive,
      marketActive: quality.marketActive,
      synchronized: quality.synchronized,
      frozen: quality.frozen,
      reason: quality.reason,
      sessionId: quality.sessionId,
      lastValidAt: quality.lastValidAt,
      counters: quality.counters,
      clockDriftMs: quality.clockDrift.latestMs,
      clockDrift: quality.clockDrift,
      checkpoint: quality.checkpoint,
    };
  }

  private publish(type: ServerEventType, data: unknown, exchangeTimestamp?: number): void {
    const envelope = this.makeEnvelope(type, data, exchangeTimestamp);
    this.emit("event", envelope);
  }

  private makeEnvelope(
    type: ServerEventType,
    data: unknown,
    exchangeTimestamp?: number,
  ): ServerEnvelope {
    return {
      type,
      schemaVersion: SCHEMA_VERSION,
      exchange: DEFAULT_EXCHANGE,
      symbol: this.symbol,
      serverTimestamp: Date.now(),
      ...(exchangeTimestamp !== undefined ? { exchangeTimestamp } : {}),
      sequence: ++this.outboundSequence,
      data,
    };
  }

  private publishBookSnapshot(source: MarketSource, exchangeTimestamp: number): void {
    const checkpoint = this.book.checkpoint();
    this.publish("snapshot", {
      lastUpdateId: this.book.lastUpdateId,
      tickSize: this.tickSize,
      ...this.book.getLevels(200),
      source,
      valid: this.marketSession.isValid,
      frozen: !this.marketSession.isValid,
      sessionId: this.marketSession.sessionId,
      checkpoint,
    }, exchangeTimestamp);
  }

  private invalidateMarketData(
    reason: string,
    validity: "invalid" | "syncing" | "stale",
    transportAlive: boolean,
    sessionId?: string,
    clearBook = true,
  ): void {
    const wasValid = this.marketSession.isValid;
    const previousSessionId = this.marketSession.sessionId;
    const previousEventAt = this.lastMarketEventAt;
    const previousExchangeTimestamp = this.lastExchangeTimestamp;
    if (sessionId && sessionId !== previousSessionId) {
      this.marketSession.begin(sessionId, this.activeSource, reason);
    }
    this.marketSession.invalidate(validity, reason, transportAlive);
    this.resetDerivedState(clearBook);
    this.lastMarketEventAt = previousEventAt;
    this.lastExchangeTimestamp = previousExchangeTimestamp;
    if (!wasValid && previousSessionId === this.marketSession.sessionId) return;
    this.publish("market_reset", {
      previousSessionId,
      sessionId: this.marketSession.sessionId,
      reason,
      frozen: true,
    });
    this.publish("trend_signal", {
      direction: "neutral",
      score: 0,
      upScore: 0,
      downScore: 0,
      confidence: 0,
      active: false,
      strength: "neutral",
      reasons: [`Market data invalid: ${reason}`],
      since: null,
    });
  }

  private cleanupReplaySessions(): void {
    const now = Date.now();
    for (const [id, session] of this.replaySessions) {
      if (session.expiresAt <= now) this.replaySessions.delete(id);
    }
  }
}

function validateSettings(settings: GatewaySettings): GatewaySettings {
  const result = {
    frameIntervalMs: clampInteger(settings.frameIntervalMs, 50, 1_000),
    bubbleBucketMs: clampInteger(settings.bubbleBucketMs, 100, 2_000),
    visibleDepth: clampInteger(settings.visibleDepth, 10, 200),
    staleAfterMs: clampInteger(settings.staleAfterMs, 1_000, 30_000),
    demoFallbackAfterMs: clampInteger(settings.demoFallbackAfterMs, 1_000, 30_000),
    trendEnterScore: clampInteger(settings.trendEnterScore, 50, 95),
    trendExitScore: clampInteger(settings.trendExitScore, 20, 80),
  };
  if (result.trendExitScore >= result.trendEnterScore) {
    result.trendExitScore = Math.max(20, result.trendEnterScore - 10);
  }
  return result;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(Number(value) || minimum)));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function aggregateHistory(timestamp: number, points: HistoryPoint[]): HistoryPoint {
  const latest = points.at(-1)!;
  const volume = points.reduce((sum, point) => sum + point.volume, 0);
  const delta = points.reduce((sum, point) => sum + point.delta, 0);
  const imbalance = points.reduce((sum, point) => sum + point.imbalance, 0) / points.length;
  return {
    timestamp,
    price: latest.price,
    volume,
    delta,
    cvd: latest.cvd,
    imbalance,
    trendScore: latest.trendScore,
    trendDirection: latest.trendDirection,
  };
}

function cloneStatus(status: StatusFrame): StatusFrame {
  return {
    ...status,
    ...(status.counters ? { counters: { ...status.counters } } : {}),
    ...(status.clockDrift ? { clockDrift: { ...status.clockDrift } } : {}),
    ...(status.checkpoint ? { checkpoint: { ...status.checkpoint } } : {}),
  };
}
