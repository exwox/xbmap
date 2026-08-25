import { describe, expect, it } from "vitest";
import { createMarketHttpServer } from "../httpServer.js";
import { MarketGateway } from "../marketGateway.js";
import { createMarketObservability } from "../observability/index.js";

async function listen(service: Awaited<ReturnType<typeof createMarketHttpServer>>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", resolve);
  });
  const address = service.server.address();
  if (typeof address === "object" && address) return address.port;
  throw new Error("listener did not bind a port");
}
describe("phase 3 HTTP observability surface", () => {
  it("exposes liveness, readiness, alerts, incidents, and Prometheus metrics", async () => {
    const observability = createMarketObservability();
    const service = createMarketHttpServer(
      new MarketGateway({ forceDemo: true, metrics: observability.hooks }),
      null,
      observability,
    );
    const port = await listen(service);
    const base = `http://127.0.0.1:${port}`;

    try {
      const live = await fetch(`${base}/api/v1/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ ok: true });

      const ready = await fetch(`${base}/api/v1/health/ready`);
      expect([200, 503]).toContain(ready.status);

      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      const text = await metrics.text();
      for (const family of [
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
        "process_cpu_ratio",
        "process_uptime_seconds",
        "gateway_event_processing_ms",
        "gateway_frame_build_ms",
        "http_request_duration_ms",
        "websocket_buffered_bytes",
        "websocket_frame_bytes",
        "http_requests_total",
        "alerts_emitted_total",
      ]) {
        expect(text).toContain(`# TYPE ${family}`);
      }

      const incidents = await fetch(`${base}/api/v1/observability/incidents`);
      expect(incidents.status).toBe(200);
      expect(await incidents.json()).toMatchObject({ incidentCount: 0 });

      const alerts = await fetch(`${base}/api/v1/observability/alerts`);
      expect(alerts.status).toBe(200);
      const payload = await alerts.json();
      expect(Array.isArray(payload.active)).toBe(true);
      expect(Array.isArray(payload.recent)).toBe(true);
    } finally {
      await service.close();
    }
  });
});