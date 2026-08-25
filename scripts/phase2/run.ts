import {
  validateDeterministicReplayChecksums,
  validateOneHourReplayStartup,
  validateReplaySessionRestart,
} from "./replay-validation.js";
import {
  validateBackupRestore,
  validateBoundedQueries,
  validatePersistenceAfterRestart,
  validateRetentionDuringIngestion,
} from "./storage-validation.js";
import {
  PHASE2_VALIDATION_SCHEMA_VERSION,
  type Phase2ValidationReport,
} from "./types.js";

export async function runPhase2Validation(): Promise<Phase2ValidationReport> {
  // Keep storage lifecycle cases sequential: each result has an attributable
  // duration and disk contention does not distort the replay startup SLO.
  const cases = [
    await validatePersistenceAfterRestart(),
    await validateBoundedQueries(),
    await validateBackupRestore(),
    await validateRetentionDuringIngestion(),
    await validateOneHourReplayStartup(),
    await validateDeterministicReplayChecksums(),
    await validateReplaySessionRestart(),
  ];
  const passed = cases.filter((candidate) => candidate.passed).length;
  return {
    validationSchemaVersion: PHASE2_VALIDATION_SCHEMA_VERSION,
    kind: "phase-2-storage-replay-validation",
    deterministicInputs: true,
    generatedAt: new Date().toISOString(),
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
    const report = await runPhase2Validation();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.summary.allPassed) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      validationSchemaVersion: PHASE2_VALIDATION_SCHEMA_VERSION,
      kind: "phase-2-storage-replay-validation",
      fatal: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

void main();

