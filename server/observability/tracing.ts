/**
 * Lightweight OpenTelemetry-compatible tracer for Phase 3.
 *
 * Emits W3C-compatible 128-bit trace ids / 64-bit span ids and exports
 * finished spans as OTLP/JSON (`resourceSpans[...]`) over HTTP when
 * `XBMAP_OTEL_EXPORTER_OTLP_ENDPOINT` is configured, mirroring what the
 * OpenTelemetry SDK would produce while keeping the gateway free of heavy
 * SDK dependencies. Every finished span also lands as one structured JSON
 * log line so the "every incident has a trace trail" gate is auditable even
 * without a collector. Spans are bounded in-flight; export failures never
 * affect the request path.
 */

import { randomBytes } from "node:crypto";

export type SpanAttribute = string | number | boolean;

export interface TracingOptions {
  serviceName?: string;
  exporterEndpoint?: string;
  /** Maximum spans buffered for async OTLP delivery; overflow logs and drops. */
  maxBufferedSpans?: number;
  fetcher?: typeof fetch;
  now?: () => number;
}

interface ActiveSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedAtMs: number;
  attributes: Record<string, SpanAttribute>;
}

export interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  outcome: "ok" | "error";
  attributes: Record<string, SpanAttribute>;
}

const NANO = 1_000_000;

function newTraceId(): string {
  return randomBytes(16).toString("hex");
}
function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export class Tracer {
  private readonly buffered: FinishedSpan[] = [];
  private exporting = false;

  constructor(private readonly options: TracingOptions = {}) {}

  get serviceName(): string {
    return this.options.serviceName ?? "xbmap-gateway";
  }

  get exporterEndpoint(): string | null {
    return this.options.exporterEndpoint?.trim() || null;
  }

  get bufferedCount(): number {
    return this.buffered.length;
  }

  /** Starts a span; returns a handle whose `end()` finishes and exports it. */
  startSpan(
    name: string,
    context: { traceId?: string; parentSpanId?: string | null; attributes?: Record<string, SpanAttribute> } = {},
  ): { traceId: string; spanId: string; end: (outcome?: "ok" | "error", attributes?: Record<string, SpanAttribute>) => void } {
    const traceId = context.traceId ?? newTraceId();
    const spanId = newSpanId();
    const startedAtMs = Math.round((this.options.now ?? Date.now)());
    return {
      traceId,
      spanId,
      end: (outcome = "ok", attributes) => {
        const endedAtMs = Math.round((this.options.now ?? Date.now)());
        const span: FinishedSpan = {
          traceId,
          spanId,
          parentSpanId: context.parentSpanId ?? null,
          name,
          startedAtMs,
          endedAtMs,
          durationMs: Math.max(0, endedAtMs - startedAtMs),
          outcome,
          attributes: { ...(context.attributes ?? {}), ...(attributes ?? {}) },
        };
        console.info(JSON.stringify({
          level: "info", component: "tracing", event: "span",
          traceId: span.traceId, spanId: span.spanId,
          parentSpanId: span.parentSpanId, name: span.name,
          durationMs: span.durationMs, outcome: span.outcome,
        }));
        this.retain(span);
      },
    };
  }

  /** Times an async operation as a child span; rethrows while marking error. */
  async withSpan<T>(
    name: string,
    context: Parameters<Tracer["startSpan"]>[1],
    run: (traceId: string, spanId: string) => Promise<T>,
  ): Promise<T> {
    const span = this.startSpan(name, context);
    try {
      const result = await run(span.traceId, span.spanId);
      span.end("ok");
      return result;
    } catch (error) {
      span.end("error", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private retain(span: FinishedSpan): void {
    if (!this.exporterEndpoint) return;
    if (this.buffered.length >= (this.options.maxBufferedSpans ?? 1_024)) {
      // Drop oldest to keep the buffer bounded under collector outages.
      this.buffered.shift();
    }
    this.buffered.push(span);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.exporting || this.buffered.length === 0 || !this.exporterEndpoint) return;
    this.exporting = true;
    const batch = this.buffered.splice(0, this.buffered.length);
    try {
      await (this.options.fetcher ?? fetch)(this.exporterEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.toOtlpJson(batch)),
      });
    } catch (error) {
      console.error(JSON.stringify({
        level: "warn", component: "tracing", event: "otlp_export_failed",
        droppedSpans: batch.length,
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      this.exporting = false;
    }
  }

  /** OTLP/JSON `ExportTraceServiceRequest` body shape. */
  toOtlpJson(spans: readonly FinishedSpan[]): Record<string, unknown> {
    const byTrace = new Map<string, FinishedSpan[]>();
    for (const span of spans) {
      const group = byTrace.get(span.traceId) ?? [];
      group.push(span);
      byTrace.set(span.traceId, group);
    }
    return {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }] },
        scopeSpans: [{
          scope: { name: "xbmap.observability", version: "1" },
          spans: [...byTrace.values()].flat().map((span) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId ?? undefined,
            name: span.name,
            kind: "SPAN_KIND_INTERNAL",
            startTimeUnixNano: String(span.startedAtMs * NANO),
            endTimeUnixNano: String(span.endedAtMs * NANO),
            attributes: Object.entries(span.attributes).map(([key, value]) => ({
              key,
              value: typeof value === "number" ? { doubleValue: value }
                : typeof value === "boolean" ? { boolValue: value }
                : { stringValue: value },
            })),
            status: span.outcome === "error"
              ? { code: "STATUS_CODE_ERROR" }
              : { code: "STATUS_CODE_UNSET" },
          })),
        }],
      }],
    };
  }
}

let globalTracer: Tracer | null = null;

export function initTracing(options: TracingOptions = {}, environment: NodeJS.ProcessEnv = process.env): Tracer {
  globalTracer = new Tracer({
    ...options,
    serviceName: options.serviceName
      ?? environment.XBMAP_OTEL_SERVICE_NAME?.trim()
      ?? "xbmap-gateway",
    exporterEndpoint: options.exporterEndpoint
      ?? environment.XBMAP_OTEL_EXPORTER_OTLP_ENDPOINT,
  });
  return globalTracer;
}

export function getTracer(): Tracer | null {
  return globalTracer;
}


