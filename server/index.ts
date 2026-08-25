import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createMarketHttpServer } from "./httpServer.js";
import { historyPersistenceFromEnvironment, type HistoryPersistence } from "./historyPersistence.js";
import { instrumentFor, supportedSymbols } from "./instruments.js";
import { MarketGateway } from "./marketGateway.js";
import { MarketSessionManager } from "./marketSessionManager.js";
import { createMarketObservability } from "./observability/index.js";
import { rawReplayRuntimeFromEnvironment } from "./replayRuntime.js";
import { DEFAULT_SYMBOL, DEFAULT_TICK_SIZE } from "./types.js";
import { AuthService } from "./auth/authService.js";
import { UserStore } from "./auth/userStore.js";
import { InsightsRuntime } from "./insights/insightsRuntime.js";
import { BinanceDerivativesPoller } from "./feeds/binanceDerivatives.js";
import { BinanceLiquidationStream } from "./feeds/binanceLiquidations.js";
import type { AlertRule } from "./alerts/alertEngine.js";
import WebSocket from "ws";

export { createMarketHttpServer } from "./httpServer.js";
export { MarketGateway } from "./marketGateway.js";
export { MarketSessionManager } from "./marketSessionManager.js";
export { createMarketObservability } from "./observability/index.js";
export * from "./types.js";

/**
 * Phase 4: one durable-history projection per symbol. File/backup roots are
 * symbol-scoped inside `historyPersistenceFromEnvironment`, so concurrent
 * market sessions never share segments or manifests.
 */
async function persistencePerSymbol(): Promise<Map<string, HistoryPersistence | null>> {
  const persistences = new Map<string, HistoryPersistence | null>();
  for (const symbol of supportedSymbols()) {
    const { tickSize } = instrumentFor(symbol);
    persistences.set(symbol, await historyPersistenceFromEnvironment(symbol, tickSize));
  }
  return persistences;
}

function envBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

// ── Phase 5 alert-rules persistence (JSON file, debounced writes) ────────────

async function loadAlertRules(filePath: string | undefined): Promise<AlertRule[]> {
  const trimmed = filePath?.trim();
  if (!trimmed) return [];
  try {
    const raw = await readFile(trimmed, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is AlertRule =>
      Boolean(entry) && typeof entry === "object" &&
      typeof (entry as AlertRule).id === "string" &&
      typeof (entry as AlertRule).kind === "string");
  } catch {
    // Missing or unreadable file simply starts with an empty rule set.
    return [];
  }
}

const rulesSaveTimers = new Map<string, NodeJS.Timeout>();

function saveAlertRules(filePath: string | undefined, rules: readonly AlertRule[]): void {
  const trimmed = filePath?.trim();
  if (!trimmed) return;
  const existing = rulesSaveTimers.get(trimmed);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    rulesSaveTimers.delete(trimmed);
    void mkdir(dirname(trimmed), { recursive: true })
      .then(() => writeFile(trimmed, `${JSON.stringify(rules, null, 2)}\n`, "utf8"))
      .catch((error: unknown) => {
        console.error(JSON.stringify({
          level: "error",
          component: "alerts",
          message: "Failed to persist alert rules",
          detail: error instanceof Error ? error.message : String(error),
        }));
      });
  }, 400);
  timer.unref?.();
  rulesSaveTimers.set(trimmed, timer);
}

export async function startServer(): Promise<ReturnType<typeof createMarketHttpServer>> {
  const observability = createMarketObservability();
  const rawReplay = await rawReplayRuntimeFromEnvironment(DEFAULT_TICK_SIZE);
  const persistences = await persistencePerSymbol();

  // Lazily-created sessions stop consuming feeds once the last subscriber
  // leaves (idle TTL) and flush durable buffers through an async dispose.
  const sessions = new MarketSessionManager({
    maxSessions: envBoundedInteger(process.env.XBMAP_MAX_SESSIONS, 8, 1, 16),
    idleTtlMs: envBoundedInteger(process.env.XBMAP_SESSION_IDLE_TTL_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
    disposeGateway: (gateway) => gateway.shutdown(),
    createGateway: (symbol, tickSize) => {
      let instance: MarketGateway | null = null;
      const labels = {
        symbol,
        get source() {
          return instance?.source ?? "binance";
        },
      };
      instance = new MarketGateway({
        symbol,
        tickSize,
        historyPersistence: persistences.get(symbol) ?? null,
        metrics: observability.scopedHooks(labels),
      });
      return instance;
    },
  });

  const defaultInstrument = instrumentFor(DEFAULT_SYMBOL);
  const defaultGateway = new MarketGateway({
    symbol: DEFAULT_SYMBOL,
    tickSize: defaultInstrument.tickSize,
    historyPersistence: persistences.get(DEFAULT_SYMBOL) ?? null,
    metrics: observability.hooks,
  });
  sessions.register(defaultGateway, { start: true });

  // Phase 5: analytics/alerts runtime + funding/open-interest polling.
  const rulesFile = process.env.XBMAP_ALERT_RULES_FILE?.trim() || undefined;
  const insights = new InsightsRuntime({
    shadowMode: process.env.XBMAP_ALERT_SHADOW === "1",
    webhookUrl: process.env.XBMAP_ALERT_WEBHOOK_URL?.trim() || null,
    telegramBotToken: process.env.XBMAP_TELEGRAM_BOT_TOKEN?.trim() || null,
    telegramChatId: process.env.XBMAP_TELEGRAM_CHAT_ID?.trim() || null,
    initialRules: await loadAlertRules(rulesFile),
    onRulesPersist: (rules) => saveAlertRules(rulesFile, rules),
  });
  const derivativesPoller = new BinanceDerivativesPoller({
    symbols: supportedSymbols(),
    intervalMs: envBoundedInteger(process.env.XBMAP_DERIVATIVES_POLL_MS, 30_000, 10_000, 300_000),
  });
  derivativesPoller.on((update) => insights.setDerivatives(update));

  // Real-market liquidation feed is strictly opt-in: storing this data may
  // carry licensing implications (see development-plan.md Fase 5).
  let liquidationStream: BinanceLiquidationStream | null = null;
  if (process.env.XBMAP_LIQUIDATIONS === "1") {
    liquidationStream = new BinanceLiquidationStream({
      symbols: supportedSymbols(),
      open: (url, handlers) => {
        const socket = new WebSocket(url);
        socket.on("open", () => handlers.onOpen());
        socket.on("message", (raw) => handlers.onMessage(String(raw)));
        socket.on("error", (error) => handlers.onError(error));
        return { close: () => socket.close() };
      },
    });
    liquidationStream.start((event) => insights.pushLiquidation(event));
  }

  // Phase 6 auth foundation: bootstrap admin credential from env. Sessions
  // are in-memory; enforcement is opt-in via XBMAP_REQUIRE_AUTH=1.
  const adminUsername = process.env.XBMAP_ADMIN_USERNAME?.trim() || "admin";
  const adminPassword = process.env.XBMAP_ADMIN_PASSWORD?.trim() || "";
  if (process.env.XBMAP_REQUIRE_AUTH === "1" && !adminPassword) {
    throw new TypeError("XBMAP_REQUIRE_AUTH=1 requires XBMAP_ADMIN_PASSWORD to be set");
  }

  const usersFile = process.env.XBMAP_USERS_FILE?.trim() || undefined;
  const users = await UserStore.open({ filePath: usersFile });
  if (adminPassword) {
    users.ensureBootstrapAdmin(adminUsername, adminPassword);
  }

  const auth = adminPassword
    ? {
        service: new AuthService(
          {
            sessionTtlMs: envBoundedInteger(
              process.env.XBMAP_SESSION_TTL_MS,
              7 * 24 * 60 * 60_000,
              60_000,
              30 * 24 * 60 * 60_000,
            ),
            verify: (username: string, password: string) => {
              // Store accounts win (honours disable/password changes); the
              // env bootstrap pair only applies until the store owns the user.
              if (users.roleOf(username) !== null) {
                return users.verifyCredentials(username, password);
              }
              return username === adminUsername && password === adminPassword;
            },
          },
        ),
        required: process.env.XBMAP_REQUIRE_AUTH === "1",
      }
    : undefined;

  const service = createMarketHttpServer(
    defaultGateway,
    rawReplay,
    observability,
    { sessions, insights, auth, users, adminToken: process.env.XBMAP_ADMIN_TOKEN?.trim() || undefined },
  );
  // Stop background polling before the HTTP surface drains so shutdown is
  // deterministic and no update lands in a closing session.
  const innerClose = service.close.bind(service);
  service.close = async () => {
    derivativesPoller.stop();
    liquidationStream?.stop();
    await users.flush();
    await innerClose();
  };
  observability.start();
  const port = parsePort(process.env.PORT, 8_787);
  const host = process.env.HOST?.trim() || "0.0.0.0";
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(port, host, () => {
      service.server.off("error", reject);
      resolve();
    });
  });
  const address = service.server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.info(JSON.stringify({
    level: "info",
    component: "server",
    message: "xbmap market gateway listening",
    host,
    port: listeningPort,
    websocketPath: "/ws",
    source: service.gateway.source,
    symbols: supportedSymbols(),
  }));
  derivativesPoller.start();
  return service;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  // Background tasks (observability timer, history flush, replay cleanup) must
  // not silently kill the gateway: log first, keep serving, and count on the
  // alert trail to surface the failure. A second rejection within 5s still
  // exits so a genuinely broken process does not zombie-loop.
  let recentRejections = 0;
  process.on("unhandledRejection", (reason) => {
    recentRejections += 1;
    console.error(JSON.stringify({
      level: "error",
      component: "server",
      event: "unhandled_rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    }));
    if (recentRejections >= 5) {
      console.error(JSON.stringify({
        level: "error",
        component: "server",
        event: "unhandled_rejection_threshold",
        message: "Too many unhandled rejections; exiting",
      }));
      process.exit(1);
    }
    setTimeout(() => { recentRejections = Math.max(0, recentRejections - 1); }, 5_000).unref?.();
  });
  const service = await startServer();
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(JSON.stringify({ level: "info", component: "server", message: `Received ${signal}` }));
    const forcedExit = setTimeout(() => process.exit(1), 8_000);
    forcedExit.unref?.();
    try {
      await service.close();
      clearTimeout(forcedExit);
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
}
