# Checklist Implementasi — LiquidMap vs development-plan.md

Terakhir diperbarui: 25 Agustus 2026.
Tanda: `[x]` selesai · `[~]` sebagian/bersyarat · `[ ]` belum diimplementasikan.

---

## Fase 0 — Baseline dan Keputusan Produk (`CONDITIONAL EXIT`)

- [x] ADR database, event bus, schema versioning (`docs/adr/`)
- [x] Target NFR terukur (`docs/phase-0/quality-targets.md`)
- [x] Schema event internal v1 + tick size/bucket default
- [x] Dataset rekaman pasar untuk regression (`scripts/fixtures/`, `phase0:fixtures`)
- [x] Benchmark sintetis + renderer (`phase0:bench`, `phase0:renderer`)
- [x] Backlog P0/P1/P2 (`docs/phase-0/backlog.md`)
- [ ] **GATE:** Ukur event-rate Binance live jam normal & volatil (butuh jaringan stabil)
- [ ] **GATE:** Uji browser pada perangkat fisik minimum
- [ ] **GATE:** Legal clearance ToS/lisensi penyimpanan exchange (eksternal)

## Fase 1 — Data Correctness dan Reliability (`CONDITIONAL EXIT`)

- [x] Raw feed capture (`server/recording/rawCapture.ts`)
- [x] Checkpoint/fingerprint order book
- [x] Counter gap/duplicate/out-of-order/malformed
- [x] Bedakan transport alive / market inactive / stale
- [x] Resync atomik tanpa state parsial ke client
- [x] Clock-drift monitoring
- [x] Bounded queue + backpressure (WS close 1013, terminate slow client)
- [x] Graceful shutdown menyelesaikan buffer
- [x] Frontend: panel alasan degraded, last-update, freeze sinyal, error boundary
- [x] Fault injection, burst test, replay determinism
- [ ] **GATE:** Soak test 8 jam penuh
- [ ] **GATE:** Live capture berizin (legal)

## Fase 2 — Penyimpanan Historis dan Replay (`CONDITIONAL EXIT`)

- [x] Histori gzip tahan restart + batching (`FileHistoryStore`)
- [x] Downsampling worker 1s/5s/1m + retention policy
- [x] Backup/restore terverifikasi checksum
- [x] Raw replay ber-checksum + session pause/seek/speed persisten (REST)
- [x] Batas query (range/row/segment/byte) + pagination cursor
- [x] Migrasi SQL Postgres/ClickHouse tersedia (`migrations/`)
- [x] **Adapter runtime ClickHouse** untuk trade/depth time-series — `server/storage/clickHouseHistoryStore.ts` (HTTP JSONEachRow, fetch injektif; append/query/retention/backup/restore/checkpoint; 7 test) · aktif via `XBMAP_HISTORY_BACKEND=clickhouse`
- [x] **Adapter runtime PostgreSQL** (metadata sesi replay) — `server/storage/postgresReplaySessions.ts` mengikuti migrasi `0001_replay_metadata.sql` (PoolLike injektif; 5 test); produksi: `new Pool()` + env `XBMAP_PG_*`
- [ ] **Object storage adapter** untuk raw capture terkompresi (kontrak `RawCaptureObjectStore` sudah ada di `storage/types.ts`; implementasi S3/MinIO butuh SigV4 + instance MinIO live untuk verifikasi)
- [x] **Seek full-book pre-roll** dari snapshot valid — `RawCaptureReplaySource.page({includePreRoll})` mengirim snapshot anchor + delta depth bertanda `preroll:true`; endpoint frames HTTP selalu pre-roll; 2 test baru (`seekPreRoll.test.ts`)
- [x] **Historical depth heatmap di UI** — `App.tsx selectMode('replay')` memuat `fetchReplayCapture()` dari gateway; fallback demo sintetis hanya bila raw replay disabled/kosong
- [ ] **GATE:** SLO replay-start < 3 detik pada deployment target nyata (validator sintetis lulus 23,7 ms; gate tetap terbuka)

## Fase 3 — Performance dan Observability

### Selesai
- [x] Registry metrik Prometheus tanpa dependency (`/metrics`, 27 family katalog fase 0)
- [x] Alert internal: stale_feed, sequence_gap, recovery_loop, http_error_rate, memory_pressure
- [x] Incident trail terstruktur (log JSON + counter per kind)
- [x] Health check liveness/readiness TERPISAH (`/api/v1/health/live` vs `/ready`)
- [x] HTTP metrics: request count/duration/errors, WS clients/buffered/frame bytes
- [x] Validator harness fase 3 (`npm run phase3:verify`) — 4 case lulus

### Belum → Terselesaikan (25 Agustus 2026)
- [x] **Tracing OpenTelemetry-compatible** — `server/observability/tracing.ts`: span W3C-shaped, OTLP/JSON exporter (`XBMAP_OTEL_EXPORTER_OTLP_ENDPOINT`), span HTTP otomatis di middleware; +4 test
- [x] **Dashboard Grafana** — `grafana/provisioning/**` (datasource Prometheus + file provider) dan `grafana/dashboards/gateway-operational.json` (validitas, p95/p50 processing, WS clients/buffered, gaps/resyncs, HTTP by status, CPU/heap)
- [x] **Load test multi-client** — `npm run phase3:loadtest` (`scripts/phase3/load-test.ts`): N klien WS in-process, assert tanpa error/unexpected-close/buffer >8MB
- [x] **Simulasi kegagalan alert end-to-end** — case `alert_failure_simulation` di validator fase 3: starve feed → `stale_feed` critical + counter `alerts_emitted_total` + trail recent buffer
- [x] **`docs/phase-3/exit-report.md`** ditulis (CONDITIONAL EXIT)

### Gate yang tetap terbuka (eksternal/deployment)
- [ ] **Soak test 24 jam sungguhan** — runner siap: `npm run phase3:soak24`; eksekusi penuh belum dilakukan di workspace
- [ ] **Web Worker frontend** — item kondisional ("bila profiling membuktikan perlu"); profiling Fase 0 belum menunjukkan bottleneck main-thread pada dataset target, keputusan ditunda sampai pengukuran perangkat minimum
- [ ] Verifikasi p95 event-to-screen < 150 ms & FPS ≥ 30 pada perangkat minimum fisik

## Fase 4 — Multi-Symbol Beta (BELUM DIMULAI)

- [ ] Market-session manager (gateway saat ini single-symbol `MarketGateway.symbol`)
- [ ] Metadata instrument + tick-size discovery
- [ ] Dukung **ETHUSDT dan SOLUSDT** (frontend hardcode `SYMBOLS = { BTCUSDT }`)
- [ ] Batas subscription per client
- [ ] Watchlist
- [ ] Pencarian simbol
- [ ] Buffer terpisah per simbol
- [ ] Cache snapshot + lifecycle subscription (hemat sumber daya saat tanpa client)
- [ ] Test isolasi antarsimbol
- [ ] Pengukuran biaya CPU/memori per simbol per client
- [ ] Perpindahan simbol tanpa reload browser

## Fase 5 — Analytics Lanjutan dan Alert (BELUM DIMULAI)

### Analytics (hanya trend/CVD/volume-ratio/breakout yang sudah ada)
- [ ] Liquidity wall persistence
- [ ] Added/pulled liquidity
- [ ] Absorption
- [ ] Exhaustion
- [ ] Rolling VWAP
- [ ] Volume profile
- [ ] Footprint sederhana
- [ ] Funding rate + open interest
- [ ] Liquidation feed (jika lisensi memungkinkan)

### Alert
- [ ] Alert produk user-configurable: trend score, liquidity wall, volume delta/velocity
- [ ] Cooldown + deduplication
- [ ] Browser notification + suara
- [ ] Webhook + Telegram
- [ ] Audit log alert (dibuat/dipicu/dikirim)

### Evaluasi sinyal
- [ ] Horizon evaluasi 10s/30s/1m/5m
- [ ] Metrik precision/recall/favorable/adverse excursion
- [ ] Segmentasi hasil per simbol/volatilitas/jam
- [ ] Versioning formula/parameter per sinyal
- [ ] Mode shadow sebelum alert stabil
- [ ] Threshold baseline per simbol (bukan universal)

## Fase 6 — Product Beta (BELUM DIMULAI)

### Fitur produk
- [ ] Autentikasi + session management
- [ ] Workspace tersimpan
- [ ] Watchlist pengguna persisten
- [ ] Penyimpanan layout/threshold/warna/alert
- [ ] Onboarding interaktif
- [ ] Shortcut + command palette
- [ ] Ekspor screenshot & CSV
- [ ] Halaman status sistem + release notes

### Keamanan
- [ ] Threat modeling
- [ ] Rate limit berbasis pengguna (per-IP sudah ada)
- [ ] CSP header produksi (belum ada `Content-Security-Policy`)
- [ ] Dependency & container scanning
- [ ] Secret manager
- [ ] Audit log perubahan konfigurasi
- [ ] Backup terenkripsi
- [ ] Retensi data & penghapusan akun

### Operasional beta
- [ ] Kelompok 10–30 pengguna pertama
- [ ] Feature flag
- [ ] Feedback form in-app
- [ ] Runbook disconnect/corruption/database failure
- [ ] Rollback satu perintah
- [ ] Jadwal on-call + klasifikasi severity

## Utang Teknis Teridentifikasi (di luar rencana fase)

- [x] Repo git rusak → diperbaiki (commit awal `ae011bd`)
- [x] Handler `unhandledRejection` → ditambahkan di `server/index.ts`
- [ ] Proteksi auth/port terpisah untuk `/metrics` & endpoint observability
- [ ] Artefak baseline validasi fase 2/3 ke `docs/baselines/`
- [ ] Link mati `docs/baselines/phase-2-validation.md` di exit-report fase 2
- [ ] CI pipeline (type-check + unit test + build sebagai gate PR)

---

## Urutan Pengerjaan yang Disarankan

1. Tutup gate fase 3 (load test multi-client, soak 24 jam, Grafana) — prasyarat sebelum multi-symbol.
2. Kerjakan fase 4 (market-session manager → 3 simbol → watchlist).
3. Paralel: aktifkan adapter Postgres/ClickHouse runtime (gate fase 2) karena fase 4 menaikkan volume data 3×.
4. Baru fase 5 (analytics/alert) — jangan dimulai sebelum fase 1–3 lulus release gate sesuai prinsip prioritas dokumen.
