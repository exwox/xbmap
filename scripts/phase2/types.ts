export const PHASE2_VALIDATION_SCHEMA_VERSION = 1 as const;

export interface Phase2Assertion {
  name: string;
  passed: boolean;
  expected: string | number | boolean;
  actual: string | number | boolean;
}

export interface Phase2ValidationCase {
  id: string;
  passed: boolean;
  durationMs: number;
  assertions: Phase2Assertion[];
  observations: Record<string, string | number | boolean>;
  notes: string[];
}

export interface Phase2ValidationReport {
  validationSchemaVersion: typeof PHASE2_VALIDATION_SCHEMA_VERSION;
  kind: "phase-2-storage-replay-validation";
  deterministicInputs: true;
  generatedAt: string;
  cases: Phase2ValidationCase[];
  summary: {
    passed: number;
    failed: number;
    allPassed: boolean;
  };
}

