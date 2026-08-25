import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { InsightEngine, INSIGHTS_ALGO_VERSION } from "../../server/insights/insightEngine.js";
import {
  AlertEngine,
  ALERT_ALGO_VERSION,
  SIGNAL_HORIZONS_MS,
  type PerformanceRow,
} from "../../server/alerts/alertEngine.js";
import type { InsightFrame } from "../../server/insights/insightEngine.js";
import type { ServerEnvelope } from "../../server/types.js";
import {
  PHASE5_VALIDATION_SCHEMA_VERSION,
  type Phase5Assertion,
  type Phase5ValidationCase,
  type Phase5ValidationReport,
} from "./types.js";

function assertion(
  name: string,
  passed: boolean,
  expected: string | number | boolean,
  actual: string | number | boolean,
): Phase5Assertion {
  return { name, passed, expected, actual };
}

function assertTrue(name: string, condition: boolean): Phase5Assertion {
  return { name, passed: condition, expected: true, actual: condition };
}

async function measureCase(
  id: string,
  run: () => Promise<{ assertions: Phase5Assertion[]; observations?: Record<string, unknown>; notes?: string[] }>,
): Promise<Phase5ValidationCase> {
  const started = performance.now();
  try {
    const result = await run();
    return {
      id,
      passed: result.assertions.length > 0 && result.assertions.every((item) => item.passed),
      durationMs: Math.round(performance.now() - started),
      assertions: result.assertions,
      observations: result.observations ?? {},
      notes: result.notes ?? [],
    };
  } catch (error) {
    return {
      id,
      passed: false,
      durationMs: Math.round(performance.now() - started),
      assertions: [{
        name: "case completed without an unexpected error",
        passed: false,
        expected: true,
        actual: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }],
      observations: {},
      notes: [],
    };
  }
}

let envelopeSequence = 0;

function envelope(type: ServerEnvelope["type"], symbol: string, data: unknown, ts: number): ServerEnvelope {
  envelopeSequence += 1;
  return {
    type,
    schemaVersion: 1 as const,
    exchange: "binance",
    symbol,
    serverTimestamp: ts,
    exchangeTimestamp: ts,
    sequence: envelopeSequence,
    data,
  };
}

/** Determinism: identical event streams must yield identical insight frames. */
async function caseInsightsDeterminism() {
  const runSeries = (): InsightFrame => {
    let clock = 1_000;
    const engine = new InsightEngine({
      symbol: "BTCUSDT",
      tickSize: 0.1,
      publishIntervalMs: 0,
      wallConfirmMs: 1_500,
      now: () => {
        clock += 100;
        return clock;
      },
    });
    const depth = (ts: number) => engine.handleEvent(envelope("depth_frame", "BTCUSDT", {
      lastUpdateId: ts, bids: [[60_000, 1], [59_999, 7]], asks: [[60_001, 2]],
    }, ts));
    depth(1_000);
    engine.handleEvent(envelope("trade_bucket", "BTCUSDT", {
      price: 60_000, volume: 3, buyVolume: 2, sellVolume: 1, totalVolume: 3,
      delta: 1, tradeCount: 4,
    }, 1_200));
    engine.handleEvent(envelope("metric", "BTCUSDT", { tradeRate: 6, delta: 1 }, 1_300));
    engine.handleEvent(envelope("trend_signal", "BTCUSDT", {
      direction: "up", score: 72, upScore: 72, downScore: 8, confidence: 0.7,
      active: true, strength: "strong", reasons: [], since: 1_000,
    }, 1_400));
    depth(2_700);
    return engine.snapshotFrame();
  };

  const first = JSON.stringify(runSeries());
  const second = JSON.stringify(runSeries());
  return {
    assertions: [
      assertion(
        `identical frames across runs (algo ${INSIGHTS_ALGO_VERSION})`,
        first === second && first.length > 0,
        true,
        first === second,
      ),
    ],
    observations: { frameBytes: first.length },
    notes: ["satisfies 'evaluasi dapat direproduksi dari replay' at the analytics layer"],
  };
}

/** Cooldown + dedup + shadow semantics of the alert engine. */
async function caseAlertCooldownShadow() {
  let clock = 1_000_000;
  const shadow = new AlertEngine({ shadowMode: true, now: () => clock, randomId: () => `a-${clock}` });
  const live = new AlertEngine({ shadowMode: false, now: () => clock, randomId: () => `b-${clock}` });
  for (const engine of [shadow, live]) {
    engine.createRule({
      kind: "trade_velocity", symbol: "*", thresholdMode: "absolute",
      absoluteValue: 5, cooldownMs: 60_000,
    });
  }
  const context = (velocity: number) => ({
    symbol: "SOLUSDT", ts: clock, price: 150 as number | null,
    trendScore: 0, trendDirection: null as null, wallTransitions: [],
    volumeDelta: 0, tradeVelocity: velocity,
  });

  clock += 1_000;
  const liveFirst = live.evaluate(context(40));
  const shadowFirst = shadow.evaluate(context(40));
  clock += 2_000;
  const liveRepeat = live.evaluate(context(45));
  const auditKinds = live.auditTrail(10).map((entry) => entry.kind);

  return {
    assertions: [
      assertTrue("live trigger delivered once", liveFirst.length === 1),
      assertTrue("repeat within cooldown suppressed", liveRepeat.length === 0),
      assertTrue("cooldown audit recorded", auditKinds.includes("suppressed_cooldown")),
      assertTrue("shadow trigger withheld", shadowFirst.length === 0),
      assertTrue(
        "shadow still evaluated signals",
        shadow.performance({ kind: "trade_velocity" }).some((row) => row.signalsTriggered > 0),
      ),
    ],
    observations: { algoVersion: ALERT_ALGO_VERSION, horizonsMs: [...SIGNAL_HORIZONS_MS] },
    notes: ["no repeated alerts without cooldown; shadow keeps evaluation but withholds delivery"],
  };
}

/** Forward-looking signal evaluation over the four required horizons. */
async function caseSignalHorizons() {
  let clock = 2_000_000;
  const engine = new AlertEngine({ now: () => clock, randomId: () => `s-${clock}` });
  engine.createRule({
    kind: "trend_score", symbol: "BTCUSDT", thresholdMode: "absolute",
    absoluteValue: 65, op: "above", cooldownMs: 5_000,
  });

  const start = clock;
  engine.evaluate({
    symbol: "BTCUSDT", ts: start, price: 100,
    trendScore: 75, trendDirection: "up", wallTransitions: [],
    volumeDelta: 0, tradeVelocity: 1,
  });
  engine.feedPrice("BTCUSDT", start + 5_000, 101);
  engine.feedPrice("BTCUSDT", start + 11_000, 102);
  engine.feedPrice("BTCUSDT", start + 31_000, 103);
  engine.feedPrice("BTCUSDT", start + 61_000, 104);
  engine.feedPrice("BTCUSDT", start + 301_000, 105);

  const rows: PerformanceRow[] = engine.performance({ symbol: "BTCUSDT" });
  const resolved = (horizonMs: number): PerformanceRow[] =>
    rows.filter((row) => row.horizonMs === horizonMs && row.signalsResolved > 0);

  return {
    assertions: [
      assertTrue("10s horizon resolved favorably",
        resolved(10_000).every((row) => row.precision === 1)),
      assertTrue("30s horizon resolved", resolved(30_000).length > 0),
      assertTrue("1m horizon resolved", resolved(60_000).length > 0),
      assertTrue("5m horizon resolved", resolved(300_000).length > 0),
      assertTrue(
        "excursions recorded",
        rows.some((row) => row.avgFavorableExcursionBps >= 100),
      ),
    ],
    observations: {
      rows: rows.map((row) => ({
        horizonMs: row.horizonMs, resolved: row.signalsResolved,
        precision: row.precision, mfeBps: row.avgFavorableExcursionBps,
        hourUtc: row.segmentHourUtc, volBucket: row.volatilityBucket,
      })),
    },
    notes: ["precision/recall/MFE/MAE segmented per simbol, jam UTC, dan bucket volatilitas"],
  };
}

function renderMarkdown(report: Phase5ValidationReport): string {
  const lines: string[] = [
    "# Phase 5 validation report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "| Case | Result | Duration ms | Assertions |",
    "|---|---|---:|---:|",
    ...report.cases.map((entry) =>
      `| ${entry.id} | ${entry.passed ? "PASS" : "FAIL"} | ${entry.durationMs} | ${entry.assertions.filter((item) => item.passed).length}/${entry.assertions.length} |`),
    "",
    `Summary: ${report.summary.passed} passed, ${report.summary.failed} failed`,
    "",
  ];
  for (const entry of report.cases) {
    lines.push(`## ${entry.id}`, "");
    for (const observation of Object.entries(entry.observations)) {
      lines.push(`- **${observation[0]}**: \`${JSON.stringify(observation[1])}\``);
    }
    for (const note of entry.notes) lines.push(`- note: ${note}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
  const markdownFlag = args.includes("--markdown") ? args[args.indexOf("--markdown") + 1] : undefined;

  const startedAt = performance.now();
  const cases: Phase5ValidationCase[] = [];
  cases.push(await measureCase("insights-determinism", caseInsightsDeterminism));
  cases.push(await measureCase("alert-cooldown-shadow", caseAlertCooldownShadow));
  cases.push(await measureCase("signal-horizons", caseSignalHorizons));

  const report: Phase5ValidationReport = {
    validationSchemaVersion: PHASE5_VALIDATION_SCHEMA_VERSION,
    kind: "phase-5-deployment-validation",
    deterministicInputs: true,
    generatedAt: new Date().toISOString(),
    cases,
    summary: {
      passed: cases.filter((entry) => entry.passed).length,
      failed: cases.filter((entry) => !entry.passed).length,
      allPassed: cases.every((entry) => entry.passed),
      durationMs: Math.round(performance.now() - startedAt),
    },
  };

  if (jsonFlag) {
    const target = resolve(jsonFlag);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.info(`phase-5 report written to ${target}`);
  }
  if (markdownFlag) {
    const target = resolve(markdownFlag);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, renderMarkdown(report), "utf8");
    console.info(`phase-5 markdown written to ${target}`);
  }

  for (const entry of report.cases) {
    console.info(`${entry.passed ? "PASS" : "FAIL"} ${entry.id} (${entry.durationMs} ms)`);
    for (const item of entry.assertions) {
      if (!item.passed) {
        console.error(
          `  ✗ ${item.name}: expected ${JSON.stringify(item.expected)}, got ${JSON.stringify(item.actual)}`,
        );
      }
    }
  }
  console.info(`summary: ${report.summary.passed} passed, ${report.summary.failed} failed in ${report.summary.durationMs ?? 0} ms`);
  if (!report.summary.allPassed) process.exitCode = 1;
}

await main();
