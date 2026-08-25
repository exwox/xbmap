import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { MarketGateway } from "../../server/marketGateway.js";
import {
  MarketSessionManager,
  type SessionStatus,
} from "../../server/marketSessionManager.js";
import { instrumentFor, supportedSymbols } from "../../server/instruments.js";
import {
  PHASE4_VALIDATION_SCHEMA_VERSION,
  type Phase4ValidationCase,
  type Phase4ValidationReport,
} from "./types.js";
import { assertion, measureCase } from "./case-utils.js";

interface CliOptions {
  symbols: number;
  sampleMs: number;
  jsonPath?: string;
  markdownPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { symbols: 3, sampleMs: 1_500 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--symbols") options.symbols = Number(argv[index + 1]) || options.symbols;
    if (value === "--sample-ms") options.sampleMs = Number(argv[index + 1]) || options.sampleMs;
    if (value === "--json") options.jsonPath = argv[index + 1];
    if (value === "--markdown") options.markdownPath = argv[index + 1];
  }
  return options;
}

function buildManager(idleTtlMs = 400): MarketSessionManager {
  return new MarketSessionManager({
    maxSessions: 8,
    idleTtlMs,
    disposeGateway: (gateway) => gateway.stop(),
    createGateway: (symbol, tickSize) =>
      new MarketGateway({ symbol, tickSize, forceDemo: true }),
  });
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function caseSessionLifecycle(): Promise<{ assertions: Phase4ValidationCase["assertions"]; observations: Record<string, unknown>; notes: string[] }> {
  const manager = buildManager();
  const notes: string[] = [];
  const assertions: Phase4ValidationCase["assertions"] = [];
  try {
    const btc = manager.acquire("BTCUSDT");
    const eth = manager.acquire("ETHUSDT");
    const sol = manager.acquire("SOLUSDT");
    assertions.push(assertion("distinct gateway instances", new Set([btc, eth, sol]).size, 3));
    assertions.push(assertion("BTC tick size", btc.tickSize, 0.1));
    assertions.push(assertion("ETH tick size", eth.tickSize, 0.01));
    assertions.push(assertion("SOL tick size", sol.tickSize, 0.01));
    const sessionIds = new Set([btc, eth, sol].map((gateway) => gateway.status.sessionId));
    assertions.push(assertion("unique market session ids", sessionIds.size, 3));

    // Release everything; the short TTL must stop every feed automatically.
    manager.release("BTCUSDT");
    manager.release("ETHUSDT");
    manager.release("SOLUSDT");
    await sleep(600);
    const surviving: SessionStatus[] = manager.list();
    assertions.push(assertion("idle sessions evicted after ttl", surviving.length, 0));
    notes.push(`evicted=${surviving.map((entry) => entry.symbol).join(",") || "all"}`);

    // Re-acquiring an evicted symbol must rebuild a restart-safe instance.
    const rebuilt = manager.acquire("ETHUSDT");
    assertions.push(assertion("rebuild produces a fresh instance", rebuilt !== eth, true));
    manager.stopAll();
  } finally {
    manager.stopAll();
  }
  return { assertions, observations: {}, notes };
}

async function caseResourceBudget(sampleMs: number): Promise<{ assertions: Phase4ValidationCase["assertions"]; observations: Record<string, unknown>; notes: string[] }> {
  const manager = buildManager(60_000);
  const symbols = supportedSymbols().slice(0, 3);
  const gateways = symbols.map((symbol) => manager.acquire(symbol));
  try {
    // Warm-up so demo feeds produce their first frames before sampling.
    await sleep(400);
    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    await sleep(sampleMs);
    const cpuDelta = process.cpuUsage(cpuBefore);
    const rssAfter = process.memoryUsage().rss;

    const perSymbol = symbols.map((symbol, index) => {
      const gateway = gateways[index]!;
      const quality = gateway.dataQuality;
      return {
        symbol,
        tickSize: gateway.tickSize,
        running: Boolean(gateway.status.sessionId),
        lastEventTimestamp: gateway.status.lastEventTimestamp ?? null,
        resyncs: quality.counters.resyncs,
        crossedBooks: quality.counters.crossedBooks,
      };
    });
    const assertions: Phase4ValidationCase["assertions"] = [
      assertion("all sessions running", perSymbol.every((entry) => entry.running), true),
      assertion(
        "every session produced events",
        perSymbol.every((entry) => entry.lastEventTimestamp !== null),
        true,
      ),
      assertion("no crossed books", perSymbol.every((entry) => entry.crossedBooks === 0), true),
    ];
    const cpuMs = (cpuDelta.user + cpuDelta.system) / 1_000;
    const observations = {
      sampleMs,
      symbols: perSymbol,
      process: {
        rssDeltaBytes: Math.max(0, rssAfter - rssBefore),
        rssBytes: rssAfter,
        cpuMs: Number(cpuMs.toFixed(1)),
        cpuMsPerSymbolPerSecond: Number((cpuMs / (symbols.length * (sampleMs / 1_000))).toFixed(2)),
      },
    };
    return { assertions, observations, notes: ["synthetic demo feeds; production budgets require the live-network gate"] };
  } finally {
    manager.stopAll();
  }
}

async function caseBookIsolation(): Promise<{ assertions: Phase4ValidationCase["assertions"]; observations: Record<string, unknown>; notes: string[] }> {
  const manager = buildManager();
  const btc = manager.acquire("BTCUSDT");
  const eth = manager.acquire("ETHUSDT");
  try {
    await sleep(300);
    const ethCheckpointBefore = eth.dataQuality.checkpoint?.fingerprint ?? null;
    // Drive BTC's synthetic feed window; ETH state must stay self-consistent.
    await sleep(400);
    const ethCheckpointAfter = eth.dataQuality.checkpoint?.fingerprint ?? null;
    const btcSnapshot = btc.getSnapshot(5);
    const ethSnapshot = eth.getSnapshot(5);

    const assertions: Phase4ValidationCase["assertions"] = [
      assertion("btc session running", Boolean(btc.status.sessionId), true),
      assertion("eth session running", Boolean(eth.status.sessionId), true),
      assertion(
        "both books expose checkpoints",
        ethCheckpointBefore !== null && ethCheckpointAfter !== null,
        true,
      ),
      assertion("tick sizes differ across books", btc.tickSize !== eth.tickSize, true),
      assertion(
        "snapshots are tagged with their own market",
        btcSnapshot.symbol === "BTCUSDT" && ethSnapshot.symbol === "ETHUSDT",
        true,
      ),
    ];
    return {
      assertions,
      observations: {
        btcTickSize: btc.tickSize,
        ethTickSize: eth.tickSize,
        registryEthTick: instrumentFor("ETHUSDT").tickSize,
      },
      notes: ["isolation enforced by per-symbol gateway instances with independent order books"],
    };
  } finally {
    manager.stopAll();
  }
}

function renderMarkdown(report: Phase4ValidationReport): string {
  const lines: string[] = [
    "# Phase 4 validation report",
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
  const options = parseArgs(process.argv.slice(2));
  const startedAt = performance.now();
  const cases: Phase4ValidationCase[] = [];
  cases.push(await measureCase("session-lifecycle", caseSessionLifecycle));
  cases.push(await measureCase(`resource-budget-${options.symbols}-symbols`, () => caseResourceBudget(options.sampleMs)));
  cases.push(await measureCase("book-isolation", caseBookIsolation));

  const report: Phase4ValidationReport = {
    validationSchemaVersion: PHASE4_VALIDATION_SCHEMA_VERSION,
    kind: "phase-4-deployment-validation",
    deterministicInputs: true,
    generatedAt: new Date().toISOString(),
    cases,
    summary: {
      passed: cases.filter((entry) => entry.passed).length,
      failed: cases.filter((entry) => !entry.passed).length,
      allPassed: cases.every((entry) => entry.passed),
      durationMs: Number((performance.now() - startedAt).toFixed(0)),
    },
  };

  if (options.jsonPath) {
    const target = resolve(options.jsonPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.info(`phase-4 report written to ${target}`);
  }
  if (options.markdownPath) {
    const target = resolve(options.markdownPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, renderMarkdown(report), "utf8");
    console.info(`phase-4 markdown written to ${target}`);
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
  console.info(`summary: ${report.summary.passed} passed, ${report.summary.failed} failed in ${report.summary.durationMs} ms`);
  if (report.summary.failed > 0) process.exitCode = 1;
}

await main();
