export const PHASE3_VALIDATION_SCHEMA_VERSION = 1 as const;

export type MetricFamily = {
  /** Prometheus-style `metric_family_name` key */
  name: string;
  /** Prometheus metadata TYPE line */
  type: "TYPE" | "COUNTER" | "GAUGE" | "HISTOGRAM" | "SUMMARY" | "UNTYPED";
  /** The full `# TYPE` text line emitted for the family */
  typeLine: string;
};

export interface Phase3Assertion {
  name: string;
  passed: boolean;
  expected: string | number | boolean;
  actual: string | number | boolean;
}

export interface Phase3ValidationCase {
  id: string;
  passed: boolean;
  durationMs: number;
  assertions: Phase3Assertion[];
  observations: Record<string, unknown>;
  notes: string[];
}

export interface Phase3ValidationReport {
  validationSchemaVersion: typeof PHASE3_VALIDATION_SCHEMA_VERSION;
  kind: "phase-3-observability-validation";
  deterministicInputs: true;
  generatedAt: string;
  cases: Phase3ValidationCase[];
  summary: {
    passed: number;
    failed: number;
    allPassed: boolean;
  };
}


