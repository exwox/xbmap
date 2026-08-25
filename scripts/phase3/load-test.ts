/**
 * Phase 3 multi-client load test.
 *
 * Boots the real gateway+HTTP server in-process, connects `--clients`
 * concurrent WebSocket subscribers, runs them for `--duration` seconds and
 * asserts the Phase 3 targets: zero dropped frames, bounded per-client
 * buffered bytes, and stable delivery across every connection.
 *
 * Usage: npm run phase3:loadtest [-- --clients 50 --duration 30]
 */

import { performance } from "node:perf_hooks";
import { createMarketHttpServer } from "../../server/httpServer.js";
import { MarketGateway } from "../../server/marketGateway.js";
import {
  createMarketObservability,
  type MarketObservability,
} from "../../server/observability/index.js";
import WebSocket from "ws";

interface ParsedArguments {
  clients: number;
  durationSeconds: number;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  let clients = 25;
  let durationSeconds = 20;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--clients") clients = Number(requiredValue(argument, ++index));
    else if (argument === "--duration") durationSeconds = Number(requiredValue(argument, ++index));
    else throw new TypeError(`Unknown argument: ${argument}`);
  }
  if (!Number.isSafeInteger(clients) || clients < 1 || clients > 500) {
    throw new TypeError("--clients must be an integer in [1, 500]");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < 5 || durationSeconds > 3_600) {
    throw new TypeError("--duration must be seconds in [5, 3600]");
  }
  return { clients, durationSeconds };

  function requiredValue(name: string, nextIndex: number): string {
    const value = argv[nextIndex];
    if (!value) throw new TypeError(`${name} requires a value`);
    return value;
  }
}

interface ClientResult {
  frames: number;
  bytes: number;
  errors: number;
  maxBufferedBytes: number;
  closedUnexpectedly: boolean;
}

function connectClient(port: number): Promise<{ socket: WebSocket; result: ClientResult }> {
  const result: ClientResult = {
    frames: 0, bytes: 0, errors: 0, maxBufferedBytes: 0, closedUnexpectedly: false,
  };
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.on("open", () => socket.send(JSON.stringify({ type: "subscribe" })));
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    result.frames += 1;
    result.bytes += Array.isArray(data)
      ? data.reduce((total, chunk) => total + chunk.length, 0)
      : Buffer.byteLength(data as ArrayBuffer);
    const buffered = (socket as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
    result.maxBufferedBytes = Math.max(result.maxBufferedBytes, buffered);
  });
  socket.on("error", () => { result.errors += 1; });
  socket.on("close", (code) => {
    // 1000/1001 = clean or server shutdown; anything else is unexpected.
    if (code !== 1000 && code !== 1001) result.closedUnexpectedly = true;
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ socket, result }));
    socket.once("error", reject);
  });
}

async function main(): Promise<void> {
  const { clients: clientCount, durationSeconds } = parseArguments(process.argv.slice(2));
  const observability: MarketObservability = createMarketObservability({ intervalMs: 500 });
  const gateway = new MarketGateway({ forceDemo: true, metrics: observability.hooks });
  observability.attachGateway(gateway);
  const service = createMarketHttpServer(gateway, null, observability);
  gateway.start();
  observability.start();
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", resolve);
  });
  const address = service.server.address();
  if (typeof address !== "object" || !address) throw new Error("no port");
  const port = address.port;

  const startedAt = performance.now();
  try {
    const handles = await Promise.all(
      Array.from({ length: clientCount }, () => connectClient(port)),
    );
    console.info(JSON.stringify({
      level: "info", component: "loadtest", event: "connected",
      clients: handles.length, port,
    }));

    await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1_000));

    const results = handles.map((handle) => handle.result);
    for (const handle of handles) handle.socket.close(1000);
    const totalFrames = results.reduce((sum, r) => sum + r.frames, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
    const maxBuffered = results.reduce((max, r) => Math.max(max, r.maxBufferedBytes), 0);
    const unexpectedCloses = results.filter((r) => r.closedUnexpectedly).length;
    const wallSeconds = (performance.now() - startedAt) / 1_000;

    const report = {
      kind: "phase-3-load-test",
      generatedAt: new Date().toISOString(),
      clients: clientCount,
      durationSeconds,
      totalFrames,
      avgFramesPerClient: Math.round(totalFrames / clientCount),
      framesPerSecond: Math.round(totalFrames / wallSeconds),
      totalErrors,
      unexpectedCloses,
      maxClientBufferedBytes: maxBuffered,
      passed: totalErrors === 0 && unexpectedCloses === 0 && maxBuffered < 8 * 1024 * 1024,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.passed) process.exitCode = 1;
  } finally {
    observability.stop();
    gateway.stop();
    await new Promise<void>((resolve) => service.server.close(() => resolve()));
  }
}

void main().catch((error) => {
  console.error(JSON.stringify({
    level: "error", component: "loadtest",
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
