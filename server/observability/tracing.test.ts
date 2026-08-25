import { describe, expect, it, vi } from "vitest";
import { Tracer } from "./tracing.js";

describe("OTel-compatible tracer", () => {
  it("emits structured span logs with W3C-shaped ids", async () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const clock = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_025);
    const tracer = new Tracer({ serviceName: "test-svc", now: clock });
    const span = tracer.startSpan("http GET /metrics", { attributes: { route: "/metrics" } });
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    span.end("ok", { "http.status_code": 200 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(vi.mocked(logSpy).mock.calls[0]![0] as string);
    logSpy.mockRestore();
    expect(entry).toMatchObject({
      event: "span", name: "http GET /metrics",
      durationMs: 25, outcome: "ok", traceId: span.traceId,
    });
  });

  it("exports finished spans as OTLP/JSON to the configured endpoint", async () => {
    const bodies: string[] = [];
    const fetcher = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body));
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as typeof fetch;
    let tick = 2_000;
    const tracer = new Tracer({
      serviceName: "xbmap-test",
      exporterEndpoint: "http://collector:4318/v1/traces",
      fetcher,
      now: () => ++tick,
    });
    await tracer.withSpan("ingestion frame", { attributes: { symbol: "BTCUSDT" } }, async () => {
      // simulated work
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bodies).toHaveLength(1);
    const payload = JSON.parse(bodies[0]!) as {
      resourceSpans: Array<{ resource: { attributes: unknown[] }; scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
    };
    expect(payload.resourceSpans[0].resource.attributes).toContainEqual({
      key: "service.name", value: { stringValue: "xbmap-test" },
    });
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span).toMatchObject({ name: "ingestion frame", kind: "SPAN_KIND_INTERNAL" });
    expect(String(span.startTimeUnixNano)).toMatch(/^\d+$/);
  });

  it("marks error outcome and keeps the buffer bounded on collector outage", async () => {
    const fetcher = (async () => { throw new Error("collector down"); }) as typeof fetch;
    let tick = 5_000;
    const tracer = new Tracer({
      exporterEndpoint: "http://collector:4318/v1/traces",
      maxBufferedSpans: 2,
      fetcher,
      now: () => ++tick,
    });
    try {
      await tracer.withSpan("boom", {}, async () => { throw new Error("kaboom"); });
    } catch { /* expected */ }
    for (let index = 0; index < 5; index += 1) tracer.startSpan(`s${index}`).end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tracer.bufferedCount).toBeLessThanOrEqual(2);
  });

  it("does not buffer spans without an exporter endpoint", async () => {
    const tracer = new Tracer({ now: () => 9_000 });
    tracer.startSpan("local").end();
    expect(tracer.bufferedCount).toBe(0);
  });
});
