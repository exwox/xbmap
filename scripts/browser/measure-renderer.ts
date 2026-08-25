import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { cpus, hostname, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import WebSocket from "ws";
import { createMarketHttpServer, type MarketHttpServer } from "../../server/httpServer.js";
import { MarketGateway } from "../../server/marketGateway.js";

interface Options {
  durationSeconds: number;
  warmupTimeoutSeconds: number;
  targetFrames: number;
  seed: number;
  width: number;
  height: number;
  chromePath?: string;
  url?: string;
  jsonPath: string;
  markdownPath: string;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RuntimeEvaluation {
  result: { value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

interface RendererState {
  marketDrawMs: number[];
  inputToPaintMs: number[];
  drawTimestamps: number[];
  latest?: {
    depthFrames: number;
    trades: number;
    prices: number;
    width: number;
    height: number;
    dpr: number;
    backingWidth: number;
    backingHeight: number;
  };
}

interface BrowserRuntimeState {
  longTasks: number[];
  errors: string[];
}

interface FrameSample {
  frameIntervalsMs: number[];
  startedAt: number;
  finishedAt: number;
  heapStartBytes: number | null;
  heapEndBytes: number | null;
}

interface BrowserInfo {
  userAgent: string;
  platform: string;
  hardwareConcurrency: number;
  deviceMemoryGiB: number | null;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  webglVendor: string | null;
  webglRenderer: string | null;
  connectionText: string | null;
}

interface Distribution {
  count: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

interface PerformanceMetricMap {
  [name: string]: number;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as CdpResponse;
      if (message.id === undefined) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      } else {
        request.resolve(message.result ?? {});
      }
    });
    socket.on("close", () => {
      for (const request of this.pending.values()) {
        request.reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      this.pending.set(id, {
        resolve: (value) => resolvePromise(value as T),
        reject: rejectPromise,
      });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        rejectPromise(error);
      });
    });
  }

  async evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
    const evaluation = await this.call<RuntimeEvaluation>("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (evaluation.exceptionDetails) {
      throw new Error(
        evaluation.exceptionDetails.exception?.description ??
          evaluation.exceptionDetails.text ??
          "Browser evaluation failed",
      );
    }
    return evaluation.result.value as T;
  }
}

const options = parseOptions(process.argv.slice(2));
const rootDirectory = resolve(import.meta.dirname, "../..");

let service: MarketHttpServer | null = null;
let chrome: ChildProcess | null = null;
let profileDirectory: string | null = null;
let socket: WebSocket | null = null;

try {
  const localApplication = options.url ? null : await startLocalApplication();
  service = localApplication?.service ?? null;
  const applicationUrl = options.url ?? localApplication!.url;
  const chromePath = findChrome(options.chromePath);
  const debuggingPort = await reservePort();
  profileDirectory = await mkdtemp(join(tmpdir(), "liquidmap-renderer-bench-"));
  chrome = launchChrome(chromePath, debuggingPort, profileDirectory, options);

  const target = await waitForPageTarget(debuggingPort);
  socket = await openSocket(target.webSocketDebuggerUrl);
  const cdp = new CdpClient(socket);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Performance.enable", { timeDomain: "timeTicks" });
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: injectionSource(options.seed),
  });
  await cdp.call("Page.navigate", {
    url: `${applicationUrl}${applicationUrl.includes("?") ? "&" : "?"}benchmark=renderer`,
  });

  await waitForDocument(cdp);
  const warmup = await waitForRendererWindow(cdp, options);
  await cdp.evaluate(`(() => {
    const renderer = globalThis.__liquidMapRendererBenchmark;
    renderer.marketDrawMs.length = 0;
    renderer.inputToPaintMs.length = 0;
    renderer.drawTimestamps.length = 0;
    globalThis.__liquidMapBrowserRuntime.longTasks.length = 0;
    globalThis.__liquidMapBrowserRuntime.errors.length = 0;
  })()`);

  const performanceBefore = await readPerformanceMetrics(cdp);
  const sample = await cdp.evaluate<FrameSample>(frameSampleExpression(options.durationSeconds), true);
  const performanceAfter = await readPerformanceMetrics(cdp);
  const renderer = await cdp.evaluate<RendererState>(
    "structuredClone(globalThis.__liquidMapRendererBenchmark)",
  );
  const runtime = await cdp.evaluate<BrowserRuntimeState>(
    "structuredClone(globalThis.__liquidMapBrowserRuntime)",
  );
  const browser = await cdp.evaluate<BrowserInfo>(browserInfoExpression());

  const report = buildReport({
    applicationUrl,
    chromePath,
    warmup,
    sample,
    renderer,
    runtime,
    browser,
    performanceBefore,
    performanceAfter,
  });
  await mkdir(dirname(resolve(rootDirectory, options.jsonPath)), { recursive: true });
  await mkdir(dirname(resolve(rootDirectory, options.markdownPath)), { recursive: true });
  await writeFile(
    resolve(rootDirectory, options.jsonPath),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(rootDirectory, options.markdownPath),
    renderMarkdown(report),
    "utf8",
  );

  console.log(JSON.stringify({
    status: "ok",
    json: options.jsonPath,
    markdown: options.markdownPath,
    frameRate: report.results.animationFrameRateFps,
    marketDrawP95Ms: report.results.marketDrawMs.p95,
    inputToPaintP95Ms: report.results.inputToPaintMs.p95,
    depthFrames: report.workload.latest?.depthFrames ?? null,
    longTasks: report.results.longTasks.count,
  }, null, 2));
} finally {
  socket?.close();
  if (chrome) await stopProcess(chrome);
  if (service) await service.close();
  if (profileDirectory) {
    await rm(profileDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

async function startLocalApplication(): Promise<{ service: MarketHttpServer; url: string }> {
  if (!existsSync(resolve(rootDirectory, "dist/index.html"))) {
    throw new Error("dist/index.html is missing; run npm run build before this benchmark");
  }
  const gateway = new MarketGateway({ forceDemo: true });
  const localService = createMarketHttpServer(gateway);
  await new Promise<void>((resolveListen, rejectListen) => {
    localService.server.once("error", rejectListen);
    localService.server.listen(0, "127.0.0.1", () => {
      localService.server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = localService.server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve local port");
  return { service: localService, url: `http://127.0.0.1:${address.port}` };
}

function parseOptions(args: string[]): Options {
  const result: Options = {
    durationSeconds: 12,
    warmupTimeoutSeconds: 60,
    targetFrames: 1_800,
    seed: 1_480_744_257,
    width: 1_366,
    height: 768,
    jsonPath: "docs/baselines/phase-0-browser-renderer.json",
    markdownPath: "docs/baselines/phase-0-browser-renderer.md",
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    const numeric = value === undefined ? Number.NaN : Number(value);
    switch (flag) {
      case "--duration": result.durationSeconds = positive(numeric, flag); index += 1; break;
      case "--warmup-timeout": result.warmupTimeoutSeconds = positive(numeric, flag); index += 1; break;
      case "--target-frames": result.targetFrames = Math.round(positive(numeric, flag)); index += 1; break;
      case "--seed": result.seed = Math.round(finite(numeric, flag)) >>> 0; index += 1; break;
      case "--width": result.width = Math.round(positive(numeric, flag)); index += 1; break;
      case "--height": result.height = Math.round(positive(numeric, flag)); index += 1; break;
      case "--chrome": result.chromePath = required(value, flag); index += 1; break;
      case "--url": result.url = required(value, flag); index += 1; break;
      case "--json": result.jsonPath = required(value, flag); index += 1; break;
      case "--markdown": result.markdownPath = required(value, flag); index += 1; break;
      case "--help":
        console.log("Usage: measure-renderer [--duration 12] [--warmup-timeout 60] [--target-frames 1800] [--seed N] [--chrome PATH] [--url URL] [--json PATH] [--markdown PATH]");
        process.exit(0);
      default: throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return result;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function findChrome(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((entry): entry is string => Boolean(entry));
  const match = candidates.find((entry) => existsSync(entry));
  if (!match) throw new Error("Chrome/Chromium not found; pass --chrome PATH");
  return match;
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (port === 0) throw new Error("Unable to reserve Chrome debugging port");
  return port;
}

function launchChrome(
  executable: string,
  debuggingPort: number,
  profile: string,
  benchmark: Options,
): ChildProcess {
  const child = spawn(executable, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-dev-shm-usage",
    "--enable-precise-memory-info",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${benchmark.width},${benchmark.height}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
  });
  child.once("exit", (code) => {
    if (code && process.exitCode !== 0) {
      console.error(`Chrome exited with ${code}: ${stderr}`);
    }
  });
  return child;
}

async function waitForPageTarget(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json() as Array<{
          type: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return { webSocketDebuggerUrl: page.webSocketDebuggerUrl };
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Chrome DevTools endpoint did not start: ${String(lastError ?? "timeout")}`);
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolveOpen, rejectOpen) => {
    const candidate = new WebSocket(url);
    candidate.once("open", () => resolveOpen(candidate));
    candidate.once("error", rejectOpen);
  });
}

async function waitForDocument(cdp: CdpClient): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = await cdp.evaluate<boolean>(
      "document.readyState === 'complete' && Boolean(document.querySelector('canvas'))",
    );
    if (ready) return;
    await delay(100);
  }
  throw new Error("LiquidMap did not render a canvas within 20 seconds");
}

async function waitForRendererWindow(cdp: CdpClient, benchmark: Options) {
  const startedAt = Date.now();
  const deadline = startedAt + benchmark.warmupTimeoutSeconds * 1_000;
  let latest: RendererState["latest"];
  while (Date.now() < deadline) {
    latest = await cdp.evaluate<RendererState["latest"]>(
      "globalThis.__liquidMapRendererBenchmark?.latest",
    );
    if ((latest?.depthFrames ?? 0) >= benchmark.targetFrames) {
      return {
        reachedTarget: true,
        elapsedMs: Date.now() - startedAt,
        targetFrames: benchmark.targetFrames,
        latest,
      };
    }
    await delay(250);
  }
  return {
    reachedTarget: false,
    elapsedMs: Date.now() - startedAt,
    targetFrames: benchmark.targetFrames,
    latest,
  };
}

function injectionSource(seed: number): string {
  return `(() => {
    let state = ${seed >>> 0};
    Math.random = () => {
      state |= 0;
      state = (state + 0x6D2B79F5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value = value + Math.imul(value ^ (value >>> 7), 61 | value) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    globalThis.__liquidMapRendererBenchmark = {
      marketDrawMs: [], inputToPaintMs: [], drawTimestamps: []
    };
    const runtime = globalThis.__liquidMapBrowserRuntime = { longTasks: [], errors: [] };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) runtime.longTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
    addEventListener('error', (event) => runtime.errors.push(String(event.error?.stack || event.message)));
    addEventListener('unhandledrejection', (event) => runtime.errors.push(String(event.reason?.stack || event.reason)));
  })()`;
}

function frameSampleExpression(durationSeconds: number): string {
  return `new Promise((resolve) => {
    const durationMs = ${Math.round(durationSeconds * 1_000)};
    const intervals = [];
    const startedAt = performance.now();
    const heapStartBytes = performance.memory?.usedJSHeapSize ?? null;
    let previous;
    const frame = (timestamp) => {
      if (previous !== undefined) intervals.push(timestamp - previous);
      previous = timestamp;
      if (performance.now() - startedAt < durationMs) {
        requestAnimationFrame(frame);
        return;
      }
      resolve({
        frameIntervalsMs: intervals,
        startedAt,
        finishedAt: performance.now(),
        heapStartBytes,
        heapEndBytes: performance.memory?.usedJSHeapSize ?? null,
      });
    };
    requestAnimationFrame(frame);
  })`;
}

function browserInfoExpression(): string {
  return `(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
      devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
      webglVendor: gl && debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      webglRenderer: gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      connectionText: document.querySelector('.connection-pill')?.textContent?.trim() ?? null,
    };
  })()`;
}

async function readPerformanceMetrics(cdp: CdpClient): Promise<PerformanceMetricMap> {
  const response = await cdp.call<{ metrics: Array<{ name: string; value: number }> }>(
    "Performance.getMetrics",
  );
  return Object.fromEntries(response.metrics.map((metric) => [metric.name, metric.value]));
}

function buildReport(input: {
  applicationUrl: string;
  chromePath: string;
  warmup: Awaited<ReturnType<typeof waitForRendererWindow>>;
  sample: FrameSample;
  renderer: RendererState;
  runtime: BrowserRuntimeState;
  browser: BrowserInfo;
  performanceBefore: PerformanceMetricMap;
  performanceAfter: PerformanceMetricMap;
}) {
  const durationMs = input.sample.finishedAt - input.sample.startedAt;
  const frameIntervals = distribution(input.sample.frameIntervalsMs);
  const marketDraw = distribution(input.renderer.marketDrawMs);
  const inputToPaint = distribution(input.renderer.inputToPaintMs);
  const longTasks = distribution(input.runtime.longTasks);
  const taskDurationSeconds = metricDelta(input.performanceBefore, input.performanceAfter, "TaskDuration");
  const scriptDurationSeconds = metricDelta(input.performanceBefore, input.performanceAfter, "ScriptDuration");
  const animationFrameRateFps = input.sample.frameIntervalsMs.length > 0
    ? 1_000 / (input.sample.frameIntervalsMs.reduce((sum, item) => sum + item, 0) / input.sample.frameIntervalsMs.length)
    : null;
  const marketDrawRate = durationMs > 0
    ? input.renderer.marketDrawMs.length / (durationMs / 1_000)
    : null;
  const droppedFrameRatio = input.sample.frameIntervalsMs.length > 0
    ? input.sample.frameIntervalsMs.filter((item) => item > 25).length / input.sample.frameIntervalsMs.length
    : null;

  return {
    benchmarkSchemaVersion: 1,
    benchmarkKind: "headless-chrome-renderer-synthetic-stress",
    generatedAt: new Date().toISOString(),
    command: `node --import tsx scripts/browser/measure-renderer.ts --duration ${options.durationSeconds} --target-frames ${options.targetFrames} --seed ${options.seed}`,
    caveat: "Reference-host synthetic renderer measurement. It is not a Binance event-rate measurement and does not certify the agreed minimum device.",
    configuration: {
      ...options,
      applicationUrl: input.applicationUrl,
      sourceIntervalMs: 100,
      source: "deterministic prefilled 1,800-frame renderer dataset",
    },
    environment: {
      hostname: hostname(),
      os: `${platform()} ${release()}`,
      architecture: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      hostMemoryBytes: totalmem(),
      chromePath: input.chromePath,
      ...input.browser,
    },
    workload: {
      warmup: input.warmup,
      latest: input.renderer.latest,
      sampleDurationMs: durationMs,
      marketDrawCount: input.renderer.marketDrawMs.length,
      animationFrameCount: input.sample.frameIntervalsMs.length,
    },
    results: {
      animationFrameRateFps,
      animationFrameIntervalMs: frameIntervals,
      droppedFrameRatioOver25Ms: droppedFrameRatio,
      marketDrawRatePerSecond: marketDrawRate,
      marketDrawMs: marketDraw,
      inputToPaintMs: inputToPaint,
      longTasks,
      taskCpuRatio: durationMs > 0 ? taskDurationSeconds / (durationMs / 1_000) : null,
      scriptCpuRatio: durationMs > 0 ? scriptDurationSeconds / (durationMs / 1_000) : null,
      jsHeapStartBytes: input.sample.heapStartBytes,
      jsHeapEndBytes: input.sample.heapEndBytes,
      jsHeapDeltaBytes:
        input.sample.heapStartBytes === null || input.sample.heapEndBytes === null
          ? null
          : input.sample.heapEndBytes - input.sample.heapStartBytes,
      runtimeErrors: input.runtime.errors,
    },
    referenceChecks: {
      warmupReached1800Frames: input.warmup.reachedTarget,
      animationFrameRateAtLeast30: animationFrameRateFps !== null && animationFrameRateFps >= 30,
      marketDrawP95Below25Ms: marketDraw.p95 !== null && marketDraw.p95 < 25,
      localInputToPaintP95Below150Ms: inputToPaint.p95 !== null && inputToPaint.p95 < 150,
      noLongTasks: longTasks.count === 0,
      noRuntimeErrors: input.runtime.errors.length === 0,
    },
  };
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) {
    return { count: 0, mean: null, p50: null, p95: null, p99: null, max: null };
  }
  const sorted = values.slice().sort((left, right) => left - right);
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, item) => sum + item, 0) / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? null,
  };
}

function percentile(sorted: number[], ratio: number): number {
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function metricDelta(before: PerformanceMetricMap, after: PerformanceMetricMap, name: string): number {
  return Math.max(0, (after[name] ?? 0) - (before[name] ?? 0));
}

function renderMarkdown(report: ReturnType<typeof buildReport>): string {
  const number = (value: number | null, digits = 2) =>
    value === null ? "n/a" : value.toFixed(digits);
  const bytes = (value: number | null) =>
    value === null ? "n/a" : `${(value / 1024 / 1024).toFixed(2)} MiB`;
  const check = (value: boolean) => value ? "PASS" : "FAIL";
  const latest = report.workload.latest;
  return `# Phase 0 browser renderer baseline

> ${report.caveat}

Generated: ${report.generatedAt}  
Kind: \`${report.benchmarkKind}\`  
Command: \`${report.command}\`

## Environment

| Field | Value |
|---|---|
| Host | \`${report.environment.hostname}\` |
| OS | \`${report.environment.os}\` |
| CPU | ${report.environment.cpu} |
| Logical CPUs | ${report.environment.logicalCpuCount} |
| Host memory | ${bytes(report.environment.hostMemoryBytes)} |
| Browser | ${report.environment.userAgent} |
| Browser viewport | ${report.environment.viewport.width}×${report.environment.viewport.height}, DPR ${report.environment.devicePixelRatio} |
| WebGL renderer | ${report.environment.webglRenderer ?? "unavailable"} |

## Workload

- Deterministic seed: \`${report.configuration.seed}\`.
- Browser demo input cadence: ${report.configuration.sourceIntervalMs} ms (synthetic stress).
- Warm-up target: ${report.workload.warmup.targetFrames} depth frames; reached: ${report.workload.warmup.reachedTarget ? "yes" : "no"} in ${(report.workload.warmup.elapsedMs / 1_000).toFixed(1)} s.
- Retained window at sample end: ${latest?.depthFrames ?? 0} depth frames, ${latest?.trades ?? 0} trade buckets, ${latest?.prices ?? 0} price points.
- Canvas CSS/backing size: ${latest?.width ?? 0}×${latest?.height ?? 0} / ${latest?.backingWidth ?? 0}×${latest?.backingHeight ?? 0} at DPR ${latest?.dpr ?? 0}.
- Measured duration: ${(report.workload.sampleDurationMs / 1_000).toFixed(2)} s.

## Results

| Metric | Result | Reference check |
|---|---:|---:|
| Animation frame rate | ${number(report.results.animationFrameRateFps)} FPS | ${check(report.referenceChecks.animationFrameRateAtLeast30)} >= 30 FPS |
| Frame interval p95 / p99 | ${number(report.results.animationFrameIntervalMs.p95)} / ${number(report.results.animationFrameIntervalMs.p99)} ms | diagnostic |
| Frame intervals > 25 ms | ${number((report.results.droppedFrameRatioOver25Ms ?? 0) * 100)}% | diagnostic |
| Market-layer draw rate | ${number(report.results.marketDrawRatePerSecond)} draw/s | diagnostic |
| Market-layer draw p50 / p95 / p99 | ${number(report.results.marketDrawMs.p50)} / ${number(report.results.marketDrawMs.p95)} / ${number(report.results.marketDrawMs.p99)} ms | ${check(report.referenceChecks.marketDrawP95Below25Ms)} p95 < 25 ms |
| Local input-to-paint p50 / p95 / p99 | ${number(report.results.inputToPaintMs.p50)} / ${number(report.results.inputToPaintMs.p95)} / ${number(report.results.inputToPaintMs.p99)} ms | ${check(report.referenceChecks.localInputToPaintP95Below150Ms)} p95 < 150 ms |
| Long tasks (>50 ms) | ${report.results.longTasks.count} | ${check(report.referenceChecks.noLongTasks)} none during sample |
| Main-thread task ratio | ${number((report.results.taskCpuRatio ?? 0) * 100)}% | diagnostic |
| JavaScript heap start / end / delta | ${bytes(report.results.jsHeapStartBytes)} / ${bytes(report.results.jsHeapEndBytes)} / ${bytes(report.results.jsHeapDeltaBytes)} | short-run diagnostic |
| Runtime errors | ${report.results.runtimeErrors.length} | ${check(report.referenceChecks.noRuntimeErrors)} none |

## Interpretation

This run exercises the real production React and Canvas code with the full 1,800-frame client buffer and deterministic 10 Hz redraw/input cadence. It measures browser animation cadence, synchronous market-layer draw time, local input-to-paint delay, long tasks, and short-run heap behavior.

It is deliberately a stress workload, not a claim about Binance traffic. Headless Chrome and the listed GPU renderer may differ from a visible browser. The beta release gate still requires a repeat on the agreed minimum physical device, a normal-rate live/replay workload, and a long soak for memory growth.
`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
}
