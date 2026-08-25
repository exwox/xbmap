/**
 * Phase 3 market observability aggregator.
 *
 * Owns one `MetricRegistry` implementing the Phase 0 catalog, attaches to a
 * running `MarketGateway` for counter diffs and hot-path hooks, samples
 * process health on an interval, and feeds the alert evaluator. Also retains
 * a bounded incident trail so every data-quality incident has a structured log
 * line and a Prometheus counter series.
 */

import { cpus } from "node:os";
import { getHeapStatistics } from "node:v8";
import type { MarketGateway } from "../marketGateway.js";
import type { DataQualityCounters } from "../types.js";
import { AlertEvaluator, type AlertEvent } from "./alerts.js";
import { MetricRegistry } from "./metrics.js";
import { type GatewayMetricsHooks, type IncidentKind } from "./types.js";

export interface IncidentRecord {
  at: number;
  kind: IncidentKind;
  message: string;
  category: "data-quality";
  metric: string;
  value: number;
}

export interface MarketObservabilityOptions {
  intervalMs?: number;
  maxIncidents?: number;
  memoryWarnRatio?: number;
  memoryCriticalRatio?: number;
  /** Test seam: swap the wall-clock source without changing production code. */
  now?: () => number;
  /** Test seam: inject a heap-ratio sampler instead of reading process memory. */
  memorySampler?: () => number;
}

export interface MarketObservability {
  readonly metrics: MetricRegistry;
  readonly alerts: AlertEvaluator;
  readonly incidents: IncidentRecord[];
  readonly hooks: GatewayMetricsHooks;
  attachGateway(gateway: MarketGateway): void;
  /**
   * Phase 4: hot-path hooks whose exchange/symbol labels are pinned to one
   * market session, so concurrently running gateways record metrics under
   * their own symbol instead of whichever gateway was attached last.
   * Accepts any `{ symbol, source }` view so factories can label sessions
   * while the gateway instance itself is still being constructed.
   */
  scopedHooks(gateway: Pick<MarketGateway, "symbol" | "source">): GatewayMetricsHooks;
  recordHttpRequest(method: string, route: string, status: number, durationMs: number): void;
  setClientConnections(total: number): void;
  setSubscribedClients(total: number): void;
  recordClientBuffered(bufferedBytes: number): void;
  recordFrameSent(type: string, bytes: number): void;
  recordDroppedFrame(reason: string): void;
  recordIncident(kind: IncidentKind, message: string, source?: "hot-path" | "sample"): void;
  sampleOnce(): AlertEvent[];
  start(): void;
  stop(): void;
}

interface DataQualityTotals {
  sequenceGaps: number;
  duplicates: number;
  outOfOrder: number;
  malformed: number;
  crossedBooks: number;
  resyncs: number;
  queueOverflows: number;
}

const CONNECTION_STATES = [
  "connecting", "syncing", "live", "reconnecting", "demo", "stale", "error", "closed",
] as const;

function emptyTotals(): DataQualityTotals {
  return {
    sequenceGaps: 0,
    duplicates: 0,
    outOfOrder: 0,
    malformed: 0,
    crossedBooks: 0,
    resyncs: 0,
    queueOverflows: 0,
  };
}

function differenceTotals(next: DataQualityTotals, previous: DataQualityTotals): DataQualityTotals {
  return {
    sequenceGaps: next.sequenceGaps - previous.sequenceGaps,
    duplicates: next.duplicates - previous.duplicates,
    outOfOrder: next.outOfOrder - previous.outOfOrder,
    malformed: next.malformed - previous.malformed,
    crossedBooks: next.crossedBooks - previous.crossedBooks,
    resyncs: next.resyncs - previous.resyncs,
    queueOverflows: next.queueOverflows - previous.queueOverflows,
  };
}

function dataQualityMetricName(kind: IncidentKind): string {
  switch (kind) {
    case "sequence_gap": return "orderbook_sequence_gap_total";
    case "duplicate": return "orderbook_duplicate_total";
    case "out_of_order": return "orderbook_out_of_order_total";
    case "malformed": return "market_events_rejected_total";
    case "crossed_book": return "orderbook_crossed_total";
    case "resync": return "orderbook_resync_total";
    case "queue_overflow": return "gateway_dropped_frame_total";
    case "stale": return "market_stale_duration_ms";
    case "recovered": return "market_stale_duration_ms";
  }
}

class GatewaySlot {
  current: MarketGateway | null = null;
}

type Catalog = ReturnType<typeof createCatalog>;

function createCatalog(registry: MetricRegistry) {
  return {
    received: registry.counter("market_events_received_total", "Normalized market events accepted from the feed", [
      "exchange", "symbol", "type",
    ]),
    rawRejected: registry.counter("market_events_rejected_total", "Feed events rejected before publication", [
      "exchange", "symbol", "reason",
    ]),
    seqGap: registry.counter("orderbook_sequence_gap_total", "Sequence gaps detected", ["exchange", "symbol"]),
    duplicate: registry.counter("orderbook_duplicate_total", "Duplicate events detected", ["exchange", "symbol"]),
    outOfOrder: registry.counter("orderbook_out_of_order_total", "Out-of-order events detected", ["exchange", "symbol"]),
    crossed: registry.counter("orderbook_crossed_total", "Crossed-book invariant violations", ["exchange", "symbol"]),
    resync: registry.counter("orderbook_resync_total", "Recovery resyncs", ["exchange", "symbol", "reason"]),
    drop: registry.counter("gateway_dropped_frame_total", "Frames dropped to protect the pipeline", ["reason"]),
    httpRequests: registry.counter("http_requests_total", "HTTP requests handled", ["method", "route", "status"]),
    httpErrors: registry.counter("http_errors_total", "HTTP 5xx responses", ["route"]),
    alertsEmitted: registry.counter("alerts_emitted_total", "Operational alerts fired", ["rule", "severity"]),
    wsClients: registry.gauge("websocket_clients", "Connected WebSocket clients", ["subscription"]),
    queueDepth: registry.gauge("gateway_queue_depth", "Pending ingestion queue depth", ["symbol", "queue"]),
    clockDrift: registry.gauge("market_clock_drift_ms", "Exchange-to-server clock drift", ["exchange", "symbol"]),
    rss: registry.gauge("process_rss_bytes", "Process resident set size", ["service"]),
    heapUsed: registry.gauge("process_heap_used_bytes", "JavaScript heap used bytes", ["service"]),
    cpuRatio: registry.gauge("process_cpu_ratio", "Process CPU ratio of one core", ["service"]),
    uptime: registry.gauge("process_uptime_seconds", "Process uptime", []),
    state: registry.gauge("gateway_connection_state", "Current connection state hot(1)/cold(0)", ["state"]),
    dataValid: registry.gauge("market_data_valid", "Gateway market data validity (1/0)", []),
    resyncDuration: registry.histogram(
      "orderbook_resync_duration_ms", "Time to recover a valid book", undefined, ["exchange", "symbol"],
    ),
    staleDuration: registry.histogram("market_stale_duration_ms", "Duration of invalid/stale data", undefined, [
      "exchange", "symbol",
    ]),
    processing: registry.histogram("gateway_event_processing_ms", "Per-item feed processing latency", undefined, [
      "symbol", "type",
    ]),
    frameBuild: registry.histogram("gateway_frame_build_ms", "Frame build latency", undefined, ["symbol"]),
    requestDuration: registry.histogram("http_request_duration_ms", "HTTP request latency", undefined, ["method", "route"]),
    wsBuffered: registry.histogram("websocket_buffered_bytes", "Per-client socket buffered bytes", undefined, [
      "client_tier",
    ]),
    wsFrameBytes: registry.histogram("websocket_frame_bytes", "Serialized frame bytes", undefined, ["type", "symbol"]),
  };
}

export function createMarketObservability(options: MarketObservabilityOptions = {}): MarketObservability {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 1_000;
  const maxIncidents = options.maxIncidents ?? 400;
  const memorySampler = options.memorySampler;
  const registry = new MetricRegistry();
  const metrics: Catalog = createCatalog(registry);
  const alerts = new AlertEvaluator({
    memoryWarnRatio: options.memoryWarnRatio,
    memoryCriticalRatio: options.memoryCriticalRatio,
  });
  const slot = new GatewaySlot();
  const incidents: IncidentRecord[] = [];
  let totals = emptyTotals();
  const windowState = {
    httpErrorDelta: 0,
    sequenceGapDelta: 0,
    resyncDelta: 0,
    lastSampleAt: now(),
  };
  let staleSince: number | null = null;
  let resyncStartedAt: number | null = null;
  let previousCpuUsage = process.cpuUsage();
  let previousCpuSampleAt = now();
  let timer: NodeJS.Timeout | null = null;

  const symbol = (): string => slot.current?.symbol ?? "BTCUSDT";
  const source = (): string => slot.current?.source ?? "binance";

  function recordIncident(
    kind: IncidentKind,
    message: string,
    sourceKind: "hot-path" | "sample" = "sample",
  ): void {
    incidents.push({
      at: now(),
      kind,
      message,
      category: "data-quality",
      metric: dataQualityMetricName(kind),
      value: 1,
    });
    if (incidents.length > maxIncidents) incidents.shift();
    console.info(JSON.stringify({
      level: ["stale", "sequence_gap", "crossed_book"].includes(kind) ? "warn" : "info",
      component: "observability",
      event: "incident",
      kind,
      source: sourceKind,
      message,
      at: now(),
    }));
  }

  function diffAndApplyCounters(): void {
    const quality = slot.current?.dataQuality;
    if (!quality) return;
    const counts: DataQualityCounters = quality.counters;
    const next: DataQualityTotals = {
      sequenceGaps: counts.sequenceGaps,
      duplicates: counts.duplicates,
      outOfOrder: counts.outOfOrder,
      malformed: counts.malformedEvents,
      crossedBooks: counts.crossedBooks,
      resyncs: counts.resyncs,
      queueOverflows: counts.queueOverflows,
    };
    const delta = differenceTotals(next, totals);
    totals = next;

    if (delta.sequenceGaps > 0) {
      metrics.seqGap.inc(delta.sequenceGaps, { exchange: source(), symbol: symbol() });
      windowState.sequenceGapDelta += delta.sequenceGaps;
      recordIncident("sequence_gap", `${delta.sequenceGaps} sequence gap(s) detected`);
    }
    if (delta.duplicates > 0) {
      metrics.duplicate.inc(delta.duplicates, { exchange: source(), symbol: symbol() });
      recordIncident("duplicate", `${delta.duplicates} duplicate event(s) detected`);
    }
    if (delta.outOfOrder > 0) {
      metrics.outOfOrder.inc(delta.outOfOrder, { exchange: source(), symbol: symbol() });
      recordIncident("out_of_order", `${delta.outOfOrder} out-of-order event(s) detected`);
    }
    if (delta.malformed > 0) {
      metrics.rawRejected.inc(delta.malformed, { exchange: source(), symbol: symbol(), reason: "malformed" });
      recordIncident("malformed", `${delta.malformed} malformed event(s) rejected`);
    }
    if (delta.crossedBooks > 0) {
      metrics.crossed.inc(delta.crossedBooks, { exchange: source(), symbol: symbol() });
      recordIncident("crossed_book", `${delta.crossedBooks} crossed-book invariant violation(s)`);
    }
    if (delta.resyncs > 0) {
      metrics.resync.inc(delta.resyncs, { exchange: source(), symbol: symbol(), reason: quality.reason });
      if (resyncStartedAt === null) resyncStartedAt = now();
      windowState.resyncDelta += delta.resyncs;
      recordIncident("resync", `${delta.resyncs} resync(s) started: ${quality.reason}`);
    }
    if (delta.queueOverflows > 0) {
      metrics.drop.inc(delta.queueOverflows, { reason: "queue_overflow" });
      recordIncident("queue_overflow", `${delta.queueOverflows} ingestion queue overflow(s)`);
    }
  }

  function trackStaleAndResyncDuration(): void {
    const gateway_ = slot.current;
    if (!gateway_) return;
    const quality = gateway_.dataQuality;
    const valid = quality.validity === "valid";
    if (valid) {
      if (staleSince !== null) {
        const durationMs = Math.max(0, now() - staleSince);
        metrics.staleDuration.observe(durationMs, { exchange: source(), symbol: symbol() });
        recordIncident("recovered", `Market data recovered after ${Math.round(durationMs)} ms stale`);
        staleSince = null;
      }
      if (resyncStartedAt !== null) {
        metrics.resyncDuration.observe(Math.max(0, now() - resyncStartedAt), {
          exchange: source(),
          symbol: symbol(),
        });
        resyncStartedAt = null;
      }
    } else if (staleSince === null) {
      staleSince = now();
    }
    metrics.dataValid.set(valid ? 1 : 0);
  }

  function collectProcessHealth(): void {
    const memory = process.memoryUsage();
    metrics.rss.set(memory.rss, { service: "gateway" });
    metrics.heapUsed.set(memory.heapUsed, { service: "gateway" });
    metrics.uptime.set(process.uptime());
    const sampledAt = now();
    const sampleSeconds = Math.max(0.001, (sampledAt - previousCpuSampleAt) / 1_000);
    const cpu = process.cpuUsage(previousCpuUsage);
    previousCpuUsage = process.cpuUsage();
    previousCpuSampleAt = sampledAt;
    const cores = Math.max(1, cpus().length);
    metrics.cpuRatio.set((cpu.user + cpu.system) / 1_000_000 / sampleSeconds / cores, {
      service: "gateway",
    });
  }

  function collectGatewayState(): void {
    const gateway_ = slot.current;
    if (!gateway_) return;
    const status = gateway_.status;
    for (const state of CONNECTION_STATES) {
      metrics.state.set(status.state === state ? 1 : 0, { state });
    }
    const driftMs = gateway_.dataQuality.clockDrift.latestMs;
    if (driftMs !== null) metrics.clockDrift.set(driftMs, { exchange: source(), symbol: symbol() });
    const capture = gateway_.captureStatus;
    if (capture.enabled) metrics.queueDepth.set(capture.queuedRecords, { symbol: symbol(), queue: "raw-capture" });
    const history = gateway_.historyStatus;
    if (history.enabled) metrics.queueDepth.set(history.writer.pendingRecords, { symbol: symbol(), queue: "history" });
  }

  function heapRatio(): number {
    if (memorySampler) return memorySampler();
    const stats = getHeapStatistics();
    if (Number.isFinite(stats.heap_size_limit) && stats.heap_size_limit > 0) {
      return stats.used_heap_size / stats.heap_size_limit;
    }
    return 0;
  }

  function evaluateAlerts(): AlertEvent[] {
    const gateway_ = slot.current;
    const staleMs = staleSince === null ? null : Math.max(0, now() - staleSince);
    const elapsedSeconds = Math.max(0.001, (now() - windowState.lastSampleAt) / 1_000);
    const fired = alerts.evaluate({
      staleMs,
      staleAfterMs: gateway_?.settings.staleAfterMs ?? 3_000,
      httpErrorDelta: windowState.httpErrorDelta,
      windowSeconds: elapsedSeconds,
      sequenceGapDelta: windowState.sequenceGapDelta,
      resyncDelta: windowState.resyncDelta,
      memoryRatio: heapRatio(),
      memoryWarnRatio: alerts.memoryWarnRatio,
      memoryCriticalRatio: alerts.memoryCriticalRatio,
      httpErrorRatePerSecond: alerts.httpErrorRatePerSecond,
      resyncStormThreshold: alerts.resyncStormThreshold,
    });
    for (const event of fired) metrics.alertsEmitted.inc(1, { rule: event.rule, severity: event.severity });
    windowState.httpErrorDelta = 0;
    windowState.sequenceGapDelta = 0;
    windowState.resyncDelta = 0;
    windowState.lastSampleAt = now();
    return fired;
  }

  function sampleOnce(): AlertEvent[] {
    diffAndApplyCounters();
    trackStaleAndResyncDuration();
    collectProcessHealth();
    collectGatewayState();
    return evaluateAlerts();
  }

  function attachGateway(gateway_: MarketGateway): void {
    slot.current = gateway_;
  }

  function recordHttpRequest(method: string, route: string, status: number, durationMs: number): void {
    metrics.httpRequests.inc(1, { method, route, status: String(status) });
    metrics.requestDuration.observe(durationMs, { method, route });
    if (status >= 500) {
      metrics.httpErrors.inc(1, { route });
      windowState.httpErrorDelta += 1;
    }
  }

  function setClientConnections(total: number): void {
    metrics.wsClients.set(total, { subscription: "total" });
  }

  function setSubscribedClients(total: number): void {
    metrics.wsClients.set(total, { subscription: "subscribed" });
  }

  function recordClientBuffered(bufferedBytes: number): void {
    const tier = bufferedBytes > 1_048_576 ? "overloaded" : bufferedBytes > 262_144 ? "high" : "normal";
    metrics.wsBuffered.observe(bufferedBytes, { client_tier: tier });
  }

  function recordFrameSent(type: string, bytes: number): void {
    metrics.wsFrameBytes.observe(bytes, { type, symbol: symbol() });
  }

  function recordDroppedFrame(reason: string): void {
    metrics.drop.inc(1, { reason });
    recordIncident("queue_overflow", `Client frame dropped: ${reason}`, "sample");
  }

  const hooks: GatewayMetricsHooks = {
    received: (type: string) => metrics.received.inc(1, { exchange: source(), symbol: symbol(), type }),
    rejected: (reason: string) => metrics.rawRejected.inc(1, { exchange: source(), symbol: symbol(), reason }),
    processed: (type: string, durationMs: number) => {
      metrics.processing.observe(durationMs, { symbol: symbol(), type });
    },
    frameBuilt: (durationMs: number) => metrics.frameBuild.observe(durationMs, { symbol: symbol() }),
    incident: (kind: IncidentKind, reason?: string) => recordIncident(kind, reason ?? kind, "hot-path"),
  };

  function scopedHooks(gateway_: Pick<MarketGateway, "symbol" | "source">): GatewayMetricsHooks {
    const pinnedSymbol = gateway_.symbol;
    return {
      received: (type: string) =>
        metrics.received.inc(1, { exchange: gateway_.source, symbol: pinnedSymbol, type }),
      rejected: (reason: string) =>
        metrics.rawRejected.inc(1, { exchange: gateway_.source, symbol: pinnedSymbol, reason }),
      processed: (type: string, durationMs: number) => {
        metrics.processing.observe(durationMs, { symbol: pinnedSymbol, type });
      },
      frameBuilt: (durationMs: number) =>
        metrics.frameBuild.observe(durationMs, { symbol: pinnedSymbol }),
      incident: (kind: IncidentKind, reason?: string) => recordIncident(kind, reason ?? kind, "hot-path"),
    };
  }

  return {
    metrics: registry,
    alerts,
    incidents,
    hooks,
    attachGateway,
    scopedHooks,
    recordHttpRequest,
    setClientConnections,
    setSubscribedClients,
    recordClientBuffered,
    recordFrameSent,
    recordDroppedFrame,
    recordIncident,
    sampleOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => { void sampleOnce(); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}