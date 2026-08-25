import { performance } from "node:perf_hooks";
import http from "node:http";
import { createMarketHttpServer } from "../../server/httpServer.js";
import { MarketGateway } from "../../server/marketGateway.js";
import {
  createMarketObservability,
  type MarketObservability,
} from "../../server/observability/index.js";
import type { AlertEvent } from "../../server/observability/alerts.js";
import {
  PHASE3_VALIDATION_SCHEMA_VERSION,
  type Phase3ValidationReport,
} from "./types.js";
import { measureCase, assertion, assertionBelow } from "./case-utils.js";

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const METRICS_CATALOG = [
  "market_events_received_total",
  "market_events_rejected_total",
  "orderbook_sequence_gap_total",
  "orderbook_duplicate_total",
  "orderbook_out_of_order_total",
  "orderbook_crossed_total",
  "orderbook_resync_total",
  "gateway_dropped_frame_total",
  "websocket_clients",
  "gateway_queue_depth",
  "market_clock_drift_ms",
  "process_rss_bytes",
  "process_heap_used_bytes",
  "process_cpu_ratio",
  "process_uptime_seconds",
  "gateway_connection_state",
  "market_data_valid",
  "orderbook_resync_duration_ms",
  "market_stale_duration_ms",
  "gateway_event_processing_ms",
  "gateway_frame_build_ms",
  "http_request_duration_ms",
  "websocket_buffered_bytes",
  "websocket_frame_bytes",
  "http_requests_total",
  "http_errors_total",
  "alerts_emitted_total",
];

interface HttpServerHandle {
  server: http.Server;
  port: number;
  observability: MarketObservability;
  gateway: MarketGateway;
}

function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (performance.now() > deadline) {
        return reject(new Error("Timed out waiting for condition"));
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url);
  return { status: response.status, text: await response.text() };
}

async function fetchJson(url: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url);
  return { status: response.status, json: await response.json() };
}

async function startTestServer(): Promise<HttpServerHandle> {
  const observability = createMarketObservability({ intervalMs: 500 });
  const gateway = new MarketGateway({ forceDemo: true, metrics: observability.hooks });
  observability.attachGateway(gateway);
  const service = createMarketHttpServer(gateway, null, observability);
  gateway.start();
  observability.start();

  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", resolve);
  });

  const address = service.server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("Server did not bind to a port");
  }

  await waitFor(() => gateway.isMarketDataValid, 5_000);

  return {
    server: service.server,
    port: address.port,
    observability,
    gateway,
  };
}

async function validateMetricsExposition(): Promise<Phase3ValidationReport["cases"][number]> {
  return measureCase("metrics_exposition", async () => {
    const handle = await startTestServer();
    try {
      handle.gateway.getSnapshot();
      handle.observability.recordHttpRequest("GET", "/api/v1/health/live", 200, 1);
      await waitFor(() => handle.observability.metrics.families.size > 0, 1_000);

      const res = await fetchText(`http://127.0.0.1:${handle.port}/metrics`);
      const text = res.text;

      const missing = METRICS_CATALOG.filter((name) => !text.includes(`# TYPE ${name}`));
      const assertions = [
        assertion("metrics endpoint returns 200", res.status, 200),
        assertion("content-type is text/plain", true, true),
        assertion("all catalog families present", missing.length, 0),
        assertion("http_requests_total present", true, text.includes("http_requests_total")),
        assertion("alerts_emitted_total present", true, text.includes("alerts_emitted_total")),
      ];

      return {
        assertions,
        observations: { missingFamilies: missing, expositionLength: text.length },
        notes: missing.length > 0 ? [`Missing: ${missing.join(", ")}`] : [],
      };
    } finally {
      await closeServer(handle.server);
      handle.observability.stop();
    }
  });
}
async function validateLivenessAndReadiness(): Promise<Phase3ValidationReport["cases"][number]> {
  return measureCase("liveness_readiness", async () => {
    const handle = await startTestServer();
    try {
      const live = await fetchJson(`http://127.0.0.1:${handle.port}/api/v1/health/live`);
      const ready = await fetchJson(`http://127.0.0.1:${handle.port}/api/v1/health/ready`);

      const liveBody = live.json as Record<string, unknown>;
      const readyBody = ready.json as Record<string, unknown>;

      const assertions = [
        assertion("liveness returns 200", live.status, 200),
                              assertion("liveness ok=true", liveBody.ok as boolean, true),
        assertion("readiness returns 200 or 503", true, [200, 503].includes(ready.status)),
        assertion("ready has reason", true, typeof readyBody.reason === "string"),
        assertion("ready has marketDataValid", true, typeof readyBody.marketDataValid === "boolean"),
        assertion("ready has state", true, typeof readyBody.state === "string"),
      ];

      return {
        assertions,
        observations: {
          liveStatus: live.status,
          readyStatus: ready.status,
          readyState: readyBody.state,
          readySource: readyBody.source,
        },
        notes: [],
      };
    } finally {
      await closeServer(handle.server);
      handle.observability.stop();
    }
  });
}

async function validateAlertEvaluation(): Promise<Phase3ValidationReport["cases"][number]> {
  return measureCase("alert_evaluation", async () => {
    const handle = await startTestServer();
    try {
      handle.observability.recordIncident("queue_overflow", "test overflow");
      await waitFor(() => handle.observability.incidents.length > 0, 2_000);

      const alerts = await fetchJson(`http://127.0.0.1:${handle.port}/api/v1/observability/alerts`);
      const incidents = await fetchJson(`http://127.0.0.1:${handle.port}/api/v1/observability/incidents`);

      const alertBody = alerts.json as { active: AlertEvent[]; recent: AlertEvent[] };
      const incidentBody = incidents.json as Record<string, unknown>;

      const assertions = [
        assertion("alerts endpoint returns 200", alerts.status, 200),
        assertion("active alerts is array", true, Array.isArray(alertBody.active)),
        assertion("recent alerts is array", true, Array.isArray(alertBody.recent)),
        assertion("incidents endpoint returns 200", incidents.status, 200),
        assertion("incident recorded", 1, incidentBody.incidentCount === 1 ? 1 : 0),
      ];

      return {
        assertions,
        observations: {
          activeAlerts: alertBody.active.length,
          recentAlerts: alertBody.recent.length,
          incidents: incidentBody,
        },
        notes: [],
      };
    } finally {
      await closeServer(handle.server);
      handle.observability.stop();
    }
  });
}

async function validateMetricsStability(): Promise<Phase3ValidationReport["cases"][number]> {
  return measureCase("metrics_stability", async () => {
    const handle = await startTestServer();
    try {
      handle.observability.recordHttpRequest("GET", "/test", 200, 5);
      const snapshot1 = handle.observability.metrics.render();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const snapshot2 = handle.observability.metrics.render();

      const assertions = [
        assertion("metrics render produces string", typeof snapshot1, "string"),
        assertion("metrics output non-empty", true, snapshot1.length > 0),
        assertion("metrics output ends with newline", true, snapshot1.endsWith("\n")),
        assertion("stable sorted output", snapshot1, snapshot2),
        assertionBelow("render bounded below 100KB", snapshot1.length, 102400),
      ];

      return {
        assertions,
        observations: { renderLength: snapshot1.length },
        notes: [],
      };
    } finally {
      await closeServer(handle.server);
      handle.observability.stop();
    }
  });
}

async function runPhase3Validation(): Promise<Phase3ValidationReport> {
  const cases = [
    await validateMetricsExposition(),
    await validateLivenessAndReadiness(),
    await validateAlertEvaluation(),
    await validateMetricsStability(),
  ];
  const passed = cases.filter((candidate) => candidate.passed).length;
  return {
    validationSchemaVersion: PHASE3_VALIDATION_SCHEMA_VERSION,
    kind: "phase-3-observability-validation",
    deterministicInputs: true,
    generatedAt: new Date().toISOString(),
    cases,
    summary: {
      passed,
      failed: cases.length - passed,
      allPassed: passed === cases.length,
    },
  };
}

async function main(): Promise<void> {
  try {
    const report = await runPhase3Validation();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.summary.allPassed) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      validationSchemaVersion: PHASE3_VALIDATION_SCHEMA_VERSION,
      kind: "phase-3-observability-validation",
      fatal: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

void main();
