import { createServer, type Server as HttpServer } from "node:http";
import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import WebSocket, { WebSocketServer } from "ws";
import { MarketGateway } from "./marketGateway.js";
import {
  RawReplayValidationError,
  type RawReplayRuntime,
} from "./replayRuntime.js";
import { HistoryQueryLimitError } from "./storage/index.js";
import {
  DEFAULT_EXCHANGE,
  DEFAULT_SYMBOL,
  SCHEMA_VERSION,
  type ClientMessage,
  type GatewaySettings,
  type ServerEnvelope,
  type ServerEventType,
} from "./types.js";
import { INSTRUMENTS, instrumentFor, isSupportedSymbol, supportedSymbols } from "./instruments.js";
import { InsightsRuntime, ALERT_ALGO_VERSION, SIGNAL_HORIZONS_MS } from "./insights/insightsRuntime.js";
import type { AlertKind } from "./alerts/alertEngine.js";
import {
  MarketSessionManager,
  SessionCapacityError,
  UnknownSymbolError,
  type SessionStatus,
} from "./marketSessionManager.js";
import { getTracer, initTracing } from "./observability/tracing.js";
import {
  createMarketObservability,
  type MarketObservability,
} from "./observability/index.js";

/** Phase 4: minimal session registry contract shared by both server modes. */
export interface SessionRegistry {
  acquire(symbol: string): MarketGateway;
  release(symbol: string): void;
  get(symbol: string): MarketGateway | null;
  has(symbol: string): boolean;
  list(): SessionStatus[];
  drain(): Promise<void>;
}

/**
 * Backward-compatible registry for callers that still inject a single
 * pre-built gateway. Only that gateway's symbol resolves; everything else
 * raises `UnknownSymbolError`, matching the previous MVP behaviour.
 */
class SingleSymbolSessions implements SessionRegistry {
  constructor(private readonly gateway: MarketGateway) {}

  acquire(symbol: string): MarketGateway {
    const normalized = symbol.trim().toUpperCase();
    if (normalized !== this.gateway.symbol) {
      throw new UnknownSymbolError(`Unsupported symbol: ${symbol}`);
    }
    return this.gateway;
  }

  release(): void {
    // Lifecycle of an injected gateway belongs to the caller (start/close).
  }

  get(symbol: string): MarketGateway | null {
    return symbol.trim().toUpperCase() === this.gateway.symbol ? this.gateway : null;
  }

  has(symbol: string): boolean {
    return this.get(symbol) !== null;
  }

  list(): SessionStatus[] {
    return [{
      symbol: this.gateway.symbol,
      refCount: 1,
      running: Boolean(this.gateway.status.sessionId),
      evictAtMs: null,
    }];
  }

  async drain(): Promise<void> {
    // The close path shuts the injected gateway down explicitly.
  }
}

export interface MarketHttpServerOptions {
  /**
   * Phase 4 multi-symbol mode. When provided, WebSocket subscriptions may
   * reference every registered instrument and market sessions start/stop
   * lazily with client demand. When omitted the injected single gateway
   * keeps its original behaviour.
   */
  sessions?: MarketSessionManager;
  /** Maximum simultaneously subscribed symbols per WebSocket client. */
  maxSubscriptionsPerClient?: number;
  /**
   * Phase 5 analytics/alerts runtime. When omitted a default runtime is
   * created (rules live in memory only); production supplies one wired to the
   * rules file and delivery channels.
   */
  insights?: InsightsRuntime;
}

interface RealtimeClient {
  socket: WebSocket;
  id: string;
  /** Symbols this connection currently receives frames for. */
  subscriptions: Set<string>;
  depth: number;
  alive: boolean;
  droppedFrames: number;
  deliverySequence: number;
}

export interface MarketHttpServer {
  app: express.Express;
  server: HttpServer;
  gateway: MarketGateway;
  websocketServer: WebSocketServer;
  rawReplay: RawReplayRuntime | null;
  observability: MarketObservability;
  sessions: SessionRegistry;
  close: () => Promise<void>;
}

function maxSubscriptionsFromEnvironment(value: number | undefined): number {
  const parsed = Number(process.env.XBMAP_MAX_SUBSCRIPTIONS_PER_CLIENT);
  if (value !== undefined) return Math.max(1, Math.min(10, Math.round(value)));
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? Math.min(10, parsed)
    : 3;
}

export function createMarketHttpServer(
  gateway = new MarketGateway(),
  rawReplay: RawReplayRuntime | null = null,
  observability = createMarketObservability(),
  options: MarketHttpServerOptions = {},
): MarketHttpServer {
  const app = express();
  // Idempotent: the first call wins, so tests can inject a custom tracer via
  // initTracing before creating additional servers.
  if (!getTracer()) initTracing();
  const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGIN);
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.use(cors({
    origin: allowedOrigins.length === 0
      ? true
      : (origin, callback) => callback(
          origin === undefined || allowedOrigins.includes(origin)
            ? null
            : new Error("Origin not allowed"),
          origin === undefined || allowedOrigins.includes(origin),
        ),
    methods: ["GET", "PUT", "POST", "PATCH", "DELETE", "OPTIONS"],
  }));
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use("/api/v1", createRateLimiter(240, 60_000));
  observability.attachGateway(gateway);

  // Phase 4: route market data through a session registry. Callers either
  // inject a multi-symbol MarketSessionManager or keep the legacy single
  // gateway contract.
  const sessions: SessionRegistry = options.sessions ?? new SingleSymbolSessions(gateway);
  const maxSubscriptionsPerClient = maxSubscriptionsFromEnvironment(options.maxSubscriptionsPerClient);
  if (options.sessions && !options.sessions.has(gateway.symbol)) {
    options.sessions.register(gateway);
  }
  const insights = options.insights ?? new InsightsRuntime();
  const attachSessionEvents = (sessionGateway: MarketGateway) => {
    sessionGateway.on("event", onGatewayEvent);
    sessionGateway.on("event", (envelope) => insights.handleGatewayEvent(envelope));
    insights.ensureSession(sessionGateway.symbol, instrumentFor(sessionGateway.symbol).tickSize);
  };

  /** Active session lookup used by REST handlers; null when not running. */
  const activeSessionFor = (symbol: string): MarketGateway | null =>
    sessions.get(symbol.trim().toUpperCase());

  /** Parses `?symbol=`; responds and returns null on unsupported markets. */
  const resolveSymbolQuery = (request: Request, response: Response): string | null => {
    const raw = request.query.symbol;
    const symbol = (typeof raw === "string" ? raw : DEFAULT_SYMBOL).trim().toUpperCase();
    if (!isSupportedSymbol(symbol)) {
      sendError(response, 404, "UNSUPPORTED_MARKET", `Unsupported symbol: ${raw ?? symbol}`);
      return null;
    }
    return instrumentFor(symbol).symbol;
  };

  app.use((request, response, next) => {
    const started = performance.now();
    const tracer = getTracer();
    const span = tracer?.startSpan(`http ${request.method} ${request.path}`, {
      attributes: { "http.method": request.method, "http.route": request.path },
    });
    response.once("finish", () => {
      observability.recordHttpRequest(
        request.method,
        request.path,
        response.statusCode,
        performance.now() - started,
      );
      span?.end(response.statusCode < 500 ? "ok" : "error", { "http.status_code": response.statusCode });
    });
    next();
  });

  app.get("/api/v1/health/live", (_request, response) => {
    response.json({
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      serverTimestamp: Date.now(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get("/api/v1/health/ready", (_request, response) => {
    // Phase 4: readiness aggregates every active market session. A server
    // with zero sessions is ready to accept subscribers; any session in an
    // unhealthy state fails the probe with the failing symbols listed.
    const activeGateways = sessions.list()
      .map((session) => sessions.get(session.symbol))
      .filter((entry): entry is MarketGateway => entry !== null);
    const checks = activeGateways.map((sessionGateway) => ({
      symbol: sessionGateway.symbol,
      ...isGatewayReady(sessionGateway),
    }));
    const failing = checks.filter((check) => !check.ready).map((check) => check.symbol);
    const ready = failing.length === 0;
    response.status(ready ? 200 : 503).json({
      ok: ready,
      schemaVersion: SCHEMA_VERSION,
      serverTimestamp: Date.now(),
      activeSessions: checks.length,
      failingSymbols: failing,
      reason: ready
        ? activeGateways.length === 0
          ? "no active market sessions; accepting subscribers"
          : "serving"
        : `unhealthy sessions: ${failing.join(", ")}`,
      sessions: checks,
    });
  });

  app.get("/api/v1/observability/alerts", (_request, response) => {
    response.json({
      schemaVersion: SCHEMA_VERSION,
      serverTimestamp: Date.now(),
      ...observability.alerts.snapshot(),
    });
  });

  app.get("/api/v1/observability/incidents", (_request, response) => {
    response.json({
      schemaVersion: SCHEMA_VERSION,
      serverTimestamp: Date.now(),
      incidentCount: observability.incidents.length,
      incidents: observability.incidents.slice(-100).reverse(),
    });
  });

  app.get("/metrics", (_request, response) => {
    response
      .status(200)
      .setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
      .setHeader("Cache-Control", "no-store")
      .send(observability.metrics.render());
  });

  app.get("/api/v1/health", (_request, response) => {
    const status = gateway.status;
    const quality = gateway.dataQuality;
    const memory = process.memoryUsage();
    response.json({
      ok: status.state !== "error" && status.state !== "closed",
      schemaVersion: SCHEMA_VERSION,
      serverTimestamp: Date.now(),
      uptimeSeconds: Math.round(process.uptime()),
      source: gateway.source,
      status,
      quality,
      capture: gateway.captureStatus,
      history: gateway.historyStatus,
      rawReplay: rawReplay?.status ?? { enabled: false },
      sessions: sessions.list(),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      },
    });
  });

  app.get("/api/v1/markets", (_request, response) => {
    const now = Date.now();
    response.json({
      schemaVersion: SCHEMA_VERSION,
      serverTimestamp: now,
      exchange: DEFAULT_EXCHANGE,
      markets: INSTRUMENTS.map((instrument) => {
        const sessionGateway = sessions.get(instrument.symbol);
        return {
          exchange: DEFAULT_EXCHANGE,
          symbol: instrument.symbol,
          displaySymbol: `${instrument.base}/${instrument.quote} Perpetual`,
          base: instrument.base,
          quote: instrument.quote,
          marketType: "perpetual",
          tickSize: sessionGateway?.tickSize ?? instrument.tickSize,
          quantityStep: 0.001,
          source: sessionGateway?.source ?? null,
          available: true,
          active: sessionGateway !== null,
        };
      }),
    });
  });

  app.get("/api/v1/snapshot", (request, response) => {
    const symbol = resolveSymbolQuery(request, response);
    if (symbol === null) return;
    const sessionGateway = sessions.get(symbol);
    if (!sessionGateway) {
      sendError(response, 409, "SYMBOL_NOT_ACTIVE", `No active market session for ${symbol}; subscribe via /ws first`);
      return;
    }
    if (!sessionGateway.isMarketDataValid) {
      sendError(response, 503, "BOOK_NOT_READY", "Order book is syncing or invalid");
      return;
    }
    const depth = parseBoundedInteger(request.query.depth, sessionGateway.settings.visibleDepth, 10, 200);
    response.json(sessionGateway.getSnapshot(depth));
  });

  app.get("/api/v1/history", async (request, response) => {
    const symbol = resolveSymbolQuery(request, response);
    if (symbol === null) return;
    const sessionGateway = sessions.get(symbol);
    if (!sessionGateway) {
      sendError(response, 409, "SYMBOL_NOT_ACTIVE", `No active market session for ${symbol}; subscribe via /ws first`);
      return;
    }
    const now = Date.now();
    const from = parseTimestamp(request.query.from, now - 5 * 60_000);
    const to = parseTimestamp(request.query.to, now);
    if (from > to) {
      sendError(response, 400, "INVALID_RANGE", "from must be before to");
      return;
    }
    const requestedResolutionMs = parseResolution(request.query.resolution);
    const resolutionMs = sessionGateway.historyResolution(requestedResolutionMs);
    const queryLimit = historyQueryLimit();
    if (!withinHistoryBudget(from, to, resolutionMs, queryLimit)) {
      sendError(
        response,
        413,
        "HISTORY_QUERY_LIMIT",
        `Query exceeds ${queryLimit} points or the configured time range`,
      );
      return;
    }
    const items = await sessionGateway.getHistory(from, to, resolutionMs, queryLimit);
    response.json({
      schemaVersion: SCHEMA_VERSION,
      exchange: DEFAULT_EXCHANGE,
      symbol: sessionGateway.symbol,
      from,
      to,
      resolutionMs,
      items,
    });
  });

  const settingsGateway = (request: Request): MarketGateway => {
    const raw = request.query.symbol;
    if (typeof raw !== "string" || raw.trim().length === 0) return gateway;
    return activeSessionFor(raw) ?? gateway;
  };

  app.get("/api/v1/settings", (request, response) => {
    response.json({ schemaVersion: SCHEMA_VERSION, symbol: settingsGateway(request).symbol, settings: settingsGateway(request).settings });
  });

  app.put("/api/v1/settings", (request, response) => {
    if (!isPlainObject(request.body)) {
      sendError(response, 400, "INVALID_SETTINGS", "JSON object required");
      return;
    }
    const allowed: Array<keyof GatewaySettings> = [
      "frameIntervalMs",
      "bubbleBucketMs",
      "visibleDepth",
      "staleAfterMs",
      "demoFallbackAfterMs",
      "trendEnterScore",
      "trendExitScore",
    ];
    const patch: Partial<GatewaySettings> = {};
    for (const key of allowed) {
      if (!(key in request.body)) continue;
      const value = request.body[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        sendError(response, 400, "INVALID_SETTINGS", `${key} must be a finite number`);
        return;
      }
      patch[key] = value;
    }
    const target = settingsGateway(request);
    response.json({ schemaVersion: SCHEMA_VERSION, symbol: target.symbol, settings: target.updateSettings(patch) });
  });

  // ── Phase 5: alerts & advanced analytics surface ──────────────────────────

  app.get("/api/v1/alerts/rules", (_request, response) => {
    response.json({
      schemaVersion: SCHEMA_VERSION,
      serverTimestamp: Date.now(),
      algoVersion: ALERT_ALGO_VERSION,
      shadowMode: insights.alertEngine.shadowMode,
      horizonsMs: [...SIGNAL_HORIZONS_MS],
      baselines: insights.alertEngine.baselinesSummary(),
      rules: insights.alertEngine.listRules(),
    });
  });

  app.post("/api/v1/alerts/rules", (request, response) => {
    if (!isPlainObject(request.body)) {
      sendError(response, 400, "INVALID_ALERT_RULE", "JSON object required");
      return;
    }
    try {
      const rule = insights.alertEngine.createRule(request.body);
      response.status(201).json({ schemaVersion: SCHEMA_VERSION, rule });
    } catch (error) {
      sendError(response, 400, "INVALID_ALERT_RULE",
        error instanceof Error ? error.message : "Invalid alert rule");
    }
  });

  app.patch("/api/v1/alerts/rules/:id", (request, response) => {
    const body = isPlainObject(request.body) ? request.body : {};
    const rule = insights.alertEngine.updateRule(String(request.params.id), body);
    if (!rule) {
      sendError(response, 404, "ALERT_RULE_NOT_FOUND", `No alert rule ${String(request.params.id)}`);
      return;
    }
    response.json({ schemaVersion: SCHEMA_VERSION, rule });
  });

  app.delete("/api/v1/alerts/rules/:id", (request, response) => {
    const deleted = insights.alertEngine.deleteRule(String(request.params.id));
    if (!deleted) {
      sendError(response, 404, "ALERT_RULE_NOT_FOUND", `No alert rule ${String(request.params.id)}`);
      return;
    }
    response.status(204).send();
  });

  app.get("/api/v1/alerts/events", (request, response) => {
    const limit = parseBoundedInteger(request.query.limit, 100, 1, 500);
    response.json({
      schemaVersion: SCHEMA_VERSION,
      serverTimestamp: Date.now(),
      events: insights.alertEngine.auditTrail(limit),
    });
  });

  app.get("/api/v1/signals/performance", (request, response) => {
    const symbol = typeof request.query.symbol === "string"
      ? request.query.symbol.trim().toUpperCase()
      : undefined;
    const kind = typeof request.query.kind === "string"
      ? request.query.kind
      : undefined;
    try {
      const rows = insights.alertEngine.performance({
        ...(symbol ? { symbol } : {}),
        ...(kind ? { kind: kind as AlertKind } : {}),
      });
      response.json({
        schemaVersion: SCHEMA_VERSION,
        serverTimestamp: Date.now(),
        algoVersion: ALERT_ALGO_VERSION,
        horizonsMs: [...SIGNAL_HORIZONS_MS],
        rows,
      });
    } catch (error) {
      sendError(response, 400, "INVALID_REQUEST",
        error instanceof Error ? error.message : "Invalid performance filter");
    }
  });

  app.get("/api/v1/insights", (request, response) => {
    const symbol = resolveSymbolQuery(request, response);
    if (symbol === null) return;
    const insight = insights.currentInsight(symbol);
    if (!insight) {
      sendError(response, 409, "SYMBOL_NOT_ACTIVE", `No active market session for ${symbol}`);
      return;
    }
    response.json({
      schemaVersion: SCHEMA_VERSION,
      serverTimestamp: Date.now(),
      symbol,
      insight,
    });
  });

  app.post("/api/v1/replay/session", async (request, response) => {
    const body = isPlainObject(request.body) ? request.body : {};
    const now = Date.now();
    const to = optionalTimestamp(body.to) ?? now;
    const from = optionalTimestamp(body.from) ?? to - 5 * 60_000;
    const requestedResolutionMs = parseResolution(body.resolution);
    const resolutionMs = gateway.historyResolution(requestedResolutionMs);
    if (from > to) {
      sendError(response, 400, "INVALID_RANGE", "from must be before to");
      return;
    }
    if (!withinHistoryBudget(from, to, resolutionMs, historyQueryLimit())) {
      sendError(response, 413, "REPLAY_QUERY_LIMIT", "Replay range exceeds the bounded query budget");
      return;
    }
    const session = await gateway.createReplaySession({
      from,
      to,
      speed: optionalFinite(body.speed),
      resolutionMs,
    });
    response.status(201).json({
      schemaVersion: SCHEMA_VERSION,
      session: {
        id: session.id,
        symbol: session.symbol,
        from: session.from,
        to: session.to,
        speed: session.speed,
        frameCount: session.frames.length,
        expiresAt: session.expiresAt,
        framesUrl: `/api/v1/replay/session/${session.id}`,
      },
    });
  });

  app.get("/api/v1/replay/session/:id", (request, response) => {
    const session = gateway.getReplaySession(request.params.id);
    if (!session) {
      sendError(response, 404, "REPLAY_NOT_FOUND", "Replay session was not found or expired");
      return;
    }
    response.json({ schemaVersion: SCHEMA_VERSION, session });
  });

  app.get("/api/v1/replay/raw/captures", async (_request, response) => {
    if (!rawReplay) {
      sendError(response, 503, "RAW_REPLAY_DISABLED", "Configure XBMAP_CAPTURE_DIR to enable raw replay");
      return;
    }
    response.json({ schemaVersion: SCHEMA_VERSION, ...(await rawReplay.listCaptures()) });
  });

  app.post(
    "/api/v1/replay/raw/captures/:id/verify",
    createRateLimiter(10, 60_000),
    async (request, response) => {
      if (!rawReplay) {
        sendError(response, 503, "RAW_REPLAY_DISABLED", "Configure XBMAP_CAPTURE_DIR to enable raw replay");
        return;
      }
      const captureId = Array.isArray(request.params.id) ? request.params.id[0]! : request.params.id;
      const capture = rawReplay.catalog.get(captureId);
      if (!capture) {
        await rawReplay.catalog.refresh();
        if (!rawReplay.catalog.get(captureId)) {
          sendError(response, 404, "CAPTURE_NOT_FOUND", "Raw capture was not found");
          return;
        }
      }
      response.json({ schemaVersion: SCHEMA_VERSION, result: await rawReplay.verify(captureId) });
    },
  );

  app.post("/api/v1/replay/raw/session", async (request, response) => {
    if (!rawReplay) {
      sendError(response, 503, "RAW_REPLAY_DISABLED", "Configure XBMAP_CAPTURE_DIR to enable raw replay");
      return;
    }
    const body = isPlainObject(request.body) ? request.body : {};
    const from = optionalTimestamp(body.from);
    const to = optionalTimestamp(body.to);
    if (from === undefined || to === undefined || from > to) {
      sendError(response, 400, "INVALID_RANGE", "Raw replay requires finite from/to timestamps");
      return;
    }
    const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase() : gateway.symbol;
    const captureId = typeof body.captureId === "string" ? body.captureId.trim() : "";
    if (!captureId) {
      sendError(response, 400, "CAPTURE_REQUIRED", "Raw replay requires one captureId");
      return;
    }
    await rawReplay.catalog.refresh();
    const capture = rawReplay.catalog.get(captureId);
    if (!capture
      || !capture.complete
      || capture.symbol !== symbol
      || capture.closedAt < from
      || capture.startedAt > to) {
      sendError(response, 404, "CAPTURE_NOT_FOUND", "No complete raw capture covers this range");
      return;
    }
    const session = await rawReplay.manager.create({
      symbol,
      captureId,
      from: Math.trunc(from),
      to: Math.trunc(to),
      speed: optionalFinite(body.speed),
      autoplay: body.autoplay === true,
    });
    response.status(201).json({ schemaVersion: SCHEMA_VERSION, session });
  });

  app.get("/api/v1/replay/raw/session/:id", async (request, response) => {
    if (!rawReplay) {
      sendError(response, 503, "RAW_REPLAY_DISABLED", "Raw replay is disabled");
      return;
    }
    const session = await rawReplay.manager.get(request.params.id);
    if (!session) {
      sendError(response, 404, "REPLAY_NOT_FOUND", "Raw replay session was not found or expired");
      return;
    }
    response.json({ schemaVersion: SCHEMA_VERSION, session });
  });

  app.patch("/api/v1/replay/raw/session/:id", async (request, response) => {
    if (!rawReplay) {
      sendError(response, 503, "RAW_REPLAY_DISABLED", "Raw replay is disabled");
      return;
    }
    const body = isPlainObject(request.body) ? request.body : {};
    const action = body.action;
    let session;
    try {
      if (action === "pause") session = await rawReplay.manager.pause(request.params.id);
      else if (action === "resume") session = await rawReplay.manager.resume(request.params.id);
      else if (action === "seek" && optionalTimestamp(body.timestamp) !== undefined) {
        session = await rawReplay.manager.seek(request.params.id, optionalTimestamp(body.timestamp)!);
      } else if (action === "speed" && optionalFinite(body.speed) !== undefined) {
        session = await rawReplay.manager.setSpeed(request.params.id, optionalFinite(body.speed)!);
      } else {
        sendError(response, 400, "INVALID_REPLAY_ACTION", "Use pause, resume, seek, or speed");
        return;
      }
    } catch (error) {
      if (isMissingReplaySession(error)) {
        sendError(response, 404, "REPLAY_NOT_FOUND", "Raw replay session was not found or expired");
        return;
      }
      throw error;
    }
    response.json({ schemaVersion: SCHEMA_VERSION, session });
  });

  app.get("/api/v1/replay/raw/session/:id/frames", async (request, response) => {
    if (!rawReplay) {
      sendError(response, 503, "RAW_REPLAY_DISABLED", "Raw replay is disabled");
      return;
    }
    try {
      const result = await rawReplay.manager.read(request.params.id, {
        limit: parseBoundedInteger(request.query.limit, 1_000, 1, 5_000),
        // Full-book delivery: after a seek the first page opens with the
        // anchoring snapshot plus its depth deltas (flagged `preroll: true`).
        preRoll: true,
      });
      response.json({ schemaVersion: SCHEMA_VERSION, result: rawReplay.safeRead(result) });
    } catch (error) {
      if (isMissingReplaySession(error)) {
        sendError(response, 404, "REPLAY_NOT_FOUND", "Raw replay session was not found or expired");
        return;
      }
      throw error;
    }
  });

  app.delete("/api/v1/replay/raw/session/:id", async (request, response) => {
    if (!rawReplay) {
      sendError(response, 503, "RAW_REPLAY_DISABLED", "Raw replay is disabled");
      return;
    }
    const removed = await rawReplay.manager.delete(request.params.id);
    if (!removed) {
      sendError(response, 404, "REPLAY_NOT_FOUND", "Raw replay session was not found or expired");
      return;
    }
    response.status(204).end();
  });

  app.use("/api", (_request, response) => {
    sendError(response, 404, "NOT_FOUND", "API route not found");
  });

  mountStaticApplication(app);
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof RawReplayValidationError) {
      sendError(response, 422, "CAPTURE_NOT_REPLAYABLE", error.message);
      return;
    }
    if (error instanceof HistoryQueryLimitError) {
      sendError(response, 413, `HISTORY_${error.code}`, error.message);
      return;
    }
    if (error instanceof RangeError || error instanceof TypeError) {
      sendError(response, error instanceof RangeError ? 413 : 400, "INVALID_REQUEST", error.message);
      return;
    }
    const message = error instanceof Error ? error.message : "Unexpected server error";
    console.error(JSON.stringify({ level: "error", component: "http", message }));
    if (!response.headersSent) sendError(response, 500, "INTERNAL_ERROR", "Internal server error");
  });

  const server = createServer(app);
  const websocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
  });
  const clients = new Set<RealtimeClient>();
  let closing = false;
  let closePromise: Promise<void> | null = null;

  server.on("upgrade", (request, socket, head) => {
    if (closing) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  /** Releases every symbol reference held by a client connection. */
  const releaseClientSubscriptions = (client: RealtimeClient): void => {
    for (const symbol of client.subscriptions) sessions.release(symbol);
    client.subscriptions.clear();
  };

  websocketServer.on("connection", (socket) => {
    const client: RealtimeClient = {
      socket,
      id: cryptoRandomId(),
      subscriptions: new Set<string>(),
      depth: gateway.settings.visibleDepth,
      alive: true,
      droppedFrames: 0,
      deliverySequence: 0,
    };
    clients.add(client);
    observability.setClientConnections(clients.size);
    socket.on("pong", () => { client.alive = true; });
    socket.on("error", () => {
      releaseClientSubscriptions(client);
      clients.delete(client);
      updateClientGauges();
    });
    socket.on("close", () => {
      releaseClientSubscriptions(client);
      clients.delete(client);
      updateClientGauges();
    });
    socket.on("message", (raw) => {
      try {
        handleClientMessage(client, raw.toString(), {
          sessions,
          clients,
          observability,
          maxSubscriptionsPerClient,
          refreshGauges: updateClientGauges,
        });
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          component: "ws",
          message: error instanceof Error ? error.message : String(error),
        }));
        send(client, gateway.createEvent("error", {
          code: "INTERNAL_ERROR",
          message: "Failed to process the request",
        }));
      }
    });
    // Greet the connection with the default market status when its session is
    // already running; otherwise the subscribe ack carries the first status.
    const initial = activeSessionFor(DEFAULT_SYMBOL) ?? gateway;
    if (initial.status.sessionId) send(client, initial.createEvent("status", initial.status));
  });

  function updateClientGauges(): void {
    observability.setClientConnections(clients.size);
    let subscriptionCount = 0;
    for (const client of clients) subscriptionCount += client.subscriptions.size;
    observability.setSubscribedClients(subscriptionCount);
  }

  const onGatewayEvent = (event: ServerEnvelope) => {
    // Phase 4: frames carry their market symbol; only connections currently
    // subscribed to that symbol may receive them, keeping books isolated.
    const eventSymbol = typeof event.symbol === "string" ? event.symbol.toUpperCase() : "";
    for (const client of clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (!eventSymbol || !client.subscriptions.has(eventSymbol)) continue;
      observability.recordClientBuffered(client.socket.bufferedAmount);
      if (client.socket.bufferedAmount > 8 * 1024 * 1024) {
        observability.recordDroppedFrame("buffered_amount_limit");
        client.socket.close(1013, "Client cannot keep up with market data");
        continue;
      }
      if (
        client.socket.bufferedAmount > 1 * 1024 * 1024 &&
        ["depth_frame", "metric", "price"].includes(event.type)
      ) {
        client.droppedFrames += 1;
        observability.recordDroppedFrame("slow_client");
        continue;
      }
      send(client, trimDepth(event, client.depth), (type, bytes) => {
        observability.recordFrameSent(type, bytes);
      });
    }
  };

  // Late-bind session events: fires immediately for already-registered
  // sessions and for every lazily created one afterwards. The legacy
  // single-gateway mode attaches directly so its stream keeps flowing.
  if (options.sessions) options.sessions.setOnSessionCreated(attachSessionEvents);
  else attachSessionEvents(gateway);

  // Phase 5: one cadence step per second publishes insight frames and any
  // deliverable alert envelopes through the same subscriber broadcast path.
  insights.setPublisher(onGatewayEvent);
  const insightsTimer = setInterval(() => {
    try {
      for (const envelope of insights.tick()) onGatewayEvent(envelope);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        component: "insights",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }, 1_000);
  insightsTimer.unref?.();

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        releaseClientSubscriptions(client);
        clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
      if (client.subscriptions.size > 0) {
        send(client, gateway.createEvent("heartbeat", {
          clientId: client.id,
          uptimeMs: Math.round(process.uptime() * 1_000),
          droppedFrames: client.droppedFrames,
        }));
      }
    }
    updateClientGauges();
  }, 15_000);
  heartbeat.unref?.();

  if (!options.sessions) gateway.start();

  return {
    app,
    server,
    gateway,
    websocketServer,
    rawReplay,
    observability,
    sessions,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closing = true;
        clearInterval(heartbeat);
        clearInterval(insightsTimer);
        observability.stop();
        // Flush durable history/capture buffers for every market session
        // while gateway listeners and client sockets are still attached.
        await sessions.drain();
        if (!options.sessions) await gateway.shutdown();
        rawReplay?.close();
        const httpClosed = closeHttpServer(server);
        await closeRealtimeServer(websocketServer, clients);
        await httpClosed;
      })();
      return closePromise;
    },
  };
}

interface ClientMessageContext {
  sessions: SessionRegistry;
  clients: Set<RealtimeClient>;
  observability: MarketObservability;
  maxSubscriptionsPerClient: number;
  refreshGauges: () => void;
}

function handleClientMessage(
  client: RealtimeClient,
  raw: string,
  context: ClientMessageContext,
): void {
  const { sessions, maxSubscriptionsPerClient, refreshGauges } = context;
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    send(client, errorEnvelope(sessions, "INVALID_JSON", "WebSocket message must be valid JSON"));
    return;
  }
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    send(client, errorEnvelope(sessions, "INVALID_MESSAGE", "Message type is required"));
    return;
  }

  if (message.type === "subscribe") {
    const exchange = (message.exchange ?? DEFAULT_EXCHANGE).toLowerCase();
    const symbol = (message.symbol ?? DEFAULT_SYMBOL).trim().toUpperCase();
    if (exchange !== DEFAULT_EXCHANGE || !isSupportedSymbol(symbol)) {
      send(client, errorEnvelope(
        sessions,
        "UNSUPPORTED_MARKET",
        `${DEFAULT_EXCHANGE}:${symbol} is not supported; available symbols: ${instrumentList().join(", ")}`,
      ));
      return;
    }
    let sessionGateway: MarketGateway;
    try {
      sessionGateway = sessions.acquire(symbol);
    } catch (error) {
      if (error instanceof SessionCapacityError) {
        send(client, errorEnvelope(
          sessions,
          "SESSION_CAPACITY",
          "Market session limit reached; release another symbol first",
        ));
      } else {
        send(client, errorEnvelope(sessions, "UNSUPPORTED_MARKET", error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    const alreadySubscribed = client.subscriptions.has(symbol);
    if (!alreadySubscribed && client.subscriptions.size >= maxSubscriptionsPerClient) {
      // Balance the acquire above so rejected upgrades never leak references.
      sessions.release(symbol);
      send(client, errorEnvelope(
        sessions,
        "SUBSCRIPTION_LIMIT",
        `Maximum ${maxSubscriptionsPerClient} simultaneous symbol subscriptions per client`,
      ));
      return;
    }
    client.depth = parseBoundedInteger(message.depth, sessionGateway.settings.visibleDepth, 10, 200);
    client.subscriptions.add(symbol); // Set semantics keep re-subscribes idempotent
    client.droppedFrames = 0;
    refreshGauges();
    send(client, sessionGateway.createEvent("subscribed", {
      clientId: client.id,
      exchange: DEFAULT_EXCHANGE,
      symbol,
      depth: client.depth,
      source: sessionGateway.source,
    }));
    // Snapshot cache + lifecycle: every (re)subscribe starts from a fully
    // reconciled book state instead of partial deltas.
    if (sessionGateway.isMarketDataValid) send(client, sessionGateway.getSnapshot(client.depth));
    send(client, sessionGateway.createEvent("status", sessionGateway.status));
    return;
  }

  if (message.type === "unsubscribe") {
    const requested = typeof message.symbol === "string"
      ? message.symbol.trim().toUpperCase()
      : null;
    const targets = requested
      ? (client.subscriptions.has(requested) ? [requested] : [])
      : [...client.subscriptions];
    for (const symbol of targets) {
      client.subscriptions.delete(symbol);
      sessions.release(symbol);
      const sessionGateway = sessions.get(symbol);
      send(client, gatewayForEnvelope(sessions, sessionGateway).createEvent("unsubscribed", {
        exchange: DEFAULT_EXCHANGE,
        symbol,
      }));
    }
    refreshGauges();
    if (targets.length === 0) {
      send(client, errorEnvelope(sessions, "UNKNOWN_SUBSCRIPTION", "The connection holds no matching subscription"));
    }
    return;
  }

  if (message.type === "request_snapshot") {
    for (const symbol of client.subscriptions) {
      const sessionGateway = sessions.get(symbol);
      if (!sessionGateway) continue;
      for (const event of createSnapshotRecoveryEvents(sessionGateway, client.depth)) send(client, event);
    }
    return;
  }

  if (message.type === "ping") {
    send(client, gatewayForEnvelope(sessions).createEvent("heartbeat", {
      clientId: client.id,
      echoTimestamp: message.timestamp ?? null,
      uptimeMs: Math.round(process.uptime() * 1_000),
    }));
    return;
  }

  send(client, errorEnvelope(
    sessions,
    "UNKNOWN_MESSAGE",
    "Supported messages: subscribe, unsubscribe, request_snapshot, ping",
  ));
}

/**
 * Picks a live session to author protocol envelopes that are not tied to one
 * market (heartbeat/error/unsubscribed acks), preferring the given session.
 * With zero active sessions a synthetic primary-symbol envelope keeps the
 * wire contract stable.
 */
function gatewayForEnvelope(sessions: SessionRegistry, preferred?: MarketGateway | null): MarketGateway {
  if (preferred) return preferred;
  const first = sessions.list()
    .map((session) => sessions.get(session.symbol))
    .find((entry): entry is MarketGateway => entry !== null);
  if (first) return first;
  return syntheticEnvelopeGateway();
}

function syntheticEnvelopeGateway(): MarketGateway {
  const createEvent = (type: ServerEventType, data: unknown): ServerEnvelope => ({
    type,
    schemaVersion: SCHEMA_VERSION,
    exchange: DEFAULT_EXCHANGE,
    symbol: DEFAULT_SYMBOL,
    serverTimestamp: Date.now(),
    sequence: 0,
    data,
  });
  return { createEvent } as unknown as MarketGateway;
}

function errorEnvelope(sessions: SessionRegistry, code: string, message: string): ServerEnvelope {
  return gatewayForEnvelope(sessions).createEvent("error", { code, message });
}

function send(
  client: RealtimeClient,
  event: ServerEnvelope,
  sensor?: (type: ServerEventType, payloadBytes: number) => void,
): void {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  const deliverySequence = ++client.deliverySequence;
  const payload = JSON.stringify(withClientDeliveryMetadata(
    event,
    client.id,
    deliverySequence,
  ));
  client.socket.send(payload);
  sensor?.(event.type, payload.length);
}

export function withClientDeliveryMetadata(
  event: ServerEnvelope,
  streamId: string,
  deliverySequence: number,
): ServerEnvelope {
  return { ...event, streamId, deliverySequence };
}

export function createSnapshotRecoveryEvents(
  gateway: MarketGateway,
  depth: number,
): ServerEnvelope[] {
  if (!gateway.isMarketDataValid) {
    return [gateway.createEvent("status", gateway.status)];
  }
  return [
    gateway.getSnapshot(depth),
    gateway.createEvent("status", gateway.status),
  ];
}

function trimDepth(event: ServerEnvelope, depth: number): ServerEnvelope {
  if (event.type !== "depth_frame" && event.type !== "snapshot") return event;
  if (!isPlainObject(event.data)) return event;
  const bids = Array.isArray(event.data.bids) ? event.data.bids.slice(0, depth) : [];
  const asks = Array.isArray(event.data.asks) ? event.data.asks.slice(0, depth) : [];
  return { ...event, data: { ...event.data, bids, asks } };
}

function mountStaticApplication(app: express.Express): void {
  const serverDirectory = dirname(fileURLToPath(import.meta.url));
  const distDirectory = resolve(serverDirectory, "../dist");
  const indexPath = resolve(distDirectory, "index.html");
  if (!existsSync(indexPath)) return;

  app.use(express.static(distDirectory, {
    index: false,
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  }));
  app.use((request, response, next) => {
    if (
      request.method === "GET" &&
      request.accepts("html") &&
      !request.path.startsWith("/api/") &&
      request.path !== "/ws"
    ) {
      response.sendFile(indexPath);
      return;
    }
    next();
  });
}

/** Symbols exposed by the Phase 4 instrument registry. */
function instrumentList(): string[] {
  return supportedSymbols();
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = parseTimestamp(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalFinite(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseResolution(value: unknown): number {
  const mapping: Record<string, number> = {
    "1s": 1_000,
    "5s": 5_000,
    "15s": 15_000,
    "1m": 60_000,
    "5m": 300_000,
  };
  if (typeof value === "string" && value in mapping) return mapping[value]!;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 1_000;
}

function historyQueryLimit(): number {
  return parseBoundedInteger(
    process.env.XBMAP_HISTORY_QUERY_MAX_POINTS,
    10_000,
    100,
    100_000,
  );
}

function withinHistoryBudget(
  from: number,
  to: number,
  resolutionMs: number,
  maxPoints: number,
): boolean {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) return false;
  const maxRangeMs = parseBoundedInteger(
    process.env.XBMAP_HISTORY_QUERY_MAX_RANGE_MS,
    24 * 60 * 60_000,
    60_000,
    30 * 24 * 60 * 60_000,
  );
  const range = to - from;
  if (range > maxRangeMs) return false;
  return Math.floor(range / Math.max(1, resolutionMs)) + 1 <= maxPoints;
}

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sendError(response: Response, status: number, code: string, message: string): void {
  response.status(status).json({
    schemaVersion: SCHEMA_VERSION,
    error: { code, message },
    serverTimestamp: Date.now(),
  });
}

function isMissingReplaySession(error: unknown): boolean {
  return error instanceof Error && /not found or expired/i.test(error.message);
}

function parseAllowedOrigins(value: string | undefined): string[] {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}

export interface GatewayReadiness {
  ready: boolean;
  state: string;
  source: string;
  marketDataValid: boolean;
  reason: string;
}

/** Pure readiness predicate used by `/api/v1/health/ready`. */
export function isGatewayReady(gateway: MarketGateway): GatewayReadiness {
  const status = gateway.status;
  const ready = status.state !== "error"
    && status.state !== "closed"
    && (status.source === "demo" || status.state === "live" || gateway.isMarketDataValid);
  return {
    ready,
    state: status.state,
    source: status.source,
    marketDataValid: gateway.isMarketDataValid,
    reason: ready ? "serving" : `state=${status.state} source=${status.source} valid=${gateway.isMarketDataValid}`,
  };
}

function createRateLimiter(limit: number, windowMs: number) {
  const clients = new Map<string, { count: number; resetAt: number }>();
  return (request: Request, response: Response, next: NextFunction) => {
    const now = Date.now();
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const record = clients.get(key);
    if (!record || record.resetAt <= now) {
      clients.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    record.count += 1;
    response.setHeader("RateLimit-Limit", String(limit));
    response.setHeader("RateLimit-Remaining", String(Math.max(0, limit - record.count)));
    response.setHeader("RateLimit-Reset", String(Math.ceil((record.resetAt - now) / 1_000)));
    if (record.count > limit) {
      sendError(response, 429, "RATE_LIMITED", "Too many API requests");
      return;
    }
    next();
  };
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => error ? rejectClose(error) : resolveClose());
    server.closeIdleConnections?.();
  });
}

async function closeRealtimeServer(
  websocketServer: WebSocketServer,
  clients: Set<RealtimeClient>,
): Promise<void> {
  for (const client of clients) client.socket.close(1001, "Server shutting down");
  let timeout: NodeJS.Timeout | null = null;
  await Promise.race([
    new Promise<void>((resolveClose) => websocketServer.close(() => resolveClose())),
    new Promise<void>((resolveTimeout) => {
      timeout = setTimeout(() => {
        for (const client of clients) client.socket.terminate();
        resolveTimeout();
      }, 1_000);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  clients.clear();
}
