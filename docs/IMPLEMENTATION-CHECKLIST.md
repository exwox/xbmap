# Checklist Implementasi — LiquidMap vs development-plan.md

Terakhir diperbarui: 25 Agustus 2026 (setelah pelaksanaan Fase 4).
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
- [ ] **GATE:** Soak test 8 jam penuh — 🟡 eksekusi berjalan sejak 25 Agu (background, feed demo); bukti & status: `docs/gates/external-gates.md`
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

## Fase 4 — Multi-Symbol Beta (`CONDITIONAL EXIT`)

- [x] Market-session manager (`server/marketSessionManager.ts`: refcount, eviction TTL, capacity, `drain()`)
- [x] Metadata instrument + tick-size registry (`server/instruments.ts`: BTC/ETH/SOL; discovery dinamis disiapkan via seam)
- [x] Dukungan **BTCUSDT, ETHUSDT, SOLUSDT** (gateway lazily per simbol + `scopedHooks` metrik per-simbol)
- [x] Batas subscription per client (`XBMAP_MAX_SUBSCRIPTIONS_PER_CLIENT`, default 3; error wire `SUBSCRIPTION_LIMIT`/`SESSION_CAPACITY`)
- [x] Watchlist (`localStorage liquidmap.watchlist`, panel SymbolPicker)
- [x] Pencarian simbol (input filter di picker)
- [x] Buffer terpisah per simbol (gateway independen: book, aggregator, ring buffer, history `<root>/<symbol>/`)
- [x] Cache snapshot + lifecycle subscription (snapshot rekonsiliasi dikirim pada setiap subscribe; eviction TTL + flush saat idle)
- [x] Test isolasi antarsimbol (`server/__tests__/multiSymbol.test.ts`, 5 test; `useMarketData` switch test)
- [x] Pengukuran biaya CPU/memori per simbol (`scripts/phase4/run.ts` → `docs/baselines/phase-4-validation.{json,md}`)
- [x] Perpindahan simbol tanpa reload browser (picker → setSelection → resubscribe WS + clear buffer)
- [x] REST multi-simbol: `/api/v1/markets`, `?symbol=` pada snapshot/history/settings, readiness agregat
- [ ] **GATE:** Validasi performa 3 simbol live (jaringan Binance stabil) & FPS perangkat fisik minimum
- [ ] **GATE:** Replay multi-simbol di UI (raw replay runtime masih satu simbol per katalog)

Detail pelaksanaan: [`phase-4/exit-report.md`](./phase-4/exit-report.md).


## Fase 5 — Analytics Lanjutan dan Alert (`CONDITIONAL EXIT`)

### Analytics
- [x] Liquidity wall + persistence (`insightEngine.ts`: confirm ≥1,5s, transisi appeared/disappeared)
- [x] Added/pulled liquidity (diffing book penuh antar-frame, jendela 10 detik)
- [x] Absorption (flow berat 5s + mid ≤3 tick; arah dari delta dominan)
- [x] Exhaustion (tren aktif kehilangan ≥30% trade rate)
- [x] Rolling VWAP (jendela 60 detik)
- [x] Volume profile + POC (jendela 5 menit, top-12 node)
- [x] Footprint sederhana (buy/sell per level, ≤24 baris terbaru)
- [x] Funding rate + open interest (`binanceDerivatives.ts`, poller fetch injektif, stale-aware)
- [x] Liquidation feed live **opt-in** (`XBMAP_LIQUIDATIONS=1`): stream `!forceOrder@arr` (`binanceLiquidations.ts`, socket injektif) → agregat long/short 60 detik per simbol; gate lisensi/ToS tetap sebelum diaktifkan di produksi

### Alert
- [x] Aturan user-configurable: trend score / liquidity wall muncul-hilang / volume delta / trade velocity (CRUD REST + UI drawer)
- [x] Cooldown + deduplication (per rule×simbol, audit suppressed_cooldown)
- [x] Browser notification + suara (WebAudio beep, toggle localStorage, badge bell)
- [x] Webhook + Telegram (opsional via env, fetch injektif, audit delivered/delivery_failed)
- [x] Audit log dibuat/dipicu/dikirim (`/api/v1/alerts/events`, bounded 500)

### Evaluasi sinyal
- [x] Horizon 10s/30s/1m/5m (`SIGNAL_HORIZONS_MS`)
- [x] Precision + favorable/adverse excursion (MFE/MAE) per horizon
- [x] Segmentasi simbol / jam UTC / bucket volatilitas
- [x] Versioning algoritma pada setiap sinyal (`alerts-v1`)
- [x] Mode shadow (`XBMAP_ALERT_SHADOW=1`)
- [x] Threshold baseline per simbol (median berjalan ×multiplier, min 30 sampel)

### Verifikasi
- [x] Test: `marketInsights.test.ts` (7), `alertEngine.test.ts` (5), `phase5Surface.test.ts` (3) — WS insight/alert end-to-end + CRUD
- [x] `npm run phase5:validate` → 3/3 PASS (determinism, cooldown/shadow, horizons) → `docs/baselines/phase-5-validation.{json,md}`
- [ ] **GATE:** Kalibrasi multiplier baseline dengan data Binance live (jalankan shadow mode dulu di produksi)
- [~] **GATE:** Uji delivery webhook/Telegram dengan penyedia nyata — jalur webhook terbukti e2e via mock receiver (bukti: `docs/baselines/webhook-delivery-e2e.md`); sisa: provider eksternal nyata + jaringan bersih

Detail pelaksanaan: [`phase-5/exit-report.md`](./phase-5/exit-report.md).

## Fase 6 — Product Beta (BELUM DIMULAI)

### Fitur produk
- [~] Autentikasi + session management — **fondasi selesai** (`server/auth/authService.ts`: bootstrap admin scrypt, sesi cookie httpOnly sliding, lockout; enforcement opt-in `XBMAP_REQUIRE_AUTH=1` mencakup REST + WS upgrade; gate UI `LoginGate`) · multi-user & manajemen akun menyusul
- [x] **Multi-pengguna persisten** (`XBMAP_USERS_FILE`, `server/auth/userStore.ts`: role admin/viewer, disable, ganti password) + REST admin `/api/v1/admin/users*`
- [x] **Workspace per pengguna** (watchlist + pengaturan visual; GET/PUT `/api/v1/workspace`, sinkron debounce di UI)
- [x] **Feature flag sederhana** (`/api/v1/feature-flags` GET authed / PATCH admin; contoh konsumsi: sembunyikan panel alert)
- [x] **Threat modeling** (`docs/security/threat-model.md`, STRIDE per permukaan)
- [ ] Workspace tersimpan
- [ ] Watchlist pengguna persisten
- [ ] Penyimpanan layout/threshold/warna/alert
- [ ] Onboarding interaktif
- [ ] Shortcut + command palette
- [ ] Ekspor screenshot & CSV
- [ ] Halaman status sistem + release notes

### Keamanan
- [x] Threat modeling (`docs/security/threat-model.md`, STRIDE per permukaan)
- [ ] Rate limit berbasis pengguna (per-IP sudah ada)
- [x] CSP header produksi (`script-src 'self'` tanpa inline; `frame-ancestors 'none'`; ws/wss untuk live data)
- [ ] Dependency & container scanning
- [ ] Secret manager
- [ ] Audit log perubahan konfigurasi
- [ ] Backup terenkripsi
- [ ] Retensi data & penghapusan akun

### Operasional beta
- [ ] Kelompok 10–30 pengguna pertama
- [~] Feature flag (infrastruktur tersedia sejak Fase 6: `/api/v1/feature-flags` + konsumsi `alerts_panel` di UI; ekspansi flag lain mengikuti kebutuhan)
- [ ] Feedback form in-app
- [ ] Runbook disconnect/corruption/database failure
- [ ] Rollback satu perintah
- [ ] Jadwal on-call + klasifikasi severity

## Utang Teknis Teridentifikasi (di luar rencana fase)

- [x] Repo git rusak → diperbaiki (commit awal `ae011bd`)
- [x] Handler `unhandledRejection` → ditambahkan di `server/index.ts`
- [x] Proteksi `/metrics` & `/api/v1/observability/*` via `XBMAP_ADMIN_TOKEN` (`x-admin-token`/Bearer; port terpisah ditunda hingga kebutuhan deployment nyata)
- [x] Artefak baseline validasi fase 2/3 di `docs/baselines/phase-{2,3}-validation.{json,md}` (dihasilkan `phase2:validate` / `phase3:validate`)
- [x] Link mati `docs/baselines/phase-2-validation.md` di exit-report fase 2 (artefak dibuat, link valid)
- [x] CI pipeline (`.github/workflows/ci.yml`: typecheck + unit tests + validasi offline fase 4/5 pada Node 22 & 24, plus job build produksi dengan artifact `dist/`)

---

## Urutan Pengerjaan yang Disarankan

1. Tutup gate fase 3 (load test multi-client, soak 24 jam, Grafana) — prasyarat sebelum multi-symbol.
2. ~~Kerjakan fase 4 (market-session manager → 3 simbol → watchlist).~~ **Selesai 25 Agustus 2026** dengan `CONDITIONAL EXIT`; gate performa live/perangkat fisik tetap terbuka.
3. Paralel: aktifkan adapter Postgres/ClickHouse runtime (gate fase 2) karena fase 4 menaikkan volume data 3×.
4. Baru fase 5 (analytics/alert) — jangan dimulai sebelum fase 1–3 lulus release gate sesuai prinsip prioritas dokumen.
