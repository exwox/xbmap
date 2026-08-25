import { pathToFileURL } from "node:url";
import { createMarketHttpServer } from "./httpServer.js";
import { historyPersistenceFromEnvironment } from "./historyPersistence.js";
import { MarketGateway } from "./marketGateway.js";
import { createMarketObservability } from "./observability/index.js";
import { rawReplayRuntimeFromEnvironment } from "./replayRuntime.js";
import { DEFAULT_SYMBOL, DEFAULT_TICK_SIZE } from "./types.js";

export { createMarketHttpServer } from "./httpServer.js";
export { MarketGateway } from "./marketGateway.js";
export { createMarketObservability } from "./observability/index.js";
export * from "./types.js";

export async function startServer(): Promise<ReturnType<typeof createMarketHttpServer>> {
  const historyPersistence = await historyPersistenceFromEnvironment(
    DEFAULT_SYMBOL,
    DEFAULT_TICK_SIZE,
  );
  const rawReplay = await rawReplayRuntimeFromEnvironment(DEFAULT_TICK_SIZE);
  const observability = createMarketObservability();
  const service = createMarketHttpServer(
    new MarketGateway({ historyPersistence, metrics: observability.hooks }),
    rawReplay,
    observability,
  );
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
  }));
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
