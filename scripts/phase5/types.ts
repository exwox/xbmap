export const PHASE5_VALIDATION_SCHEMA_VERSION = 1 as const;

export interface Phase5Assertion {
  name: string;
  passed: boolean;
  expected: string | number | boolean;
  actual: string | number | boolean;
}

export interface Phase5ValidationCase {
  id: string;
  passed: boolean;
  durationMs: number;
  assertions: Phase5Assertion[];
  observations: Record<string, unknown>;
  notes: string[];
}

export interface Phase5ValidationReport {
  validationSchemaVersion: typeof PHASE5_VALIDATION_SCHEMA_VERSION;
  kind: "phase-5-deployment-validation";
  deterministicInputs: true;
  generatedAt: string;
  cases: Phase5ValidationCase[];
  summary: {
    passed: number;
    failed: number;
    allPassed: boolean;
    durationMs?: number;
  };
}