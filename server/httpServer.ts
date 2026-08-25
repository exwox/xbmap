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
import {
  createMarketObservability,
  type MarketObservability,
} from "./observability/index.js";

interface RealtimeClient {
  socket: WebSocket;
  id: string;
  subscribed: boolean;
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
  close: () => Promise<void>;
}

export function createMarketHttpServer(
  gateway = new MarketGateway(),
  rawReplay: RawReplayRuntime | null = null,
  observability = createMarketObservability(),
): MarketHttpServer {
  const app = express();
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

  app.use((request, response, next) => {
    const started = performance.now();
    response.once("finish", () => {
      observability.recordHttpRequest(
        request.method,
        request.path,
        response.statusCode,
        performance.now() - started,
      );
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
    const ready = isGatewayReady(gateway);
    response.status(ready.ready ? 200 : 503).json({
      ok: ready.ready,
      schemaVersion: SCHEMA_VERSION,
      serverTimestamp: Date.now(),
      source: ready.source,
      state: ready.state,
      marketDataValid: ready.marketDataValid,
      reason: ready.reason,
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
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      },
    });
  });

  app.get("/api/v1/markets", (_request, response) => {
    response.json({
      schemaVersion: SCHEMA_VERSION,
      markets: [{
        exchange: DEFAULT_EXCHANGE,
        symbol: gateway.symbol,
        displaySymbol: "BTC/USDT Perpetual",
        marketType: "perpetual",
        tickSize: gateway.tickSize,
        quantityStep: 0.001,
        source: gateway.source,
        available: true,
      }],
    });
  });

  app.get("/api/v1/snapshot", (request, response) => {
    if (!validMarketQuery(request, response, gateway.symbol)) return;
    if (!gateway.isMarketDataValid) {
      sendError(response, 503, "BOOK_NOT_READY", "Order book is syncing or invalid");
      return;
    }
    const depth = parseBoundedInteger(request.query.depth, gateway.settings.visibleDepth, 10, 200);
    response.json(gateway.getSnapshot(depth));
  });

  app.get("/api/v1/history", async (request, response) => {
    if (!validMarketQuery(request, response, gateway.symbol)) return;
    const now = Date.now();
    const from = parseTimestamp(request.query.from, now - 5 * 60_000);
    const to = parseTimestamp(request.query.to, now);
    if (from > to) {
      sendError(response, 400, "INVALID_RANGE", "from must be before to");
      return;
    }
    const requestedResolutionMs = parseResolution(request.query.resolution);
    const resolutionMs = gateway.historyResolution(requestedResolutionMs);
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
    const items = await gateway.getHistory(from, to, resolutionMs, queryLimit);
    response.json({
      schemaVersion: SCHEMA_VERSION,
      exchange: DEFAULT_EXCHANGE,
      symbol: gateway.symbol,
      from,
      to,
      resolutionMs,
      items,
    });
  });

  app.get("/api/v1/settings", (_request, response) => {
    response.json({ schemaVersion: SCHEMA_VERSION, settings: gateway.settings });
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
    response.json({ schemaVersion: SCHEMA_VERSION, settings: gateway.updateSettings(patch) });
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

  websocketServer.on("connection", (socket) => {
    const client: RealtimeClient = {
      socket,
      id: cryptoRandomId(),
      subscribed: false,
      depth: gateway.settings.visibleDepth,
      alive: true,
      droppedFrames: 0,
      deliverySequence: 0,
    };
    clients.add(client);
    observability.setClientConnections(clients.size);
    socket.on("pong", () => { client.alive = true; });
    socket.on("error", () => { clients.delete(client); updateClientGauges(); });
    socket.on("close", () => { clients.delete(client); updateClientGauges(); });
    socket.on("message", (raw) => handleClientMessage(client, raw.toString(), gateway, clients, observability));
    send(client, gateway.createEvent("status", gateway.status));
  });

  function updateClientGauges(): void {
    observability.setClientConnections(clients.size);
    observability.setSubscribedClients(countSubscribed(clients));
  }

  const onGatewayEvent = (event: ServerEnvelope) => {
    for (const client of clients) {
      if (!client.subscribed || client.socket.readyState !== WebSocket.OPEN) continue;
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
  gateway.on("event", onGatewayEvent);

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
      if (client.subscribed) {
        send(client, gateway.createEvent("heartbeat", {
          clientId: client.id,
          uptimeMs: Math.round(process.uptime() * 1_000),
          droppedFrames: client.droppedFrames,
        }));
      }
    }
  }, 15_000);
  heartbeat.unref?.();

  gateway.start();

  return {
    app,
    server,
    gateway,
    websocketServer,
    rawReplay,
    observability,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closing = true;
        clearInterval(heartbeat);
        observability.stop();
        // Stop ingress and publish the final complete buffers/status while
        // gateway listeners and client sockets are still attached.
        await gateway.shutdown();
        rawReplay?.close();
        gateway.off("event", onGatewayEvent);
        const httpClosed = closeHttpServer(server);
        await closeRealtimeServer(websocketServer, clients);
        await httpClosed;
      })();
      return closePromise;
    },
  };
}

function handleClientMessage(
  client: RealtimeClient,
  raw: string,
  gateway: MarketGateway,
  clients: Set<RealtimeClient>,
  observability: MarketObservability,
): void {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    send(client, gateway.createEvent("error", {
      code: "INVALID_JSON",
      message: "WebSocket message must be valid JSON",
    }));
    return;
  }
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    send(client, gateway.createEvent("error", {
      code: "INVALID_MESSAGE",
      message: "Message type is required",
    }));
    return;
  }

  if (message.type === "subscribe") {
    const symbol = (message.symbol ?? DEFAULT_SYMBOL).toUpperCase();
    if ((message.exchange ?? DEFAULT_EXCHANGE) !== DEFAULT_EXCHANGE || symbol !== gateway.symbol) {
      send(client, gateway.createEvent("error", {
        code: "UNSUPPORTED_MARKET",
        message: `Only ${DEFAULT_EXCHANGE}:${gateway.symbol} is available in this MVP`,
      }));
      return;
    }
    client.depth = parseBoundedInteger(message.depth, gateway.settings.visibleDepth, 10, 200);
    client.subscribed = true;
    client.droppedFrames = 0;
    observability.setSubscribedClients(countSubscribed(clients));
    send(client, gateway.createEvent("subscribed", {
      clientId: client.id,
      exchange: DEFAULT_EXCHANGE,
      symbol: gateway.symbol,
      depth: client.depth,
      source: gateway.source,
    }));
    if (gateway.isMarketDataValid) send(client, gateway.getSnapshot(client.depth));
    send(client, gateway.createEvent("status", gateway.status));
    return;
  }

  if (message.type === "unsubscribe") {
    client.subscribed = false;
    observability.setSubscribedClients(countSubscribed(clients));
    send(client, gateway.createEvent("unsubscribed", {
      exchange: DEFAULT_EXCHANGE,
      symbol: gateway.symbol,
    }));
    return;
  }

  if (message.type === "request_snapshot") {
    if (client.subscribed) {
      for (const event of createSnapshotRecoveryEvents(gateway, client.depth)) send(client, event);
    }
    return;
  }

  if (message.type === "ping") {
    send(client, gateway.createEvent("heartbeat", {
      clientId: client.id,
      echoTimestamp: message.timestamp ?? null,
      uptimeMs: Math.round(process.uptime() * 1_000),
    }));
    return;
  }

  send(client, gateway.createEvent("error", {
    code: "UNKNOWN_MESSAGE",
    message: "Supported messages: subscribe, unsubscribe, request_snapshot, ping",
  }));
}

function countSubscribed(clients: Set<RealtimeClient>): number {
  let subscribed = 0;
  for (const client of clients) if (client.subscribed) subscribed += 1;
  return subscribed;
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

function validMarketQuery(request: Request, response: Response, symbol: string): boolean {
  const exchange = typeof request.query.exchange === "string"
    ? request.query.exchange.toLowerCase()
    : DEFAULT_EXCHANGE;
  const requestedSymbol = typeof request.query.symbol === "string"
    ? request.query.symbol.toUpperCase()
    : symbol;
  if (exchange !== DEFAULT_EXCHANGE || requestedSymbol !== symbol) {
    sendError(response, 404, "UNSUPPORTED_MARKET", `Only ${DEFAULT_EXCHANGE}:${symbol} is available`);
    return false;
  }
  return true;
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
