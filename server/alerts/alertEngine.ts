import { randomUUID } from "node:crypto";
import type { WallTransition } from "../insights/insightEngine.js";

/**
 * Phase 5 alert engine: user-configurable rules evaluated against the market
 * stream with per-symbol statistical baselines, cooldown/deduplication, a
 * shadow mode, an audit trail (created/updated/deleted/triggered/delivered),
 * and forward-looking signal evaluation over the fixed horizons required by
 * the development plan (10s / 30s / 1m / 5m).
 */

export const ALERT_ALGO_VERSION = "alerts-v1";
export const SIGNAL_HORIZONS_MS = [10_000, 30_000, 60_000, 300_000] as const;

export type AlertKind = "trend_score" | "liquidity_wall" | "volume_delta" | "trade_velocity";
export type AlertOp = "above" | "below";

export interface AlertRule {
  id: string;
  /** Market scope; `"*"` matches every active session. */
  symbol: string;
  kind: AlertKind;
  /**
   * `baseline` multiplies the rolling median of the metric **for that
   * symbol** (never a universal constant); `absolute` compares directly.
   */
  thresholdMode: "baseline" | "absolute";
  multiplier?: number;
  absoluteValue?: number;
  op?: AlertOp;
  wallState?: "appeared" | "disappeared";
  cooldownMs: number;
  sound: boolean;
  enabled: boolean;
  createdBy: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface TriggeredAlert {
  alertId: string;
  ruleId: string;
  kind: AlertKind;
  symbol: string;
  ts: number;
  direction: "bullish" | "bearish" | null;
  value: number;
  threshold: number;
  baselineMedian: number | null;
  reason: string;
  algoVersion: string;
  sound: boolean;
  shadow: boolean;
}

export type AuditKind =
  | "created" | "updated" | "deleted"
  | "triggered" | "delivered" | "delivery_failed"
  | "suppressed_shadow" | "suppressed_cooldown";

export interface AuditEntry {
  atMs: number;
  kind: AuditKind;
  ruleId?: string;
  symbol?: string;
  channel?: "ws" | "webhook" | "telegram";
  detail?: string;
}

export interface AlertEvaluationContext {
  symbol: string;
  ts: number;
  price: number | null;
  trendScore: number;
  trendDirection: "up" | "down" | null;
  wallTransitions: WallTransition[];
  volumeDelta: number;
  tradeVelocity: number;
  /** Realized volatility proxy (bps) used for signal segmentation. */
  realizedVolBps?: number;
}

export interface PerformanceRow {
  kind: AlertKind;
  symbol: string;
  horizonMs: number;
  segmentHourUtc: number | null;
  volatilityBucket: "low" | "mid" | "high" | null;
  signalsTriggered: number;
  signalsResolved: number;
  favorable: number;
  precision: number;
  avgFavorableExcursionBps: number;
  avgAdverseExcursionBps: number;
  algoVersions: string[];
}

const BASELINE_MIN_SAMPLES = 30;
const BASELINE_MAX_SAMPLES = 600;
const MAX_AUDIT_ENTRIES = 500;
const MAX_SIGNAL_SAMPLES = 2_000;

/** Rolling per-(symbol, metric) median used as the calibrated threshold. */
class MetricBaseline {
  private readonly values: number[] = [];

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    this.values.push(value);
    if (this.values.length > BASELINE_MAX_SAMPLES) {
      this.values.splice(0, this.values.length - BASELINE_MAX_SAMPLES);
    }
  }

  get samples(): number {
    return this.values.length;
  }

  /** Null until the minimum sample count keeps early medians meaningless. */
  median(): number | null {
    if (this.values.length < BASELINE_MIN_SAMPLES) return null;
    const sorted = [...this.values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;
  }
}

interface SignalSample {
  signalId: string;
  algoVersion: string;
  kind: AlertKind;
  symbol: string;
  direction: "bullish" | "bearish";
  source: "trigger" | "condition";
  entryTs: number;
  entryPrice: number;
  hourUtc: number;
  volatilityBucket: "low" | "mid" | "high";
  horizons: Map<number, { resolved: boolean; exitPrice: number; mfeBps: number; maeBps: number }>;
}

function assertRuleShape(kind: AlertKind, input: Record<string, unknown>): void {
  if (!["trend_score", "liquidity_wall", "volume_delta", "trade_velocity"].includes(kind)) {
    throw new TypeError(`Unsupported alert kind: ${String(kind)}`);
  }
  if (input.thresholdMode === "baseline") {
    const multiplier = input.multiplier;
    if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) {
      throw new TypeError("baseline thresholds require a positive multiplier");
    }
  }
  if (input.thresholdMode === "absolute") {
    if (typeof input.absoluteValue !== "number" || !Number.isFinite(input.absoluteValue)) {
      throw new TypeError("absolute thresholds require a finite absoluteValue");
    }
  }
  if (kind === "liquidity_wall") {
    if (input.wallState !== "appeared" && input.wallState !== "disappeared") {
      throw new TypeError("liquidity_wall alerts require wallState 'appeared' or 'disappeared'");
    }
    return;
  }
  const op = input.op ?? "above";
  if (op !== "above" && op !== "below") {
    throw new TypeError("op must be 'above' or 'below'");
  }
}

export interface AlertEngineOptions {
  shadowMode?: boolean;
  now?: () => number;
  /** Persisted whenever the rule set changes (file writer in `index.ts`). */
  onRulesChanged?: (rules: readonly AlertRule[]) => void;
  randomId?: () => string;
}

export class AlertEngine {
  private readonly rules = new Map<string, AlertRule>();
  private readonly baselines = new Map<string, MetricBaseline>();
  private readonly lastTriggerAtMs = new Map<string, number>();
  private readonly audit: AuditEntry[] = [];
  private readonly signalSamples: SignalSample[] = [];
  private readonly options: { shadowMode: boolean; now: () => number; onRulesChanged: ((rules: readonly AlertRule[]) => void) | null; randomId: () => string };

  constructor(options: AlertEngineOptions = {}) {
    this.options = {
      shadowMode: options.shadowMode ?? false,
      now: options.now ?? Date.now,
      onRulesChanged: options.onRulesChanged ?? null,
      randomId: options.randomId ?? (() => randomUUID()),
    };
  }

  get shadowMode(): boolean {
    return this.options.shadowMode;
  }

  setShadowMode(enabled: boolean): void {
    this.options.shadowMode = enabled;
  }

  // ── Rule management ─────────────────────────────────────────────────────

  listRules(): AlertRule[] {
    return [...this.rules.values()].sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  createRule(input: Record<string, unknown>): AlertRule {
    const kind = input.kind as AlertKind;
    assertRuleShape(kind, input);
    const now = this.options.now();
    const rule: AlertRule = {
      id: this.options.randomId(),
      symbol: typeof input.symbol === "string" && input.symbol.trim().length > 0
        ? input.symbol.trim().toUpperCase()
        : "*",
      kind,
      thresholdMode: input.thresholdMode === "absolute" ? "absolute" : "baseline",
      multiplier: typeof input.multiplier === "number" ? input.multiplier : undefined,
      absoluteValue: typeof input.absoluteValue === "number" ? input.absoluteValue : undefined,
      op: input.op === "below" ? "below" : input.op === "above" ? "above" : undefined,
      wallState: input.wallState === "appeared" || input.wallState === "disappeared"
        ? input.wallState
        : undefined,
      cooldownMs: Math.max(5_000, Math.min(3_600_000, Math.round(
        typeof input.cooldownMs === "number" && Number.isFinite(input.cooldownMs) ? input.cooldownMs : 60_000))),
      sound: input.sound === true,
      enabled: input.enabled !== false,
      createdBy: typeof input.createdBy === "string" ? input.createdBy.slice(0, 64) : "ui",
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.rules.set(rule.id, rule);
    this.pushAudit({ atMs: now, kind: "created", ruleId: rule.id, symbol: rule.symbol, detail: `${rule.kind} ${rule.thresholdMode}` });
    this.options.onRulesChanged?.(this.listRules());
    return rule;
  }

  updateRule(id: string, patch: Record<string, unknown>): AlertRule | null {
    const existing = this.rules.get(id);
    if (!existing) return null;
    const mergedInput = { ...existing, ...patch } as Record<string, unknown>;
    const kind = mergedInput.kind as AlertKind;
    assertRuleShape(kind, mergedInput);
    if (typeof patch.symbol === "string") existing.symbol = patch.symbol.trim().toUpperCase() || "*";
    if (patch.thresholdMode === "baseline" || patch.thresholdMode === "absolute") {
      existing.thresholdMode = patch.thresholdMode;
    }
    if (typeof patch.multiplier === "number") existing.multiplier = patch.multiplier;
    if (typeof patch.absoluteValue === "number") existing.absoluteValue = patch.absoluteValue;
    if (patch.op === "above" || patch.op === "below") existing.op = patch.op;
    if (patch.wallState === "appeared" || patch.wallState === "disappeared") existing.wallState = patch.wallState;
    if (typeof patch.cooldownMs === "number" && Number.isFinite(patch.cooldownMs)) {
      existing.cooldownMs = Math.max(5_000, Math.min(3_600_000, Math.round(patch.cooldownMs)));
    }
    if (typeof patch.sound === "boolean") existing.sound = patch.sound;
    if (typeof patch.enabled === "boolean") existing.enabled = patch.enabled;
    existing.updatedAtMs = this.options.now();
    this.pushAudit({ atMs: existing.updatedAtMs, kind: "updated", ruleId: id, symbol: existing.symbol });
    this.options.onRulesChanged?.(this.listRules());
    return existing;
  }

  deleteRule(id: string): boolean {
    const existing = this.rules.get(id);
    if (!existing) return false;
    this.rules.delete(id);
    this.pushAudit({ atMs: this.options.now(), kind: "deleted", ruleId: id, symbol: existing.symbol });
    this.options.onRulesChanged?.(this.listRules());
    return true;
  }

  /** Restores persisted rules verbatim (startup path); skips change audit. */
  restoreRules(rules: readonly AlertRule[]): number {
    let restored = 0;
    for (const rule of rules) {
      if (
        typeof rule?.id !== "string" || rule.id.length === 0 ||
        !["trend_score", "liquidity_wall", "volume_delta", "trade_velocity"].includes(rule.kind) ||
        typeof rule.symbol !== "string"
      ) {
        continue;
      }
      this.rules.set(rule.id, { ...rule });
      restored += 1;
    }
    return restored;
  }

  /** Records a delivery outcome for an already-triggered alert. */
  recordDelivery(ruleId: string, symbol: string, channel: "ws" | "webhook" | "telegram", failed = false, detail?: string): void {
    this.pushAudit({
      atMs: this.options.now(),
      kind: failed ? "delivery_failed" : "delivered",
      ruleId,
      symbol,
      channel,
      ...(detail ? { detail } : {}),
    });
  }

  // ── Evaluation ───────────────────────────────────────────────────────────

  /**
   * Evaluates every enabled rule against the current context. Baselines are
   * updated first so thresholds always reflect that symbol's own recent
   * behaviour. Returns alerts that should be delivered; shadow-mode triggers
   * are audited but not returned for delivery.
   */
  evaluate(context: AlertEvaluationContext): TriggeredAlert[] {
    const { symbol, ts } = context;
    this.baselineKey(symbol, "volume_delta").push(Math.abs(context.volumeDelta));
    this.baselineKey(symbol, "trade_velocity").push(context.tradeVelocity);
    if (context.price !== null) this.feedPrice(symbol, ts, context.price);

    const deliverable: TriggeredAlert[] = [];
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      if (rule.symbol !== "*" && rule.symbol !== symbol) continue;

      const assessment = this.assessRule(rule, context);
      if (!assessment) continue;
      if (
        assessment.conditionTrue &&
        ts - this.lastConditionSampleAt(rule.id, symbol) >= 1_000
      ) {
        this.noteConditionSample(rule.id, symbol, ts);
        this.recordSignalSample(rule, context, assessment.direction, "condition");
      }
      if (!assessment.shouldTrigger) continue;

      const cooldownKey = `${rule.id}:${symbol}`;
      const lastTrigger = this.lastTriggerAtMs.get(cooldownKey) ?? Number.NEGATIVE_INFINITY;
      if (ts - lastTrigger < rule.cooldownMs) {
        this.pushAudit({
          atMs: ts,
          kind: "suppressed_cooldown",
          ruleId: rule.id,
          symbol,
          detail: `next allowed at ${lastTrigger + rule.cooldownMs}`,
        });
        continue;
      }
      this.lastTriggerAtMs.set(cooldownKey, ts);

      const alert: TriggeredAlert = {
        alertId: this.options.randomId(),
        ruleId: rule.id,
        kind: rule.kind,
        symbol,
        ts,
        direction: assessment.direction,
        value: roundTo(assessment.value, 6),
        threshold: roundTo(assessment.threshold, 6),
        baselineMedian: assessment.baselineMedian === null
          ? null
          : roundTo(assessment.baselineMedian, 6),
        reason: assessment.reason,
        algoVersion: ALERT_ALGO_VERSION,
        sound: rule.sound,
        shadow: this.options.shadowMode,
      };
      this.recordSignalSample(rule, context, assessment.direction, "trigger");
      if (this.options.shadowMode) {
        // Shadow mode: the signal exists and is evaluated, but nothing is sent.
        this.pushAudit({ atMs: ts, kind: "suppressed_shadow", ruleId: rule.id, symbol, detail: assessment.reason });
      } else {
        this.pushAudit({ atMs: ts, kind: "triggered", ruleId: rule.id, symbol, detail: assessment.reason });
        deliverable.push(alert);
      }
    }
    return deliverable;
  }

  /** Feeds a price print so pending horizon evaluations can resolve. */
  feedPrice(symbol: string, ts: number, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    for (const sample of this.signalSamples) {
      if (sample.symbol !== symbol || sample.entryPrice <= 0) continue;
      const moveBps = ((price - sample.entryPrice) / sample.entryPrice) * 10_000;
      const signedMove = sample.direction === "bullish" ? moveBps : -moveBps;
      for (const [horizonMs, state] of sample.horizons) {
        if (state.mfeBps < signedMove) state.mfeBps = signedMove;
        if (state.maeBps > signedMove) state.maeBps = signedMove;
        if (!state.resolved && ts >= sample.entryTs + horizonMs) {
          state.resolved = true;
          state.exitPrice = price;
        }
      }
    }
  }

  /** Aggregated forward-performance rows per kind/symbol/horizon/segment. */
  performance(filter: { symbol?: string; kind?: AlertKind } = {}): PerformanceRow[] {
    interface Accumulator {
      kind: AlertKind;
      symbol: string;
      horizonMs: number;
      segmentHourUtc: number;
      volatilityBucket: "low" | "mid" | "high";
      source: "trigger" | "condition";
      triggered: number;
      resolved: number;
      favorable: number;
      mfeSum: number;
      maeSum: number;
      versions: Set<string>;
    }
    const rows = new Map<string, Accumulator>();
    for (const sample of this.signalSamples) {
      if (filter.symbol && sample.symbol !== filter.symbol) continue;
      if (filter.kind && sample.kind !== filter.kind) continue;
      for (const [horizonMs, state] of sample.horizons) {
        const key = `${sample.kind}:${sample.symbol}:${horizonMs}:${sample.hourUtc}:${sample.volatilityBucket}:${sample.source}`;
        let row = rows.get(key);
        if (!row) {
          row = {
            kind: sample.kind,
            symbol: sample.symbol,
            horizonMs,
            segmentHourUtc: sample.hourUtc,
            volatilityBucket: sample.volatilityBucket,
            source: sample.source,
            triggered: 0,
            resolved: 0,
            favorable: 0,
            mfeSum: 0,
            maeSum: 0,
            versions: new Set<string>(),
          };
          rows.set(key, row);
        }
        if (sample.source === "trigger") row.triggered += 1;
        if (!state.resolved || Number.isNaN(state.exitPrice)) continue;
        const favorable =
          (sample.direction === "bullish" && state.exitPrice > sample.entryPrice) ||
          (sample.direction === "bearish" && state.exitPrice < sample.entryPrice);
        row.resolved += 1;
        if (favorable) row.favorable += 1;
        row.mfeSum += state.mfeBps;
        row.maeSum += state.maeBps;
        row.versions.add(sample.algoVersion);
      }
    }

    return [...rows.values()]
      .map((row): PerformanceRow => ({
        kind: row.kind,
        symbol: row.symbol,
        horizonMs: row.horizonMs,
        segmentHourUtc: row.segmentHourUtc,
        volatilityBucket: row.volatilityBucket,
        signalsTriggered: row.triggered,
        signalsResolved: row.resolved,
        favorable: row.favorable,
        precision: row.resolved > 0 ? Number((row.favorable / row.resolved).toFixed(4)) : 0,
        avgFavorableExcursionBps: Number((row.resolved > 0 ? row.mfeSum / row.resolved : 0).toFixed(2)),
        avgAdverseExcursionBps: Number((row.resolved > 0 ? row.maeSum / row.resolved : 0).toFixed(2)),
        algoVersions: [...row.versions].sort(),
      }))
      .sort((left, right) =>
        `${left.kind}${left.symbol}`.localeCompare(`${right.kind}${right.symbol}`) ||
        left.horizonMs - right.horizonMs);
  }

  auditTrail(limit = 100): AuditEntry[] {
    return this.audit.slice(-Math.max(1, Math.min(limit, MAX_AUDIT_ENTRIES))).reverse();
  }

  baselinesSummary(): Array<{ symbol: string; metric: string; samples: number; median: number | null }> {
    return [...this.baselines.entries()]
      .map(([key, baseline]) => {
        const separator = key.indexOf(":");
        return {
          symbol: key.slice(0, separator),
          metric: key.slice(separator + 1),
          samples: baseline.samples,
          median: baseline.median(),
        };
      })
      .sort((left, right) => `${left.symbol}:${left.metric}`.localeCompare(`${right.symbol}:${right.metric}`));
  }

  /** Clears volatile state (replay validation between independent runs). */
  resetVolatileState(): void {
    this.baselines.clear();
    this.signalSamples.length = 0;
    this.audit.length = 0;
    this.lastTriggerAtMs.clear();
    this.conditionSampleAt.clear();
  }

  private readonly conditionSampleAt = new Map<string, number>();

  private assessRule(
    rule: AlertRule,
    context: AlertEvaluationContext,
  ): {
    shouldTrigger: boolean;
    conditionTrue: boolean;
    direction: "bullish" | "bearish" | null;
    value: number;
    threshold: number;
    baselineMedian: number | null;
    reason: string;
  } | null {
    switch (rule.kind) {
      case "trend_score": {
        const value = context.trendScore;
        const threshold = rule.absoluteValue ?? 60;
        const op: AlertOp = rule.op ?? "above";
        const hit = op === "above" ? value >= threshold : value <= threshold;
        return {
          shouldTrigger: hit,
          conditionTrue: hit,
          direction:
            context.trendDirection === "up"
              ? "bullish"
              : context.trendDirection === "down"
                ? "bearish"
                : null,
          value,
          threshold,
          baselineMedian: null,
          reason: `Trend score ${value} ${op} ${threshold} (direction ${context.trendDirection ?? "neutral"})`,
        };
      }
      case "volume_delta": {
        const baseline = this.baselineKey(context.symbol, "volume_delta").median();
        const threshold = resolveThreshold(rule, baseline);
        if (threshold === null) {
          return { shouldTrigger: false, conditionTrue: false, direction: null, value: context.volumeDelta, threshold: 0, baselineMedian: baseline, reason: "" };
        }
        const op: AlertOp = rule.op ?? "above";
        const limit = op === "above" ? Math.abs(threshold) : -Math.abs(threshold);
        const hit = op === "above" ? context.volumeDelta >= limit : context.volumeDelta <= limit;
        return {
          shouldTrigger: hit,
          conditionTrue: hit,
          direction: !hit ? null : op === "above" ? "bullish" : "bearish",
          value: roundTo(context.volumeDelta, 6),
          threshold: limit,
          baselineMedian: baseline,
          reason: `5s volume delta ${roundTo(context.volumeDelta, 4)} vs ${rule.thresholdMode} ${op} ${roundTo(limit, 4)}`,
        };
      }
      case "trade_velocity": {
        const baseline = this.baselineKey(context.symbol, "trade_velocity").median();
        const threshold = resolveThreshold(rule, baseline);
        if (threshold === null) return null;
        const hit = context.tradeVelocity >= threshold;
        return {
          shouldTrigger: hit,
          conditionTrue: hit,
          direction: null,
          value: roundTo(context.tradeVelocity, 4),
          threshold: roundTo(threshold, 4),
          baselineMedian: baseline,
          reason: `Trade velocity ${roundTo(context.tradeVelocity, 2)}/s vs ${rule.thresholdMode} ${roundTo(threshold, 2)}/s`,
        };
      }
      case "liquidity_wall": {
        const wanted = rule.wallState ?? "appeared";
        const match = context.wallTransitions.find((transition) => transition.kind === wanted);
        if (!match) {
          return { shouldTrigger: false, conditionTrue: false, direction: null, value: 0, threshold: 0, baselineMedian: null, reason: "" };
        }
        return {
          shouldTrigger: true,
          conditionTrue: true,
          direction: match.wall.side === "bid" ? "bullish" : "bearish",
          value: match.wall.quantity,
          threshold: 0,
          baselineMedian: null,
          reason: `Wall on ${match.wall.side} at ${match.wall.price} ${wanted} (qty ${match.wall.quantity})`,
        };
      }
      default:
        return null;
    }
  }

  private recordSignalSample(
    rule: AlertRule,
    context: AlertEvaluationContext,
    direction: "bullish" | "bearish" | null,
    source: "trigger" | "condition",
  ): void {
    if (context.price === null || !Number.isFinite(context.price) || context.price <= 0) return;
    const sample: SignalSample = {
      signalId: this.options.randomId(),
      algoVersion: ALERT_ALGO_VERSION,
      kind: rule.kind,
      symbol: context.symbol,
      direction: direction ?? "bullish",
      source,
      entryTs: context.ts,
      entryPrice: context.price,
      hourUtc: new Date(normalizeTs(context.ts, this.options.now)).getUTCHours(),
      volatilityBucket: bucketVolatility(context.realizedVolBps ?? 0),
      horizons: new Map(SIGNAL_HORIZONS_MS.map((horizonMs) => [
        horizonMs,
        { resolved: false, exitPrice: Number.NaN, mfeBps: 0, maeBps: 0 },
      ])),
    };
    this.signalSamples.push(sample);
    if (this.signalSamples.length > MAX_SIGNAL_SAMPLES) {
      this.signalSamples.splice(0, this.signalSamples.length - MAX_SIGNAL_SAMPLES);
    }
  }

  private noteConditionSample(ruleId: string, symbol: string, ts: number): void {
    this.conditionSampleAt.set(`${ruleId}:${symbol}`, ts);
  }

  private lastConditionSampleAt(ruleId: string, symbol: string): number {
    return this.conditionSampleAt.get(`${ruleId}:${symbol}`) ?? Number.NEGATIVE_INFINITY;
  }

  private baselineKey(symbol: string, metric: string): MetricBaseline {
    const key = `${symbol}:${metric}`;
    let baseline = this.baselines.get(key);
    if (!baseline) {
      baseline = new MetricBaseline();
      this.baselines.set(key, baseline);
    }
    return baseline;
  }

  private pushAudit(entry: AuditEntry): void {
    this.audit.push(entry);
    if (this.audit.length > MAX_AUDIT_ENTRIES) {
      this.audit.splice(0, this.audit.length - MAX_AUDIT_ENTRIES);
    }
  }
}

function resolveThreshold(rule: AlertRule, baseline: number | null): number | null {
  if (rule.thresholdMode === "absolute") {
    return typeof rule.absoluteValue === "number" ? Math.abs(rule.absoluteValue) : null;
  }
  if (baseline === null || !Number.isFinite(baseline)) return null;
  const multiplier = typeof rule.multiplier === "number" && rule.multiplier > 0 ? rule.multiplier : 3;
  return baseline * multiplier;
}

function normalizeTs(ts: number, now: () => number): number {
  return Number.isFinite(ts) && ts > 0 ? ts : now();
}

/** Volatility segmentation proxy from realized volatility in bps. */
function bucketVolatility(realizedVolBps: number): "low" | "mid" | "high" {
  if (!Number.isFinite(realizedVolBps) || realizedVolBps < 5) return "low";
  return realizedVolBps < 20 ? "mid" : "high";
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
