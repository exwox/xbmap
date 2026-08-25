import type { BookApplyStatus } from "../../server/core/orderBook.js";

export const VALIDATION_SCHEMA_VERSION = 1 as const;

export type ValidationCaseId =
  | "lost-event"
  | "duplicate-event"
  | "late-out-of-order-event"
  | "malformed-event"
  | "crossed-update"
  | "disconnect-during-reconciliation"
  | "burst-three-times-baseline"
  | "replay-repeatability";

export interface ValidationObservation {
  key: string;
  value: string | number | boolean | null;
}

export interface ValidationCaseResult {
  id: ValidationCaseId;
  passed: boolean;
  invariant: string;
  observations: ValidationObservation[];
  failure?: string;
}

export interface FaultCounters {
  applied: number;
  ignored: number;
  gap: number;
  invalid: number;
  unsynced: number;
}

export interface ApplyTrace {
  status: BookApplyStatus;
  lastUpdateId: number;
  reason?: string;
}

export interface Phase1ValidationReport {
  validationSchemaVersion: typeof VALIDATION_SCHEMA_VERSION;
  kind: "phase-1-deterministic-fault-validation";
  deterministicInputs: true;
  productionPaths: string[];
  baseline: {
    source: string;
    depthUpdatesPerSecond: number;
    tradesPerSecond: number;
    totalMarketEventsPerSecond: number;
    burstMultiplier: number;
    burstMarketEventsPerSecond: number;
  };
  cases: ValidationCaseResult[];
  summary: {
    passed: number;
    failed: number;
    allPassed: boolean;
  };
}

export interface MemorySample {
  elapsedMs: number;
  heapUsedBytes: number;
  rssBytes: number;
  externalBytes: number;
  eventsProcessed: number;
}

export interface MemoryTrend {
  sampleCount: number;
  durationMs: number;
  heapStartBytes: number;
  heapEndBytes: number;
  heapNetGrowthBytes: number;
  heapSlopeBytesPerMinute: number;
  rSquared: number;
  positiveIntervalRatio: number;
  suspectedUnboundedGrowth: boolean;
  conclusive: boolean;
  reasons: string[];
}

export type SoakMode = "quick" | "full-8h" | "custom";

export interface SoakConfiguration {
  mode: SoakMode;
  durationMs: number;
  warmupMs: number;
  sampleIntervalMs: number;
  cycleIntervalMs: number;
  marketEventsPerSecond: number;
  requireExposedGc: boolean;
  minimumTrendSamples: number;
  maximumRetainedGrowthBytes: number;
  maximumSlopeBytesPerMinute: number;
  minimumRSquared: number;
  minimumPositiveIntervalRatio: number;
}

export interface SoakReport {
  validationSchemaVersion: typeof VALIDATION_SCHEMA_VERSION;
  kind: "phase-1-wall-clock-soak";
  mode: SoakMode;
  wallClock: true;
  acceleratedEventClock: false;
  qualification: "smoke-only" | "eight-hour-exit-gate" | "custom-diagnostic";
  status: "passed" | "failed" | "aborted";
  configuration: SoakConfiguration;
  runtime: {
    gcExposed: boolean;
    requestedWallDurationMs: number;
    actualWallDurationMs: number;
    startedAt: string;
    completedAt: string;
    eventsProcessed: number;
    achievedEventsPerSecond: number;
  };
  memory: {
    trend: MemoryTrend;
    samples: MemorySample[];
  };
  assertions: {
    completedRequestedDuration: boolean;
    processedAtLeastConfiguredRate: boolean;
    noSuspectedUnboundedGrowth: boolean;
  };
  notes: string[];
}
