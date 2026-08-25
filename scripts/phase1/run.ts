import { validateThreeTimesBurst, readBurstBaseline } from "./burst-validation.js";
import { validateDisconnectDuringReconciliation } from "./disconnect-validation.js";
import { validateCoreFaults } from "./fault-validation.js";
import { validateReplayRepeatability } from "./replay-validation.js";
import { VALIDATION_SCHEMA_VERSION, type Phase1ValidationReport } from "./types.js";

export async function runPhase1Validation(): Promise<Phase1ValidationReport> {
  const baseline = await readBurstBaseline(3);
  const [coreCases, disconnect, burst, replay] = await Promise.all([
    validateCoreFaults(),
    validateDisconnectDuringReconciliation(),
    validateThreeTimesBurst(3),
    validateReplayRepeatability(),
  ]);
  const cases = [...coreCases, disconnect, burst, replay];
  const passed = cases.filter((result) => result.passed).length;
  return {
    validationSchemaVersion: VALIDATION_SCHEMA_VERSION,
    kind: "phase-1-deterministic-fault-validation",
    deterministicInputs: true,
    productionPaths: [
      "server/core/orderBook.ts",
      "server/core/analytics.ts",
      "server/core/dataQuality.ts",
      "server/feeds/binanceFeed.ts",
      "scripts/fixtures/evaluate.ts",
      "fixtures/market/*.events.jsonl",
    ],
    baseline,
    cases,
    summary: {
      passed,
      failed: cases.length - passed,
      allPassed: passed === cases.length,
    },
  };
}

async function main(): Promise<void> {
  try {
    const report = await runPhase1Validation();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.summary.allPassed) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      validationSchemaVersion: VALIDATION_SCHEMA_VERSION,
      kind: "phase-1-deterministic-fault-validation",
      fatal: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

void main();
