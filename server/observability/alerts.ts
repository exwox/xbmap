/**
 * Minimal internal alert evaluator for Phase 3.
 *
 * Consumes a sampled observability snapshot and fires structured alert events
 * on sustained violation of the configured rules. Every transition both
 * emits a structured JSON line (`event:"alert"`) and is retained in a bounded
 * in-memory buffer so the "every incident has a log and a metric trail" gate
 * can be asserted without an external Prometheus deployment.
 */

export type AlertSeverity = "warning" | "critical";

export interface AlertEvent {
  event: "alert";
  rule: string;
  severity: AlertSeverity;
  message: string;
  active: boolean;
  firedAt: number;
  value: number;
}

export interface AlertInputs {
  /** Ms since the gateway last published valid data; null when currently valid. */
  staleMs: number | null;
  /** Server stale-after threshold published by the gateway settings. */
  staleAfterMs: number;
  /** New HTTP 5xx responses observed in the current evaluation window. */
  httpErrorDelta: number;
  /** Seconds of the current evaluation window used for rate computation. */
  windowSeconds: number;
  /** New sequence gaps observed in the current evaluation window. */
  sequenceGapDelta: number;
  /** New resyncs observed in the current evaluation window. */
  resyncDelta: number;
  /** Heap used / heap limit ratio in [0, 1]. */
  memoryRatio: number;
  /** Memory ratio at which a warning fires. */
  memoryWarnRatio: number;
  /** Memory ratio at which a critical alert fires. */
  memoryCriticalRatio: number;
  /** HTTP 5xx per second at which a warning fires. */
  httpErrorRatePerSecond: number;
  /** Resync count per window at which a recovery-loop warning fires. */
  resyncStormThreshold: number;
}

export interface AlertRuleState {
  rule: string;
  severity: AlertSeverity;
  active: boolean;
  lastFiredAt: number | null;
}

export interface AlertSnapshot {
  active: AlertRuleState[];
  recent: AlertEvent[];
}

const DEFAULT_RULES: Array<Pick<AlertRuleState, "rule" | "severity">> = [
  { rule: "stale_feed", severity: "critical" },
  { rule: "sequence_gap", severity: "critical" },
  { rule: "recovery_loop", severity: "warning" },
  { rule: "http_error_rate", severity: "warning" },
  { rule: "memory_pressure", severity: "warning" },
];

export interface AlertEvaluatorOptions {
  memoryWarnRatio?: number;
  memoryCriticalRatio?: number;
  httpErrorRatePerSecond?: number;
  resyncStormThreshold?: number;
  maxRecentEvents?: number;
  /** Optional sink; defaults to structured JSON logging. */
  emit?: (event: AlertEvent) => void;
}
export class AlertEvaluator {
  readonly states: Map<string, AlertRuleState>;
  readonly recent: AlertEvent[] = [];

  readonly memoryWarnRatio: number;
  readonly memoryCriticalRatio: number;
  readonly httpErrorRatePerSecond: number;
  readonly resyncStormThreshold: number;
  private readonly maxRecentEvents: number;
  private readonly emitEvent: (event: AlertEvent) => void;

  constructor(options: AlertEvaluatorOptions = {}) {
    this.memoryWarnRatio = options.memoryWarnRatio ?? 0.8;
    this.memoryCriticalRatio = options.memoryCriticalRatio ?? 0.9;
    this.httpErrorRatePerSecond = options.httpErrorRatePerSecond ?? 0.5;
    this.resyncStormThreshold = options.resyncStormThreshold ?? 3;
    this.maxRecentEvents = options.maxRecentEvents ?? 200;
    this.emitEvent = options.emit ?? defaultAlertEmitter;
    this.states = new Map(
      DEFAULT_RULES.map(({ rule, severity }) => [
        rule,
        { rule, severity, active: false, lastFiredAt: null },
      ]),
    );
  }

  evaluate(input: AlertInputs): AlertEvent[] {
    const fired: AlertEvent[] = [];
    const now = input.staleMs === null ? Number.POSITIVE_INFINITY : input.staleMs;

    this.transition(fired, "stale_feed", input.staleMs !== null && input.staleMs > input.staleAfterMs, now,
      `Market data stale for ${Math.round(input.staleMs ?? 0)} ms (> ${input.staleAfterMs} ms)`,
      input.staleMs ?? 0);

    this.transition(fired, "sequence_gap", input.sequenceGapDelta > 0, now,
      `${input.sequenceGapDelta} new sequence gap(s) detected`,
      input.sequenceGapDelta);

    const resyncStorm = input.resyncDelta >= input.resyncStormThreshold;
    this.transition(fired, "recovery_loop", resyncStorm, now,
      `${input.resyncDelta} resync(s) in ${Math.round(input.windowSeconds)}s window (>= ${input.resyncStormThreshold})`,
      input.resyncDelta);

    const errorRate = input.windowSeconds > 0
      ? input.httpErrorDelta / input.windowSeconds
      : 0;
    this.transition(fired, "http_error_rate", errorRate >= input.httpErrorRatePerSecond, now,
      `HTTP 5xx rate ${errorRate.toFixed(3)}/s (>= ${input.httpErrorRatePerSecond}/s)`,
      errorRate);

    this.transition(fired, "memory_pressure", input.memoryRatio >= input.memoryCriticalRatio, now,
      `Heap usage ${(input.memoryRatio * 100).toFixed(1)}% (critical >= ${(input.memoryCriticalRatio * 100).toFixed(0)}%)`,
      input.memoryRatio);
    if (input.memoryRatio < input.memoryCriticalRatio && input.memoryRatio >= input.memoryWarnRatio) {
      this.transition(fired, "memory_pressure", true, now,
        `Heap usage ${(input.memoryRatio * 100).toFixed(1)}% (warning >= ${(input.memoryWarnRatio * 100).toFixed(0)}%)`,
        input.memoryRatio);
    }

    return fired;
  }

  private transition(
    fired: AlertEvent[],
    rule: string,
    condition: boolean,
    now: number,
    message: string,
    value: number,
  ): void {
    const state = this.states.get(rule);
    if (!state) return;
    if (condition && !state.active) {
      state.active = true;
      state.lastFiredAt = now;
      const event: AlertEvent = {
        event: "alert",
        rule,
        severity: state.severity,
        message,
        active: true,
        firedAt: now,
        value,
      };
      this.retain(event);
      fired.push(event);
      this.emitEvent(event);
    } else if (!condition && state.active) {
      state.active = false;
      const event: AlertEvent = {
        event: "alert",
        rule,
        severity: state.severity,
        message: `${rule} resolved`,
        active: false,
        firedAt: now,
        value,
      };
      this.retain(event);
      fired.push(event);
      this.emitEvent(event);
    }
  }

  private retain(event: AlertEvent): void {
    this.recent.push(event);
    if (this.recent.length > this.maxRecentEvents) this.recent.shift();
  }

  snapshot(): AlertSnapshot {
    return {
      active: [...this.states.values()].map((state) => ({ ...state })),
      recent: this.recent.map((event) => ({ ...event })),
    };
  }

  reset(): void {
    for (const state of this.states.values()) state.active = false;
    this.recent.length = 0;
  }
}

function defaultAlertEmitter(event: AlertEvent): void {
  console.info(JSON.stringify({
    level: "warn",
    component: "alert",
    event: "alert",
    rule: event.rule,
    severity: event.severity,
    message: event.message,
    active: event.active,
    firedAt: event.firedAt,
    value: event.value,
  }));
}