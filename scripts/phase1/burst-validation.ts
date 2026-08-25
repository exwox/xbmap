import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AnalyticsEngine } from "../../server/core/analytics.js";
import { OrderBook } from "../../server/core/orderBook.js";
import type { DepthSnapshot, DepthUpdate, NormalizedTrade } from "../../server/types.js";
import { fingerprintBook } from "./book-state.js";
import { REPOSITORY_ROOT } from "./fixture-loader.js";
import type { Phase1ValidationReport, ValidationCaseResult } from "./types.js";

const BASELINE_PATH = "docs/baselines/phase-0-synthetic-benchmark.json";

interface BenchmarkBaseline {
  results: {
    gateway: {
      workloadRates: {
        depthUpdatesPerSecond: number;
        tradesPerSecond: number;
      };
    };
  };
}

export async function readBurstBaseline(multiplier = 3): Promise<Phase1ValidationReport["baseline"]> {
  if (!Number.isFinite(multiplier) || multiplier < 3) {
    throw new Error("Burst multiplier must be at least 3");
  }
  const bytes = await readFile(path.join(REPOSITORY_ROOT, BASELINE_PATH), "utf8");
  const parsed = JSON.parse(bytes) as BenchmarkBaseline;
  const rates = parsed.results?.gateway?.workloadRates;
  if (
    !rates ||
    !Number.isFinite(rates.depthUpdatesPerSecond) ||
    !Number.isFinite(rates.tradesPerSecond)
  ) {
    throw new Error("Phase 0 baseline does not contain gateway workload rates");
  }
  const total = rates.depthUpdatesPerSecond + rates.tradesPerSecond;
  return {
    source: BASELINE_PATH,
    depthUpdatesPerSecond: rates.depthUpdatesPerSecond,
    tradesPerSecond: rates.tradesPerSecond,
    totalMarketEventsPerSecond: total,
    burstMultiplier: multiplier,
    burstMarketEventsPerSecond: total * multiplier,
  };
}

export async function validateThreeTimesBurst(
  multiplier = 3,
  modeledDurationSeconds = 5,
): Promise<ValidationCaseResult> {
  const invariant =
    "A deterministic input burst at no less than three times the Phase 0 peak profile is processed without a sequence error, invalid book, or throughput deficit.";
  try {
    const baseline = await readBurstBaseline(multiplier);
    const depthPerSecond = baseline.depthUpdatesPerSecond * multiplier;
    const tradesPerSecond = baseline.tradesPerSecond * multiplier;
    const cyclesPerSecond = 10;
    assert(Number.isInteger(depthPerSecond / cyclesPerSecond), "depth rate must divide 10 Hz");
    assert(Number.isInteger(tradesPerSecond / cyclesPerSecond), "trade rate must divide 10 Hz");

    const book = new OrderBook(0.1);
    book.loadSnapshot(makeSnapshot());
    const analytics = new AnalyticsEngine({ trendEnterScore: 65, trendExitScore: 50 });
    const started = performance.now();
    const baseTimestamp = 1_735_700_000_000;
    let sequence = 10_000;
    let depthApplied = 0;
    let tradesApplied = 0;
    let failures = 0;
    const cycleCount = modeledDurationSeconds * cyclesPerSecond;

    for (let cycle = 0; cycle < cycleCount; cycle += 1) {
      const cycleTimestamp = baseTimestamp + cycle * 100;
      for (let index = 0; index < depthPerSecond / cyclesPerSecond; index += 1) {
        const nextSequence = sequence + 1;
        const quantity = 1 + ((cycle * 31 + index * 17) % 400) / 100;
        const update: DepthUpdate = {
          exchangeTimestamp: cycleTimestamp + Math.floor(index / 3),
          receivedTimestamp: cycleTimestamp + Math.floor(index / 3) + 2,
          sequenceStart: nextSequence,
          sequenceEnd: nextSequence,
          previousSequence: sequence,
          bids: [[63_999.9, quantity]],
          asks: [[64_000.1, 5.5 - quantity / 2]],
        };
        const result = book.applyUpdate(update);
        if (result.status === "applied") depthApplied += 1;
        else failures += 1;
        sequence = nextSequence;
      }

      for (let index = 0; index < tradesPerSecond / cyclesPerSecond; index += 1) {
        const buy = (cycle + index) % 2 === 0;
        const trade: NormalizedTrade = {
          id: `burst-${cycle}-${index}`,
          exchangeTimestamp: cycleTimestamp + Math.floor(index / 9),
          receivedTimestamp: cycleTimestamp + Math.floor(index / 9) + 2,
          price: buy ? 64_000.1 : 63_999.9,
          quantity: 0.01 + ((cycle * 13 + index * 7) % 50) / 1_000,
          side: buy ? "buy" : "sell",
        };
        analytics.onTrade(trade);
        tradesApplied += 1;
      }
      analytics.compute(book, cycleTimestamp + 99, false);
    }

    const wallDurationMs = performance.now() - started;
    const eventCount = depthApplied + tradesApplied;
    const modeledRate = eventCount / modeledDurationSeconds;
    const processingThroughput = eventCount / (wallDurationMs / 1_000);
    const fingerprint = fingerprintBook(book);
    assert(multiplier >= 3, "burst is below 3x baseline");
    assert(modeledRate >= baseline.burstMarketEventsPerSecond, "modeled event rate is too low");
    assert(processingThroughput >= baseline.burstMarketEventsPerSecond, "processor cannot sustain burst rate");
    assert(failures === 0, `${failures} depth updates were rejected`);
    assert(book.isSynchronized, "book lost synchronization during burst");
    assert(book.lastUpdateId === sequence, "final sequence does not match generated stream");

    return {
      id: "burst-three-times-baseline",
      passed: true,
      invariant,
      observations: [
        { key: "baselineMarketEventsPerSecond", value: baseline.totalMarketEventsPerSecond },
        { key: "burstMultiplier", value: multiplier },
        { key: "modeledDurationSeconds", value: modeledDurationSeconds },
        { key: "modeledMarketEventsPerSecond", value: modeledRate },
        { key: "depthUpdatesProcessed", value: depthApplied },
        { key: "tradesProcessed", value: tradesApplied },
        { key: "rejectedDepthUpdates", value: failures },
        { key: "processingWallDurationMs", value: round(wallDurationMs, 3) },
        { key: "processingThroughputEventsPerSecond", value: round(processingThroughput, 3) },
        { key: "finalBookFingerprint", value: fingerprint.value },
        { key: "fingerprintSource", value: fingerprint.source },
      ],
    };
  } catch (error) {
    return {
      id: "burst-three-times-baseline",
      passed: false,
      invariant,
      observations: [],
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

function makeSnapshot(): DepthSnapshot {
  const bids: DepthSnapshot["bids"] = [];
  const asks: DepthSnapshot["asks"] = [];
  for (let level = 1; level <= 20; level += 1) {
    bids.push([64_000 - level * 0.1, 1 + level / 10]);
    asks.push([64_000 + level * 0.1, 1 + level / 10]);
  }
  return {
    lastUpdateId: 10_000,
    exchangeTimestamp: 1_735_700_000_000,
    bids,
    asks,
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
