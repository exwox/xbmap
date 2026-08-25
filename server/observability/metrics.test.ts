import { describe, expect, it } from "vitest";
import {
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  MetricRegistry,
} from "./metrics.js";

describe("metrics registry", () => {
  it("renders counter help, type, and sorted series without labels", () => {
    const counter = new CounterMetric("market_events_received_total", "Events received", []);
    counter.inc(3);
    counter.inc(2);
    const lines = counter.render();
    expect(lines).toContain("# HELP market_events_received_total Events received");
    expect(lines).toContain("# TYPE market_events_received_total counter");
    expect(lines).toContain("market_events_received_total 5");
  });

  it("renders labeled series deterministically and sorts label sets", () => {
    const counter = new CounterMetric("orderbook_resync_total", "resyncs", ["exchange", "symbol", "reason"]);
    counter.inc(1, { symbol: "BTCUSDT", exchange: "binance", reason: "gap" });
    counter.inc(4, { exchange: "binance", reason: "crossed", symbol: "BTCUSDT" });
    counter.inc(2, { symbol: "BTCUSDT", exchange: "binance", reason: "gap" });
    const text = counter.render().join("\n");
    expect(text).toContain(
      'orderbook_resync_total{exchange="binance",reason="crossed",symbol="BTCUSDT"} 4',
    );
    expect(text).toContain(
      'orderbook_resync_total{exchange="binance",reason="gap",symbol="BTCUSDT"} 3',
    );
  });

  it("rejects non-positive counter increments", () => {
    const counter = new CounterMetric("c", "h");
    expect(() => counter.inc(0)).toThrow();
    expect(() => counter.inc(-1)).toThrow();
  });

  it("peek returns the cumulative value or zero for unseen labels", () => {
    const counter = new CounterMetric("c", "h", ["kind"]);
    counter.inc(7, { kind: "depth" });
    expect(counter.peek({ kind: "depth" })).toBe(7);
    expect(counter.peek({ kind: "trade" })).toBe(0);
  });

  it("gauge set/add/render", () => {
    const gauge = new GaugeMetric("websocket_clients", "clients", ["subscription"]);
    gauge.set(2, { subscription: "total" });
    gauge.add(1, { subscription: "total" });
    expect(gauge.peek({ subscription: "total" })).toBe(3);
    expect(gauge.render()).toContain('websocket_clients{subscription="total"} 3');
  });

  it("histogram buckets values into upper-bound buckets with sum and count", () => {
    const histogram = new HistogramMetric("latency_ms", "latency", [5, 10, 25]);
    histogram.observe(1);
    histogram.observe(5);
    histogram.observe(30);
    const lines = histogram.render().join("\n");
    expect(lines).toContain('latency_ms_bucket{le="5"} 2');
    expect(lines).toContain('latency_ms_bucket{le="10"} 2');
    expect(lines).toContain('latency_ms_bucket{le="25"} 2');
    expect(lines).toContain('latency_ms_bucket{le="+Inf"} 3');
    expect(lines).toContain('latency_ms_sum 36');
    expect(lines).toContain("latency_ms_count 3");
  });

  it("registry rejects duplicate family names", () => {
    const registry = new MetricRegistry();
    registry.counter("dup", "first");
    expect(() => registry.counter("dup", "second")).toThrow(/registered more than once/);
  });

  it("registry render is stable and includes every registered family", () => {
    const registry = new MetricRegistry();
    registry.counter("a_total", "a");
    registry.histogram("b_ms", "b");
    registry.gauge("c", "c");
    const text = registry.render();
    expect(text.startsWith("# HELP a_total a\n# TYPE a_total counter")).toBe(true);
    expect(text).toContain("# TYPE b_ms histogram");
    expect(text).toContain("# TYPE c gauge");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("escapes quotes and backslashes in label values", () => {
    const counter = new CounterMetric("c", "h", ["kind"]);
    counter.inc(1, { kind: 'a"b\\c' });
    expect(counter.render().join("\n")).toContain(
      'c{kind="a\\"b\\\\c"} 1',
    );
  });
});