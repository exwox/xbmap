export const PHASE4_VALIDATION_SCHEMA_VERSION = 1 as const;

export interface Phase4Assertion {
  name: string;
  passed: boolean;
  expected: string | number | boolean;
  actual: string | number | boolean;
}

export interface Phase4ValidationCase {
  id: string;
  passed: boolean;
  durationMs: number;
  assertions: Phase4Assertion[];
  observations: Record<string, unknown>;
  notes: string[];
}

export interface Phase4ValidationReport {
  validationSchemaVersion: typeof PHASE4_VALIDATION_SCHEMA_VERSION;
  kind: "phase-4-deployment-validation";
  deterministicInputs: true;
  generatedAt: string;
  cases: Phase4ValidationCase[];
  summary: {
    passed: number;
    failed: number;
    allPassed: boolean;
    /** Wall-clock runtime of the whole validation suite in milliseconds. */
    durationMs?: number;
  };
}
