import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { AnalyticsEngine } from "../../server/core/analytics.js";
import { OrderBook } from "../../server/core/orderBook.js";
import { MarketGateway } from "../../server/marketGateway.js";
import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  type DepthSnapshot,
  type DepthUpdate,
  type NormalizedTrade,
  type ServerEnvelope,
} from "../../server/types.js";
import {
  normalizeMarketEvent,
  readWireEnvelopeMetadata,
} from "../../src/lib/marketNormalization";

const BENCHMARK_SCHEMA_VERSION = 1;
const DEFAULT_SEED = 1_480_744_257;
const BOOK_DEPTH = 200;
const CLIENT_DEPTH = 80;
const TICK_SIZE = 0.1;
const MID_TICKS = 640_000;
const SYNTHETIC_FRAME_INTERVAL_MS = 100;
const DEPTH_UPDATES_PER_FRAME = 10;
const TRADES_PER_FRAME = 30;

type ProfileName = "quick" | "baseline";

interface ProfileConfig {
  rounds: number;
  orderBookWarmup: number;
  orderBookIterations: number;
  orderBookLatencySamples: number;
  analyticsTradeHistory: number;
  analyticsWarmup: number;
  analyticsIterations: number;
  analyticsLatencySamples: number;
  gatewayWarmupCycles: number;
  gatewayCycles: number;
  gatewayLatencySamples: number;
  clientWarmup: number;
  clientIterations: number;
  clientLatencySamples: number;
}

interface CliOptions {
  profile: ProfileName;
  seed: number;
  jsonPath?: string;
  markdownPath?: string;
  rounds?: number;
}

interface LatencyDistribution {
  samples: number;
  unit: "microseconds";
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  standardDeviation: number;
}

interface MemorySummary {
  startRssBytes: number;
  endRssBytes: number;
  peakRssBytes: number;
  rssDeltaBytes: number;
  startHeapUsedBytes: number;
  endHeapUsedBytes: number;
  peakHeapUsedBytes: number;
  heapDeltaBytes: number;
  retainedHeapDeltaAfterGcBytes: number | null;
}

interface ThroughputRound {
  round: number;
  operations: number;
  wallMs: number;
  operationsPerSecond: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuTotalMs: number;
  cpuUtilizationPercent: number;
  memory: MemorySummary;
}

interface ScenarioResult {
  name: string;
  syntheticWorkload: string;
  operationUnit: string;
  rounds: ThroughputRound[];
  aggregate: {
    totalOperations: number;
    totalWallMs: number;
    operationsPerSecond: number;
    perRoundOperationsPerSecond: NumericSummary;
    cpuUserMs: number;
    cpuSystemMs: number;
    cpuTotalMs: number;
    cpuUtilizationPercent: number;
    peakRssBytes: number;
    peakHeapUsedBytes: number;
    maximumRetainedHeapDeltaAfterGcBytes: number | null;
  };
  latency: LatencyDistribution;
}

interface NumericSummary {
  min: number;
  median: number;
  mean: number;
  max: number;
  standardDeviation: number;
}

interface FrameTypeLoad {
  messagesPerSecond: number;
  jsonBytesPerSecond: number;
  webSocketBytesPerSecond: number;
  meanJsonPayloadBytes: number;
  p95JsonPayloadBytes: number;
}

interface ClientFrameLoadProfile {
  depthLevelsPerSide: number;
  modeledSeconds: number;
  messagesPerSecond: number;
  jsonBytesPerSecond: number;
  webSocketBytesPerSecond: number;
  webSocketMegabitsPerSecond: number;
  oneOffSubscriptionSnapshotJsonBytes: number;
  oneOffSubscriptionSnapshotWebSocketBytes: number;
  byEventType: Record<string, FrameTypeLoad>;
}

interface GatewayResult extends ScenarioResult {
  workloadRates: {
    frameRateHz: number;
    depthUpdatesPerSecond: number;
    tradesPerSecond: number;
    inputMarketEventsPerCycle: number;
    totalInputMarketEvents: number;
    inputMarketEventsPerWallSecond: number;
  };
  emittedEventCounts: Record<string, number>;
  clientFrameLoad: ClientFrameLoadProfile[];
  linearFanoutEstimate: Array<{
    clients: number;
    depthLevelsPerSide: number;
    aggregateWebSocketMegabitsPerSecond: number;
  }>;
}

interface BenchmarkReport {
  benchmarkSchemaVersion: number;
  benchmarkKind: "offline-deterministic-synthetic";
  generatedAt: string;
  invocation: string;
  seed: number;
  profile: ProfileName;
  environment: ReturnType<typeof collectEnvironment>;
  configuration: ProfileConfig;
  results: {
    orderBook: ScenarioResult;
    analytics: ScenarioResult;
    gateway: GatewayResult;
    clientWireDecode: ScenarioResult;
  };
  audit: {
    productionPathsExercised: string[];
    observations: string[];
    gapsNotMeasured: string[];
  };
  caveats: string[];
}

interface BenchmarkState {
  operation(iteration: number): void;
  dispose?(): void;
}

interface CapturedEnvelope {
  event: ServerEnvelope;
  defaultDepthPayloadBytes: number;
}

interface GatewayPrivateAccess {
  started: boolean;
  processSnapshot(source: "binance", snapshot: DepthSnapshot, resetAnalytics?: boolean): void;
  processDepth(source: "binance", update: DepthUpdate): void;
  processTrade(source: "binance", trade: NormalizedTrade): void;
  emitFrame(): void;
}

const PROFILES: Record<ProfileName, ProfileConfig> = {
  quick: {
    rounds: 1,
    orderBookWarmup: 1_000,
    orderBookIterations: 8_000,
    orderBookLatencySamples: 1_000,
    analyticsTradeHistory: 30_000,
    analyticsWarmup: 5,
    analyticsIterations: 20,
    analyticsLatencySamples: 15,
    gatewayWarmupCycles: 5,
    gatewayCycles: 30,
    gatewayLatencySamples: 15,
    clientWarmup: 250,
    clientIterations: 2_000,
    clientLatencySamples: 500,
  },
  baseline: {
    rounds: 3,
    orderBookWarmup: 10_000,
    orderBookIterations: 100_000,
    orderBookLatencySamples: 10_000,
    analyticsTradeHistory: 30_000,
    analyticsWarmup: 20,
    analyticsIterations: 300,
    analyticsLatencySamples: 200,
    gatewayWarmupCycles: 25,
    gatewayCycles: 300,
    gatewayLatencySamples: 150,
    clientWarmup: 2_000,
    clientIterations: 20_000,
    clientLatencySamples: 5_000,
  },
};

let blackhole = 0;

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  const configuration = {
    ...PROFILES[options.profile],
    ...(options.rounds === undefined ? {} : { rounds: options.rounds }),
  };
  const command = invocationFor(options, configuration.rounds);

  console.log(`LiquidMap offline synthetic benchmark (${options.profile}, ${configuration.rounds} round(s))`);
  if (typeof globalThis.gc !== "function") {
    console.warn("Warning: global.gc is unavailable; rerun with --expose-gc for retained-memory measurements.");
  }

  const orderBook = benchmarkScenario(
    {
      name: "order_book_apply_delta_8_levels",
      syntheticWorkload: `${BOOK_DEPTH} levels/side; each sequenced delta changes 4 bid and 4 ask levels`,
      operationUnit: "depth updates",
      rounds: configuration.rounds,
      warmup: configuration.orderBookWarmup,
      iterations: configuration.orderBookIterations,
      latencySamples: configuration.orderBookLatencySamples,
    },
    (round) => createOrderBookState(options.seed + round * 101),
  );
  printScenario(orderBook);

  const analytics = benchmarkScenario(
    {
      name: "analytics_compute_full_ring",
      syntheticWorkload: `${configuration.analyticsTradeHistory} trades in the 30s ring; 200 book levels/side`,
      operationUnit: "analytics frames",
      rounds: configuration.rounds,
      warmup: configuration.analyticsWarmup,
      iterations: configuration.analyticsIterations,
      latencySamples: configuration.analyticsLatencySamples,
    },
    (round) => createAnalyticsState(options.seed + round * 211, configuration.analyticsTradeHistory),
  );
  printScenario(analytics);

  const gatewayBase = benchmarkScenario(
    {
      name: "gateway_one_client_pipeline",
      syntheticWorkload: "per cycle: 10 depth deltas, 30 trades, one frame; one 80-level client JSON serialization",
      operationUnit: "100ms gateway cycles",
      rounds: configuration.rounds,
      warmup: configuration.gatewayWarmupCycles,
      iterations: configuration.gatewayCycles,
      latencySamples: configuration.gatewayLatencySamples,
    },
    (round) => createGatewayState(options.seed + round * 307),
  );

  const gatewayLoadState = createGatewayState(options.seed + 99_991);
  for (let index = 0; index < configuration.gatewayWarmupCycles; index += 1) {
    gatewayLoadState.operation(index);
  }
  gatewayLoadState.resetCapture();
  for (let index = 0; index < configuration.gatewayCycles; index += 1) {
    gatewayLoadState.operation(configuration.gatewayWarmupCycles + index);
  }
  const clientFrameLoad = buildClientFrameLoad(
    gatewayLoadState.gateway,
    gatewayLoadState.captured,
    configuration.gatewayCycles * SYNTHETIC_FRAME_INTERVAL_MS / 1_000,
  );
  const emittedEventCounts = countEventTypes(gatewayLoadState.captured);
  gatewayLoadState.dispose();
  const gateway: GatewayResult = {
    ...gatewayBase,
    workloadRates: {
      frameRateHz: 1_000 / SYNTHETIC_FRAME_INTERVAL_MS,
      depthUpdatesPerSecond: DEPTH_UPDATES_PER_FRAME * 1_000 / SYNTHETIC_FRAME_INTERVAL_MS,
      tradesPerSecond: TRADES_PER_FRAME * 1_000 / SYNTHETIC_FRAME_INTERVAL_MS,
      inputMarketEventsPerCycle: DEPTH_UPDATES_PER_FRAME + TRADES_PER_FRAME,
      totalInputMarketEvents:
        configuration.gatewayCycles * (DEPTH_UPDATES_PER_FRAME + TRADES_PER_FRAME),
      inputMarketEventsPerWallSecond:
        gatewayBase.aggregate.operationsPerSecond *
        (DEPTH_UPDATES_PER_FRAME + TRADES_PER_FRAME),
    },
    emittedEventCounts,
    clientFrameLoad,
    linearFanoutEstimate: [1, 10, 100].map((clients) => {
      const defaultProfile = clientFrameLoad.find(
        (item) => item.depthLevelsPerSide === CLIENT_DEPTH,
      )!;
      return {
        clients,
        depthLevelsPerSide: CLIENT_DEPTH,
        aggregateWebSocketMegabitsPerSecond:
          round(defaultProfile.webSocketMegabitsPerSecond * clients, 6),
      };
    }),
  };
  printScenario(gateway);

  const wirePayload = createDepthWirePayload(CLIENT_DEPTH);
  const clientWireDecode = benchmarkScenario(
    {
      name: "client_wire_metadata_and_normalization",
      syntheticWorkload: `${Buffer.byteLength(wirePayload)}-byte JSON depth frame with ${CLIENT_DEPTH} levels/side; metadata read plus normalization`,
      operationUnit: "wire depth frames",
      rounds: configuration.rounds,
      warmup: configuration.clientWarmup,
      iterations: configuration.clientIterations,
      latencySamples: configuration.clientLatencySamples,
    },
    () => createClientDecodeState(wirePayload),
  );
  printScenario(clientWireDecode);

  const report: BenchmarkReport = {
    benchmarkSchemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmarkKind: "offline-deterministic-synthetic",
    generatedAt: new Date().toISOString(),
    invocation: command,
    seed: options.seed,
    profile: options.profile,
    environment: collectEnvironment(),
    configuration,
    results: { orderBook, analytics, gateway, clientWireDecode },
    audit: {
      productionPathsExercised: [
        "server/core/orderBook.ts: OrderBook.loadSnapshot/applyUpdate",
        "server/core/analytics.ts: AnalyticsEngine.onTrade/compute and TrendDetector",
        "server/marketGateway.ts: processSnapshot/processDepth/processTrade/emitFrame",
        "server/httpServer.ts behavior replicated: per-client depth trim + JSON.stringify",
        "src/lib/marketNormalization.ts: readWireEnvelopeMetadata + normalizeMarketEvent",
      ],
      observations: [
        "OrderBook.applyUpdate performs crossed-book validation by scanning both maps for best prices on every accepted delta.",
        "OrderBook.getLevels sorts complete maps; each gateway frame calls it for depth output and analytics imbalance calls it again.",
        "AnalyticsEngine.compute copies and filters the full trade ring and copies the full CVD ring on every frame; volume ratio also builds and sorts temporary collections.",
        "The gateway builds 200 levels/side before the WebSocket layer trims each client independently; JSON serialization is repeated for every client.",
        "The browser transport parses each string envelope once for sequence metadata and again during normalization.",
        "The app retains up to 1,800 depth frames and exposes a fresh RingBuffer array on every depth event; at 80 levels/side that is up to 288,000 retained level objects traversed by heatmap preparation/drawing.",
        "Canvas work is requestAnimationFrame-scheduled, but a new data reference schedules redraws at the 10 Hz gateway frame rate; actual FPS still depends on viewport, DPR, browser, and device.",
      ],
      gapsNotMeasured: [
        "Real Binance event rates in quiet, trending, and volatile periods",
        "Exchange-to-gateway, gateway-to-browser, and event-to-screen network latency",
        "Browser Canvas FPS and main-thread long tasks on the minimum supported device",
        "Actual WebSocket fanout CPU, kernel socket buffers, TLS, proxies, packet overhead, and slow clients",
        "Long-running RSS/heap behavior, garbage-collection pauses, reconnect, and sequence-gap recovery",
      ],
    },
    caveats: [
      "Every measured market event is deterministic and synthetic; no external network or exchange connection is used.",
      "Throughput is a saturation result on one Node.js process, not a production capacity promise.",
      "Latency is synchronous processing time, not event-to-screen latency; per-operation timing uses process.hrtime.bigint().",
      "WebSocket byte estimates include uncompressed JSON payload and the server-to-client WebSocket frame header only.",
      "Fanout bandwidth is a linear estimate; the harness does not create sockets or measure per-client send CPU.",
      "Compare regressions only with the same profile, seed, runtime flags, machine allocation, and similarly idle host.",
    ],
  };

  if (options.jsonPath) {
    const path = resolve(options.jsonPath);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`JSON written: ${path}`);
  }
  if (options.markdownPath) {
    const path = resolve(options.markdownPath);
    writeFileSync(path, renderMarkdown(report), "utf8");
    console.log(`Markdown written: ${path}`);
  }

  // Keep benchmark outputs observably consumed without dumping them to stdout.
  if (!Number.isFinite(blackhole)) throw new Error("Benchmark checksum became non-finite");
}

function benchmarkScenario(
  definition: {
    name: string;
    syntheticWorkload: string;
    operationUnit: string;
    rounds: number;
    warmup: number;
    iterations: number;
    latencySamples: number;
  },
  createState: (round: number) => BenchmarkState,
): ScenarioResult {
  const rounds: ThroughputRound[] = [];

  for (let roundIndex = 0; roundIndex < definition.rounds; roundIndex += 1) {
    const state = createState(roundIndex);
    for (let index = 0; index < definition.warmup; index += 1) {
      state.operation(index);
    }
    forceGc();
    const startMemory = process.memoryUsage();
    let peakRssBytes = startMemory.rss;
    let peakHeapUsedBytes = startMemory.heapUsed;
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    const sampleEvery = Math.max(1, Math.floor(definition.iterations / 32));

    for (let index = 0; index < definition.iterations; index += 1) {
      state.operation(definition.warmup + index);
      if (index % sampleEvery === 0) {
        const memory = process.memoryUsage();
        peakRssBytes = Math.max(peakRssBytes, memory.rss);
        peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
      }
    }

    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    const endMemory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, endMemory.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, endMemory.heapUsed);
    forceGc();
    const afterGc = typeof globalThis.gc === "function" ? process.memoryUsage() : null;
    state.dispose?.();

    const cpuUserMs = cpu.user / 1_000;
    const cpuSystemMs = cpu.system / 1_000;
    const cpuTotalMs = cpuUserMs + cpuSystemMs;
    rounds.push({
      round: roundIndex + 1,
      operations: definition.iterations,
      wallMs: round(wallMs, 3),
      operationsPerSecond: round(definition.iterations / (wallMs / 1_000), 3),
      cpuUserMs: round(cpuUserMs, 3),
      cpuSystemMs: round(cpuSystemMs, 3),
      cpuTotalMs: round(cpuTotalMs, 3),
      cpuUtilizationPercent: round(cpuTotalMs / wallMs * 100, 3),
      memory: {
        startRssBytes: startMemory.rss,
        endRssBytes: endMemory.rss,
        peakRssBytes,
        rssDeltaBytes: endMemory.rss - startMemory.rss,
        startHeapUsedBytes: startMemory.heapUsed,
        endHeapUsedBytes: endMemory.heapUsed,
        peakHeapUsedBytes,
        heapDeltaBytes: endMemory.heapUsed - startMemory.heapUsed,
        retainedHeapDeltaAfterGcBytes:
          afterGc === null ? null : afterGc.heapUsed - startMemory.heapUsed,
      },
    });
  }

  const latencySamples: number[] = [];
  for (let roundIndex = 0; roundIndex < definition.rounds; roundIndex += 1) {
    const state = createState(10_000 + roundIndex);
    for (let index = 0; index < definition.warmup; index += 1) {
      state.operation(index);
    }
    for (let index = 0; index < definition.latencySamples; index += 1) {
      const startedAt = process.hrtime.bigint();
      state.operation(definition.warmup + index);
      const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
      latencySamples.push(Number(elapsedNanoseconds) / 1_000);
    }
    state.dispose?.();
  }

  const totalOperations = rounds.reduce((sum, item) => sum + item.operations, 0);
  const totalWallMs = rounds.reduce((sum, item) => sum + item.wallMs, 0);
  const cpuUserMs = rounds.reduce((sum, item) => sum + item.cpuUserMs, 0);
  const cpuSystemMs = rounds.reduce((sum, item) => sum + item.cpuSystemMs, 0);
  const cpuTotalMs = cpuUserMs + cpuSystemMs;
  const retainedValues = rounds
    .map((item) => item.memory.retainedHeapDeltaAfterGcBytes)
    .filter((value): value is number => value !== null);

  return {
    name: definition.name,
    syntheticWorkload: definition.syntheticWorkload,
    operationUnit: definition.operationUnit,
    rounds,
    aggregate: {
      totalOperations,
      totalWallMs: round(totalWallMs, 3),
      operationsPerSecond: round(totalOperations / (totalWallMs / 1_000), 3),
      perRoundOperationsPerSecond: numericSummary(
        rounds.map((item) => item.operationsPerSecond),
      ),
      cpuUserMs: round(cpuUserMs, 3),
      cpuSystemMs: round(cpuSystemMs, 3),
      cpuTotalMs: round(cpuTotalMs, 3),
      cpuUtilizationPercent: round(cpuTotalMs / totalWallMs * 100, 3),
      peakRssBytes: Math.max(...rounds.map((item) => item.memory.peakRssBytes)),
      peakHeapUsedBytes: Math.max(...rounds.map((item) => item.memory.peakHeapUsedBytes)),
      maximumRetainedHeapDeltaAfterGcBytes:
        retainedValues.length === 0 ? null : Math.max(...retainedValues),
    },
    latency: latencyDistribution(latencySamples),
  };
}

function createOrderBookState(seed: number): BenchmarkState {
  const book = new OrderBook(TICK_SIZE);
  let sequence = 10_000;
  let random = seed >>> 0;
  book.loadSnapshot(createSnapshot(sequence, BOOK_DEPTH));

  return {
    operation(iteration) {
      random = nextRandomState(random);
      const firstDistance = 2 + random % (BOOK_DEPTH - 8);
      const quantityBase = 0.25 + ((random >>> 8) % 10_000) / 1_000;
      const bids: Array<[number, number]> = [];
      const asks: Array<[number, number]> = [];
      for (let offset = 0; offset < 4; offset += 1) {
        const distance = firstDistance + offset;
        bids.push([(MID_TICKS - distance) * TICK_SIZE, quantityBase + offset * 0.01]);
        asks.push([(MID_TICKS + distance) * TICK_SIZE, quantityBase + offset * 0.015]);
      }
      const update: DepthUpdate = {
        exchangeTimestamp: 1_700_000_000_000 + iteration,
        receivedTimestamp: 1_700_000_000_001 + iteration,
        sequenceStart: sequence + 1,
        sequenceEnd: sequence + 1,
        previousSequence: sequence,
        bids,
        asks,
      };
      sequence += 1;
      const result = book.applyUpdate(update);
      if (result.status !== "applied") {
        throw new Error(`Synthetic order-book update failed: ${result.status} ${result.reason ?? ""}`);
      }
      blackhole += result.lastUpdateId & 1;
    },
  };
}

function createAnalyticsState(seed: number, tradeCount: number): BenchmarkState {
  const book = new OrderBook(TICK_SIZE);
  book.loadSnapshot(createSnapshot(50_000, BOOK_DEPTH));
  const analytics = new AnalyticsEngine(DEFAULT_SETTINGS);
  const now = Date.now();
  let random = seed >>> 0;

  for (let index = 0; index < tradeCount; index += 1) {
    random = nextRandomState(random);
    const side = (random & 1) === 0 ? "buy" : "sell";
    const timestamp = now - 29_999 + Math.floor(index * 29_999 / Math.max(1, tradeCount - 1));
    const waveTicks = Math.round(Math.sin(index / 79) * 8 + index / Math.max(1, tradeCount) * 4);
    analytics.onTrade({
      id: `analytics-${index}`,
      exchangeTimestamp: timestamp,
      receivedTimestamp: timestamp + 1,
      price: (MID_TICKS + waveTicks + (side === "buy" ? 1 : -1)) * TICK_SIZE,
      quantity: 0.001 + ((random >>> 10) % 5_000) / 10_000,
      side,
    });
  }

  return {
    operation(iteration) {
      const frame = analytics.compute(book, now + (iteration % 3), false);
      blackhole += frame.metric.tradeRate + frame.trend.score;
    },
  };
}

function createGatewayState(seed: number): BenchmarkState & {
  gateway: MarketGateway;
  captured: CapturedEnvelope[];
  resetCapture(): void;
  dispose(): void;
} {
  const gateway = new MarketGateway({
    forceDemo: false,
    tickSize: TICK_SIZE,
    settings: {
      frameIntervalMs: SYNTHETIC_FRAME_INTERVAL_MS,
      visibleDepth: CLIENT_DEPTH,
      bubbleBucketMs: 250,
      staleAfterMs: 3_000,
    },
  });
  const access = gateway as unknown as GatewayPrivateAccess;
  access.started = true;
  let sequence = 100_000;
  let tradeId = 0;
  let random = seed >>> 0;
  let captured: CapturedEnvelope[] = [];
  const receivedAnchor = Date.now();
  const exchangeAnchor = receivedAnchor - 2_000;

  const onEvent = (event: ServerEnvelope): void => {
    const payload = JSON.stringify(trimDepthForClient(event, CLIENT_DEPTH));
    captured.push({ event, defaultDepthPayloadBytes: Buffer.byteLength(payload) });
    blackhole += payload.length & 1;
  };
  gateway.on("event", onEvent);
  access.processSnapshot("binance", createSnapshot(sequence, BOOK_DEPTH));

  const state = {
    gateway,
    get captured() {
      return captured;
    },
    resetCapture() {
      captured = [];
    },
    operation(iteration: number) {
      for (let updateIndex = 0; updateIndex < DEPTH_UPDATES_PER_FRAME; updateIndex += 1) {
        random = nextRandomState(random);
        const distance = 2 + random % (BOOK_DEPTH - 5);
        const quantity = 0.1 + ((random >>> 9) % 20_000) / 1_000;
        const previousSequence = sequence;
        sequence += 1;
        access.processDepth("binance", {
          exchangeTimestamp: exchangeAnchor + (iteration % 10) * 10 + updateIndex,
          receivedTimestamp: receivedAnchor + iteration * SYNTHETIC_FRAME_INTERVAL_MS,
          sequenceStart: sequence,
          sequenceEnd: sequence,
          previousSequence,
          bids: [
            [(MID_TICKS - distance) * TICK_SIZE, quantity],
            [(MID_TICKS - distance - 1) * TICK_SIZE, quantity + 0.01],
            [(MID_TICKS - distance - 2) * TICK_SIZE, quantity + 0.02],
            [(MID_TICKS - distance - 3) * TICK_SIZE, quantity + 0.03],
          ],
          asks: [
            [(MID_TICKS + distance) * TICK_SIZE, quantity + 0.04],
            [(MID_TICKS + distance + 1) * TICK_SIZE, quantity + 0.05],
            [(MID_TICKS + distance + 2) * TICK_SIZE, quantity + 0.06],
            [(MID_TICKS + distance + 3) * TICK_SIZE, quantity + 0.07],
          ],
        });
      }

      for (let tradeIndex = 0; tradeIndex < TRADES_PER_FRAME; tradeIndex += 1) {
        random = nextRandomState(random);
        const side: NormalizedTrade["side"] = (random & 1) === 0 ? "buy" : "sell";
        access.processTrade("binance", {
          id: `gateway-${tradeId++}`,
          exchangeTimestamp:
            exchangeAnchor + (iteration % 10) * 10 + Math.floor(tradeIndex / 3),
          receivedTimestamp:
            receivedAnchor + iteration * SYNTHETIC_FRAME_INTERVAL_MS + tradeIndex * 3,
          price: (MID_TICKS + (side === "buy" ? 1 : -1)) * TICK_SIZE,
          quantity: 0.001 + ((random >>> 11) % 8_000) / 10_000,
          side,
        });
      }

      access.emitFrame();
      blackhole += sequence & 1;
    },
    dispose() {
      gateway.off("event", onEvent);
      gateway.stop();
    },
  };
  return state;
}

function createClientDecodeState(payload: string): BenchmarkState {
  const receivedAt = Date.now();
  return {
    operation() {
      const metadata = readWireEnvelopeMetadata(payload);
      const event = normalizeMarketEvent(payload, receivedAt);
      if (!event || event.type !== "depth_frame" || metadata.sequence === null) {
        throw new Error("Synthetic client payload did not normalize as a depth frame");
      }
      blackhole += event.bids.length + metadata.sequence;
    },
  };
}

function createSnapshot(lastUpdateId: number, depth: number): DepthSnapshot {
  const bids: Array<[number, number]> = [];
  const asks: Array<[number, number]> = [];
  for (let distance = 1; distance <= depth; distance += 1) {
    const base = 0.25 + Math.exp(-distance / 90) * 3;
    const wall = distance % 17 === 0 ? 8 : 0;
    bids.push([(MID_TICKS - distance) * TICK_SIZE, round(base + wall, 3)]);
    asks.push([(MID_TICKS + distance) * TICK_SIZE, round(base + wall * 0.9, 3)]);
  }
  return {
    lastUpdateId,
    exchangeTimestamp: Date.now() - 2_000,
    bids,
    asks,
  };
}

function createDepthWirePayload(depth: number): string {
  const snapshot = createSnapshot(777_777, depth);
  const bids = snapshot.bids;
  const asks = snapshot.asks;
  return JSON.stringify({
    type: "depth_frame",
    schemaVersion: SCHEMA_VERSION,
    exchange: "binance",
    symbol: "BTCUSDT",
    serverTimestamp: 1_700_000_000_010,
    exchangeTimestamp: 1_700_000_000_000,
    sequence: 888_888,
    data: {
      lastUpdateId: 777_777,
      bids,
      asks,
      bestBid: bids[0]?.[0] ?? null,
      bestAsk: asks[0]?.[0] ?? null,
      midPrice: MID_TICKS * TICK_SIZE,
      spread: TICK_SIZE * 2,
      stale: false,
      source: "binance",
    },
  } satisfies ServerEnvelope);
}

function buildClientFrameLoad(
  gateway: MarketGateway,
  captured: CapturedEnvelope[],
  modeledSeconds: number,
): ClientFrameLoadProfile[] {
  return [20, CLIENT_DEPTH, BOOK_DEPTH].map((depth) => {
    const samplesByType = new Map<string, number[]>();
    let jsonBytes = 0;
    let webSocketBytes = 0;

    for (const item of captured) {
      const payloadBytes = depth === CLIENT_DEPTH
        ? item.defaultDepthPayloadBytes
        : Buffer.byteLength(JSON.stringify(trimDepthForClient(item.event, depth)));
      jsonBytes += payloadBytes;
      webSocketBytes += payloadBytes + webSocketServerFrameHeaderBytes(payloadBytes);
      const samples = samplesByType.get(item.event.type) ?? [];
      samples.push(payloadBytes);
      samplesByType.set(item.event.type, samples);
    }

    const heartbeat = gateway.createEvent("heartbeat", {
      clientId: "00000000-0000-4000-8000-000000000000",
      uptimeMs: 3_600_000,
      droppedFrames: 0,
    });
    const heartbeatBytes = Buffer.byteLength(JSON.stringify(heartbeat));
    const heartbeatCount = modeledSeconds / 15;
    jsonBytes += heartbeatBytes * heartbeatCount;
    webSocketBytes +=
      (heartbeatBytes + webSocketServerFrameHeaderBytes(heartbeatBytes)) * heartbeatCount;
    samplesByType.set("heartbeat", [heartbeatBytes]);

    const snapshotPayload = JSON.stringify(gateway.getSnapshot(depth));
    const snapshotBytes = Buffer.byteLength(snapshotPayload);
    const byEventType: Record<string, FrameTypeLoad> = {};
    for (const [type, samples] of [...samplesByType].sort(([left], [right]) => left.localeCompare(right))) {
      const count = type === "heartbeat" ? heartbeatCount : samples.length;
      const typeJsonBytes = type === "heartbeat"
        ? heartbeatBytes * heartbeatCount
        : samples.reduce((sum, value) => sum + value, 0);
      const typeWebSocketBytes = type === "heartbeat"
        ? (heartbeatBytes + webSocketServerFrameHeaderBytes(heartbeatBytes)) * heartbeatCount
        : samples.reduce(
            (sum, value) => sum + value + webSocketServerFrameHeaderBytes(value),
            0,
          );
      byEventType[type] = {
        messagesPerSecond: round(count / modeledSeconds, 6),
        jsonBytesPerSecond: round(typeJsonBytes / modeledSeconds, 3),
        webSocketBytesPerSecond: round(typeWebSocketBytes / modeledSeconds, 3),
        meanJsonPayloadBytes: round(mean(samples), 3),
        p95JsonPayloadBytes: round(percentile(samples, 0.95), 3),
      };
    }

    return {
      depthLevelsPerSide: depth,
      modeledSeconds,
      messagesPerSecond: round((captured.length + heartbeatCount) / modeledSeconds, 6),
      jsonBytesPerSecond: round(jsonBytes / modeledSeconds, 3),
      webSocketBytesPerSecond: round(webSocketBytes / modeledSeconds, 3),
      webSocketMegabitsPerSecond: round(webSocketBytes * 8 / modeledSeconds / 1_000_000, 6),
      oneOffSubscriptionSnapshotJsonBytes: snapshotBytes,
      oneOffSubscriptionSnapshotWebSocketBytes:
        snapshotBytes + webSocketServerFrameHeaderBytes(snapshotBytes),
      byEventType,
    };
  });
}

function trimDepthForClient(event: ServerEnvelope, depth: number): ServerEnvelope {
  if (event.type !== "depth_frame" && event.type !== "snapshot") return event;
  if (!isPlainObject(event.data)) return event;
  const bids = Array.isArray(event.data.bids) ? event.data.bids.slice(0, depth) : [];
  const asks = Array.isArray(event.data.asks) ? event.data.asks.slice(0, depth) : [];
  return { ...event, data: { ...event.data, bids, asks } };
}

function countEventTypes(captured: CapturedEnvelope[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of captured) counts[item.event.type] = (counts[item.event.type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function webSocketServerFrameHeaderBytes(payloadBytes: number): number {
  if (payloadBytes <= 125) return 2;
  if (payloadBytes <= 65_535) return 4;
  return 10;
}

function collectEnvironment() {
  const cpuList = cpus();
  const packageVersions = readPackageVersions();
  const sourceFingerprint = fingerprintSourceFiles([
    "package-lock.json",
    "server/types.ts",
    "server/core/orderBook.ts",
    "server/core/analytics.ts",
    "server/core/tradeAggregator.ts",
    "server/core/ringBuffer.ts",
    "server/marketGateway.ts",
    "server/httpServer.ts",
    "src/lib/marketNormalization.ts",
    "src/lib/marketDataClient.ts",
    "src/lib/useMarketData.ts",
    "src/components/heatmap/draw.ts",
    "src/components/MarketHeatmap.tsx",
    "src/App.tsx",
    "scripts/bench/run.ts",
  ]);
  return {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    architecture: process.arch,
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    tsxVersion: packageVersions.tsx,
    typescriptVersion: packageVersions.typescript,
    executablePath: process.execPath,
    nodeExecArguments: process.execArgv,
    processArguments: process.argv.slice(1),
    cpuModel: cpuList[0]?.model.trim() ?? "unknown",
    logicalCpuCount: cpuList.length,
    cpuSpeedMHzReported: cpuList[0]?.speed ?? null,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtReport: freemem(),
    cgroupCpuMax: readOptionalText("/sys/fs/cgroup/cpu.max"),
    cgroupMemoryMax: readOptionalText("/sys/fs/cgroup/memory.max"),
    cgroupMemoryCurrent: readOptionalText("/sys/fs/cgroup/memory.current"),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    gcExposed: typeof globalThis.gc === "function",
    repositoryRevision: readRepositoryRevision(),
    sourceFingerprintSha256: sourceFingerprint.sha256,
    sourceFingerprintFiles: sourceFingerprint.files,
  };
}

function readPackageVersions(): { tsx: string | null; typescript: string | null } {
  try {
    const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8")) as {
      packages?: Record<string, { version?: string }>;
    };
    return {
      tsx: lock.packages?.["node_modules/tsx"]?.version ?? null,
      typescript: lock.packages?.["node_modules/typescript"]?.version ?? null,
    };
  } catch {
    return { tsx: null, typescript: null };
  }
}

function fingerprintSourceFiles(paths: string[]): { sha256: string; files: string[] } {
  const hash = createHash("sha256");
  const included: string[] = [];
  for (const path of [...paths].sort()) {
    try {
      const contents = readFileSync(resolve(path));
      hash.update(path);
      hash.update("\0");
      hash.update(contents);
      hash.update("\0");
      included.push(path);
    } catch {
      // The missing file is represented in the fingerprint instead of making
      // an otherwise useful benchmark impossible to run from a source bundle.
      hash.update(path);
      hash.update("\0missing\0");
    }
  }
  return { sha256: hash.digest("hex"), files: included };
}

function readRepositoryRevision(): string {
  const head = readOptionalText(resolve(".git/HEAD"));
  if (!head) return "unavailable (.git revision metadata not mounted)";
  if (!head.startsWith("ref:")) return head;
  const reference = head.slice(4).trim();
  return readOptionalText(resolve(".git", reference)) ?? reference;
}

function readOptionalText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function latencyDistribution(samples: number[]): LatencyDistribution {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    unit: "microseconds",
    min: round(sorted[0] ?? 0, 3),
    p50: round(percentileSorted(sorted, 0.5), 3),
    p90: round(percentileSorted(sorted, 0.9), 3),
    p95: round(percentileSorted(sorted, 0.95), 3),
    p99: round(percentileSorted(sorted, 0.99), 3),
    max: round(sorted.at(-1) ?? 0, 3),
    mean: round(mean(sorted), 3),
    standardDeviation: round(standardDeviation(sorted), 3),
  };
}

function numericSummary(values: number[]): NumericSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: round(sorted[0] ?? 0, 3),
    median: round(percentileSorted(sorted, 0.5), 3),
    mean: round(mean(sorted), 3),
    max: round(sorted.at(-1) ?? 0, 3),
    standardDeviation: round(standardDeviation(sorted), 3),
  };
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1),
  );
}

function percentile(values: number[], ratio: number): number {
  return percentileSorted([...values].sort((left, right) => left - right), ratio);
}

function percentileSorted(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * ratio));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return (sorted[lower] ?? 0) * (1 - fraction) + (sorted[upper] ?? 0) * fraction;
}

function nextRandomState(state: number): number {
  let next = (state + 0x6d2b79f5) | 0;
  next = Math.imul(next ^ (next >>> 15), 1 | next);
  next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
  return (next ^ (next >>> 14)) >>> 0;
}

function forceGc(): void {
  globalThis.gc?.();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function bytesMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

function number(value: number, decimals = 2): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function printScenario(result: ScenarioResult): void {
  console.log(
    `${result.name}: ${number(result.aggregate.operationsPerSecond)} ${result.operationUnit}/s; ` +
    `p95 ${number(result.latency.p95)}us; CPU ${number(result.aggregate.cpuUtilizationPercent, 1)}%; ` +
    `peak heap ${bytesMiB(result.aggregate.peakHeapUsedBytes)} MiB`,
  );
}

function parseArguments(args: string[]): CliOptions {
  const result: CliOptions = { profile: "baseline", seed: DEFAULT_SEED };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--profile") {
      if (value !== "quick" && value !== "baseline") {
        throw new Error("--profile must be quick or baseline");
      }
      result.profile = value;
      index += 1;
    } else if (argument === "--seed") {
      result.seed = parsePositiveInteger(value, "--seed", 0xffff_ffff);
      index += 1;
    } else if (argument === "--rounds") {
      result.rounds = parsePositiveInteger(value, "--rounds", 20);
      index += 1;
    } else if (argument === "--json") {
      if (!value) throw new Error("--json requires a path");
      result.jsonPath = value;
      index += 1;
    } else if (argument === "--markdown") {
      if (!value) throw new Error("--markdown requires a path");
      result.markdownPath = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node --expose-gc --import tsx scripts/bench/run.ts [--profile quick|baseline] [--seed N] [--rounds N] [--json path] [--markdown path]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return result;
}

function parsePositiveInteger(value: string | undefined, name: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function invocationFor(options: CliOptions, rounds: number): string {
  const parts = [
    "node",
    "--expose-gc",
    "--import",
    "tsx",
    "scripts/bench/run.ts",
    "--profile",
    options.profile,
    "--seed",
    String(options.seed),
  ];
  if (rounds !== PROFILES[options.profile].rounds) parts.push("--rounds", String(rounds));
  if (options.jsonPath) parts.push("--json", options.jsonPath);
  if (options.markdownPath) parts.push("--markdown", options.markdownPath);
  return parts.join(" ");
}

function renderMarkdown(report: BenchmarkReport): string {
  const { environment, configuration, results } = report;
  const scenarioRows = [
    results.orderBook,
    results.analytics,
    results.gateway,
    results.clientWireDecode,
  ].map((item) =>
    `| ${item.name} | ${number(item.aggregate.operationsPerSecond)} ${item.operationUnit}/s | ` +
    `${number(item.latency.p50)} | ${number(item.latency.p95)} | ${number(item.latency.p99)} | ` +
    `${number(item.aggregate.cpuUtilizationPercent, 1)}% | ${bytesMiB(item.aggregate.peakRssBytes)} | ` +
    `${bytesMiB(item.aggregate.peakHeapUsedBytes)} |`,
  ).join("\n");
  const loadRows = results.gateway.clientFrameLoad.map((item) =>
    `| ${item.depthLevelsPerSide} | ${number(item.messagesPerSecond)} | ` +
    `${number(item.jsonBytesPerSecond / 1024)} | ${number(item.webSocketBytesPerSecond / 1024)} | ` +
    `${number(item.webSocketMegabitsPerSecond, 4)} | ` +
    `${number(item.oneOffSubscriptionSnapshotJsonBytes / 1024)} |`,
  ).join("\n");
  const typeRows = Object.entries(
    results.gateway.clientFrameLoad.find((item) => item.depthLevelsPerSide === CLIENT_DEPTH)!.byEventType,
  ).map(([type, item]) =>
    `| ${type} | ${number(item.messagesPerSecond)} | ${number(item.meanJsonPayloadBytes)} | ` +
    `${number(item.p95JsonPayloadBytes)} | ${number(item.webSocketBytesPerSecond / 1024)} |`,
  ).join("\n");
  const fanoutRows = results.gateway.linearFanoutEstimate.map((item) =>
    `| ${item.clients} | ${item.depthLevelsPerSide} | ${number(item.aggregateWebSocketMegabitsPerSecond, 4)} |`,
  ).join("\n");
  const roundDetail = [
    results.orderBook,
    results.analytics,
    results.gateway,
    results.clientWireDecode,
  ].flatMap((scenario) => scenario.rounds.map((item) =>
    `| ${scenario.name} | ${item.round} | ${number(item.operationsPerSecond)} | ` +
    `${number(item.wallMs)} | ${number(item.cpuTotalMs)} | ${number(item.cpuUtilizationPercent, 1)}% | ` +
    `${bytesMiB(item.memory.rssDeltaBytes)} | ${bytesMiB(item.memory.heapDeltaBytes)} | ` +
    `${item.memory.retainedHeapDeltaAfterGcBytes === null ? "n/a" : bytesMiB(item.memory.retainedHeapDeltaAfterGcBytes)} |`,
  )).join("\n");

  return `# Phase 0 synthetic performance baseline

> Preliminary synthetic baseline. No Binance or other external network was used. These values are saturation and synchronous-processing measurements, not live-market event rates, browser FPS, or event-to-screen latency.

Generated: ${report.generatedAt}  
Profile: \`${report.profile}\`  
Seed: \`${report.seed}\`  
Command: \`${report.invocation}\`

## Environment

| Field | Value |
|---|---|
| Host | \`${environment.hostname}\` |
| OS | \`${environment.platform} ${environment.release}\` |
| Architecture | \`${environment.architecture}\` |
| Node / V8 | \`${environment.nodeVersion}\` / \`${environment.v8Version}\` |
| tsx / TypeScript | \`${environment.tsxVersion ?? "unknown"}\` / \`${environment.typescriptVersion ?? "unknown"}\` |
| CPU | ${environment.cpuModel} |
| Logical CPUs visible | ${environment.logicalCpuCount} |
| Reported CPU speed | ${environment.cpuSpeedMHzReported ?? "unknown"} MHz |
| Host memory | ${bytesMiB(environment.totalMemoryBytes)} MiB |
| cgroup CPU limit | \`${environment.cgroupCpuMax ?? "not exposed"}\` |
| cgroup memory limit | \`${environment.cgroupMemoryMax ?? "not exposed"}\` |
| GC exposed | ${environment.gcExposed ? "yes" : "no"} |
| Repository revision | \`${environment.repositoryRevision}\` |
| Source fingerprint (SHA-256) | \`${environment.sourceFingerprintSha256}\` |
| Timezone | \`${environment.timezone}\` |

The host allocation and current load affect these numbers. Repeat on the future minimum supported device before setting product release gates.

## Configuration and methodology

- ${configuration.rounds} measured rounds per scenario, after scenario-specific warm-up.
- Order book: ${BOOK_DEPTH} levels per side; ${configuration.orderBookIterations.toLocaleString("en-US")} eight-level sequenced deltas per round.
- Analytics: full ${configuration.analyticsTradeHistory.toLocaleString("en-US")}-trade and CVD rings; ${configuration.analyticsIterations.toLocaleString("en-US")} computes per round.
- Gateway: ${configuration.gatewayCycles.toLocaleString("en-US")} synthetic 100 ms cycles per round, each with ${DEPTH_UPDATES_PER_FRAME} depth deltas and ${TRADES_PER_FRAME} trades, plus one 80-level client serialization.
- Client: actual metadata-read plus normalization path for a ${Buffer.byteLength(createDepthWirePayload(CLIENT_DEPTH)).toLocaleString("en-US")}-byte, 80-level/side JSON frame.
- Throughput passes do not take a timestamp around every operation. Latency percentiles come from separate warmed passes using \`process.hrtime.bigint()\`.
- Synthetic input-object construction is included in each operation; network decoding is not included except in the explicit client wire scenario.
- CPU is process user + system time divided by wall time. It can exceed 100% because \`process.cpuUsage()\` includes Node/V8 helper-thread work such as parallel GC. Memory is process-level RSS/heap sampled during each synchronous pass; retained heap is sampled after an explicit GC.

## Results

| Scenario | Aggregate throughput | p50 latency (us) | p95 latency (us) | p99 latency (us) | CPU / wall | Peak RSS (MiB) | Peak heap (MiB) |
|---|---:|---:|---:|---:|---:|---:|---:|
${scenarioRows}

The gateway throughput unit is one full synthetic 100 ms cycle. Its aggregate input processing rate is ${number(results.gateway.workloadRates.inputMarketEventsPerWallSecond)} synthetic market events/s. This is a saturation figure with one serialized client, not a supported live event rate.

## Estimated WebSocket frame load

The modeled stream is ${results.gateway.workloadRates.frameRateHz} frame cycles/s, ${results.gateway.workloadRates.depthUpdatesPerSecond} depth deltas/s, and ${results.gateway.workloadRates.tradesPerSecond} trades/s. The gateway aggregates these into outbound envelopes. Estimates include JSON UTF-8 bytes and the unmasked server WebSocket frame header; per-message compression is disabled in production.

| Depth levels/side | Messages/s | JSON KiB/s | WS KiB/s | WS Mbit/s | One-off snapshot KiB |
|---:|---:|---:|---:|---:|---:|
${loadRows}

Default 80-level client by event type:

| Event | Messages/s | Mean JSON bytes | p95 JSON bytes | WS KiB/s |
|---|---:|---:|---:|---:|
${typeRows}

Linear egress-only fanout estimate for the default 80-level subscription:

| Clients | Depth levels/side | Aggregate WS Mbit/s |
|---:|---:|---:|
${fanoutRows}

This excludes TCP/IP, TLS, reverse proxies, retransmission, client-to-server traffic, and the CPU/kernel cost of real sockets. Startup subscription/snapshot traffic is shown separately and is not included in steady-state bytes/s.

## Implementation audit

${report.audit.observations.map((item) => `- ${item}`).join("\n")}

## Per-round CPU, wall time, and memory

Negative memory deltas mean GC released allocations made before the measured pass. RSS is allocator/process-level and can remain high after heap collection.

| Scenario | Round | Ops/s | Wall ms | CPU ms | CPU / wall | RSS delta MiB | Heap delta MiB | Retained heap delta MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${roundDetail}

## What remains before Phase 0 performance targets are final

${report.audit.gapsNotMeasured.map((item) => `- ${item}`).join("\n")}

## Interpretation and next actions

1. Treat this file as a regression baseline for core hot paths on this exact environment, not as a beta SLO.
2. Capture real exchange traffic for quiet, trending, volatile, and reconnect regimes; replay it through the same production paths.
3. Add a browser benchmark on the agreed minimum device for Canvas FPS, frame time p95/p99, long tasks, and memory over a full 1,800-frame window.
4. Load-test actual WebSocket connections at 1, 10, and 100 clients, including a slow consumer and backpressure behavior.
5. Profile repeated book sorting/scanning, analytics full-ring copies, per-client serialization, and the client's double JSON parse before optimizing.

## Caveats

${report.caveats.map((item) => `- ${item}`).join("\n")}
`;
}

main();
