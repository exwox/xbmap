# Exit Report Fase 3 — Performance dan Observability

Tanggal: 25 Agustus 2026
Status: **CONDITIONAL EXIT**

## 1. Ringkasan

Instrumentasi operasional inti telah terpasang dan teruji di workspace: metrik
Prometheus tanpa dependency (27 family katalog Fase 0), alert internal lima
aturan dengan buffer transisi berbatas, incident trail terstruktur, health
check liveness/readiness terpisah, tracing kompatibel OpenTelemetry dengan
ekspor OTLP/JSON, provisioning Grafana + Prometheus, harness load test
multi-client, dan simulasi kegagalan end-to-end untuk alert. Seluruh jalur
divalidasi lewat `npm run phase3:verify` dan `npm run phase3:loadtest`.

## 2. Kriteria selesai vs bukti

| Kriteria | Status | Bukti |
|---|---|---|
| Setiap incident punya jejak log + metric | ✅ | `recordIncident` menulis log JSON `event:"incident"` dan menaikkan counter per kind; validator case `alert_evaluation` & `alert_failure_simulation` |
| Latency/FPS pada perangkat minimum | ⛔ Gate | Benchmark sintetis + renderer tersedia; pengukuran perangkat fisik minimum tetap gate eksternal |
| Overload → backpressure/graceful degradation | ✅ | WS bufferedAmount monitor + close `1013` + terminate slow client (test delivery); load test memverifikasi tanpa unexpected close |
| Alert diuji via simulasi kegagalan | ✅ | Case `alert_failure_simulation`: feed distarvasi → `stale_feed` critical aktif, counter `alerts_emitted_total` naik, trail masuk buffer recent |

## 3. Deliverable teknis

- `server/observability/metrics.ts` — registry Prometheus (counter/gauge/histogram) render deterministik.
- `server/observability/alerts.ts` — evaluator aturan: `stale_feed` (critical), `sequence_gap`, `recovery_loop`, `http_error_rate`, `memory_pressure`.
- `server/observability/index.ts` — aggregator: diff counter data-quality, proses health (RSS/heap/CPU/uptime), durasi stale/resync, state gauge.
- `server/observability/tracing.ts` — tracer W3C-shaped (`traceId` 128-bit) + ekspor OTLP/JSON ke `XBMAP_OTEL_EXPORTER_OTLP_ENDPOINT`; span HTTP otomatis di middleware; span gagal tidak pernah memengaruhi request path.
- Endpoint: `/metrics`, `/api/v1/health/live`, `/api/v1/health/ready`, `/api/v1/observability/alerts`, `/api/v1/observability/incidents`.
- `grafana/provisioning/**` + `grafana/dashboards/gateway-operational.json` — datasource Prometheus + dashboard operasional (validitas market, p95/p50 processing, WS clients/buffered, gaps/resyncs, HTTP rate by status, CPU/heap).
- `scripts/phase3/run.ts` — validator 5 kasus (exposition, liveness/readiness, alert evaluation, failure simulation, metrics stability).
- `scripts/phase3/load-test.ts` — multi-client WS load test in-process (`npm run phase3:loadtest`).
- `npm run phase3:soak24` — runner soak 24 jam (memanfaatkan mesin soak Fase 1 dengan `--duration 86400000`).

## 4. Hasil verifikasi workspace (25 Agustus 2026)

- `phase2:verify` + `phase3:validate`: seluruh kasus lulus (`allPassed: true`).
- Test suite penuh: **152/152** (termasuk +14 test baru storage adapter Fase 2 dan +4 test tracing).
- Build produksi web: sukses (~292 kB / gzip ~92 kB).

## 5. Gate yang masih terbuka

1. **Soak 24 jam sungguhan** — harness siap (`phase3:soak24`) namun eksekusi penuh belum dilakukan di workspace.
2. **Load test pada skala target & host produksi** — harness lulus di workspace; angka resmi beta harus dari deployment target.
3. **Event-to-screen p95 < 150 ms dan FPS ≥ 30 pada perangkat minimum** — butuh perangkat fisik.
4. **Kolektor OTLP live** (OpenTelemetry Collector/Jaeger) — exporter teruji unit-level; integrasi collector adalah langkah deployment.

## 6. Keputusan

Fase 4 (Multi-Symbol Beta) boleh dimulai. Beta eksternal tetap tertahan
sampai gate 1–3 di atas ditutup dengan bukti dari environment produksi.
