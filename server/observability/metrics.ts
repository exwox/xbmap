/**
 * Dependency-free Prometheus exposition registry.
 *
 * Implements the exact metric catalog from `docs/phase-0/quality-targets.md`
 * for Phase 3 and intentionally avoids external dependencies so the gateway
 * remains a single-process, no-native-modules service. All series are
 * cumulative mutations; rendering is stable (sorted names and labels) so that
 * a diff between two `/metrics` snapshots is meaningful to test harnesses.
 */

export type LabelValues = Record<string, string>;

export type MetricType = "counter" | "gauge" | "histogram";

/** Writes a stable sorted label key; order-independent across call sites. */
export function stableLabelKey(values: LabelValues): string {
  return Object.entries(values)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class CounterMetric {
  readonly type = "counter" as const;
  private readonly series = new Map<string, { labels: LabelValues; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
  ) {}

  inc(value = 1, labels: LabelValues = {}): number {
    if (value <= 0) throw new Error(`${this.name} counter increment must be positive`);
    const key = stableLabelKey(labels);
    const record = this.series.get(key);
    if (record) {
      record.value += value;
      return record.value;
    }
    this.series.set(key, { labels: { ...labels }, value });
    return value;
  }

  /** Current cumulative value for a label combination, including unseen labels as 0. */
  peek(labels: LabelValues = {}): number {
    return this.series.get(stableLabelKey(labels))?.value ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    const sorted = [...this.series.values()].sort((left, right) =>
      stableLabelKey(left.labels) < stableLabelKey(right.labels) ? -1 : 1,
    );
    for (const record of sorted) {
      lines.push(`${this.name}${formatLabels(record.labels)} ${renderFloat(record.value)}`);
    }
    return lines;
  }
}

export class GaugeMetric {
  readonly type = "gauge" as const;
  private readonly series = new Map<string, { labels: LabelValues; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
  ) {}

  set(value: number, labels: LabelValues = {}): void {
    const key = stableLabelKey(labels);
    const existing = this.series.get(key);
    if (existing) {
      existing.value = value;
    } else {
      this.series.set(key, { labels: { ...labels }, value });
    }
  }

  add(delta: number, labels: LabelValues = {}): void {
    const key = stableLabelKey(labels);
    const existing = this.series.get(key) ?? { labels: { ...labels }, value: 0 };
    existing.value += delta;
    this.series.set(key, existing);
  }

  peek(labels: LabelValues = {}): number {
    return this.series.get(stableLabelKey(labels))?.value ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    const sorted = [...this.series.values()].sort((left, right) =>
      stableLabelKey(left.labels) < stableLabelKey(right.labels) ? -1 : 1,
    );
    for (const record of sorted) {
      lines.push(`${this.name}${formatLabels(record.labels)} ${renderFloat(record.value)}`);
    }
    return lines;
  }
}
export const DEFAULT_HISTOGRAM_BUCKETS_MS = [
  1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
] as const;

/** A value exactly equal to a bucket boundary counts in the upper bucket. */
function bucketIndex(buckets: readonly number[], value: number): number {
  for (let index = 0; index < buckets.length; index += 1) {
    if (value <= buckets[index]!) return index;
  }
  return buckets.length;
}

interface HistogramRecord {
  labels: LabelValues;
  buckets: number[];
  sum: number;
  count: number;
}

export class HistogramMetric {
  readonly type = "histogram" as const;
  private readonly series = new Map<string, HistogramRecord>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[] = DEFAULT_HISTOGRAM_BUCKETS_MS,
    readonly labelNames: readonly string[] = [],
  ) {}

  observe(value: number, labels: LabelValues = {}): void {
    const key = stableLabelKey(labels);
    const record = this.series.has(key)
      ? this.series.get(key)!
      : { labels: { ...labels }, buckets: this.buckets.map(() => 0), sum: 0, count: 0 };
    const index = bucketIndex(this.buckets, value);
    for (let bucket = index; bucket < record.buckets.length; bucket += 1) {
      record.buckets[bucket]! += 1;
    }
    record.sum += value;
    record.count += 1;
    this.series.set(key, record);
  }

  peekCount(labels: LabelValues = {}): number {
    return this.series.get(stableLabelKey(labels))?.count ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    const sorted = [...this.series.values()].sort((left, right) =>
      stableLabelKey(left.labels) < stableLabelKey(right.labels) ? -1 : 1,
    );
    for (const record of sorted) {
      for (let index = 0; index < this.buckets.length; index += 1) {
        const bound = String(this.buckets[index]);
        lines.push(
          `${this.name}_bucket${formatLabels({ ...record.labels, le: bound })} ${record.buckets[index]}`,
        );
      }
      lines.push(
        `${this.name}_bucket${formatLabels({ ...record.labels, le: "+Inf" })} ${record.count}`,
      );
      lines.push(`${this.name}_sum${formatLabels(record.labels)} ${renderFloat(record.sum)}`);
      lines.push(`${this.name}_count${formatLabels(record.labels)} ${record.count}`);
    }
    return lines;
  }
}
function formatLabels(labels: LabelValues): string {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function renderFloat(value: number): string {
  if (!Number.isFinite(value)) return "NaN";
  if (Number.isInteger(value)) return String(value);
  // Preserve up to 6 significant digits, trimming trailing zeros.
  return String(Number(value.toPrecision(6)));
}

/** Ordered family registry with stable exposition rendering. */
export class MetricRegistry {
  readonly families = new Map<string, CounterMetric | GaugeMetric | HistogramMetric>();

  counter(name: string, help: string, labelNames: readonly string[] = []): CounterMetric {
    return this.register(new CounterMetric(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): GaugeMetric {
    return this.register(new GaugeMetric(name, help, labelNames));
  }

  histogram(
    name: string,
    help: string,
    buckets?: readonly number[],
    labelNames: readonly string[] = [],
  ): HistogramMetric {
    return this.register(new HistogramMetric(name, help, buckets, labelNames));
  }

  private register<T extends CounterMetric | GaugeMetric | HistogramMetric>(metric: T): T {
    if (this.families.has(metric.name)) {
      throw new Error(`Metric ${metric.name} is registered more than once`);
    }
    this.families.set(metric.name, metric);
    return metric;
  }

  /** Renders the full Prometheus text exposition. */
  render(): string {
    const names = [...this.families.keys()].sort();
    const lines: string[] = [];
    for (const name of names) {
      const family = this.families.get(name)!;
      for (const row of family.render()) lines.push(row);
    }
    return `${lines.join("\n")}\n`;
  }
}

/** Shared label guard for metric call sites. */
export function metricLabel(value: unknown, fallback = "unknown"): string {
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}