# LiquidMap

LiquidMap adalah MVP terminal order-flow real-time ala Bookmap untuk pasar perpetual Binance USD-M. Aplikasi menampilkan histori likuiditas sebagai heatmap, transaksi agresif sebagai bubble, price path, volume delta, CVD, order-book imbalance, trade velocity, serta skor tren yang dapat dijelaskan.

> Aplikasi ini adalah alat bantu analisis dan bukan nasihat keuangan. MVP bersifat read-only dan tidak menerima API key atau mengeksekusi order.

## Fitur yang sudah tersedia

- Multi-simbol beta: BTCUSDT, ETHUSDT, dan SOLUSDT perpetual berjalan bersamaan dengan sesi terisolasi per simbol.
- Symbol picker dengan pencarian dan watchlist persisten; pergantian simbol tanpa reload browser.
- Market-session manager: sesi dibuat saat dibutuhkan dan dihentikan otomatis (TTL idle) agar tidak ada feed menggantung tanpa penonton.
- Analytics lanjutan per simbol: rolling VWAP, liquidity wall + persistensi, added/pulled liquidity, absorption, exhaustion, volume profile dengan POC, footprint buy/sell, funding rate & open interest, agregat likuidasi.
- Alert user-configurable (trend score, wall muncul/hilang, volume delta, trade velocity) dengan cooldown, baseline threshold per simbol, mode shadow, audit log, notifikasi browser + suara, serta webhook/Telegram opsional.
- Sinkronisasi snapshot + incremental depth Binance USD-M Futures.
- Validasi sequence `U/u/pu`, counter anomaly, fingerprint book, dan resync atomik.
- Reconnect WebSocket dengan exponential backoff.
- Status eksplisit transport/book validity, clock drift, dan signal freeze.
- Raw public-feed capture terkompresi yang opt-in, bounded, dan di-flush saat shutdown.
- Histori trade/depth/metric terkompresi yang tahan restart, dengan batch bounded.
- Rollup metric 1 detik, 5 detik, dan 1 menit yang idempotent setelah restart.
- Replay raw ber-checksum dengan session pause/resume/seek/speed dan checkpoint persisten.
- Retention, backup/restore terverifikasi, serta batas query per request.
- Fallback otomatis ke feed demo sintetis jika Binance tidak tersedia.
- Canvas heatmap berperforma tinggi dengan pan, zoom, crosshair, dan tooltip.
- Bubble aggressor buy/sell yang diskalakan terhadap volume relatif.
- Delta, CVD, buy/sell ratio, imbalance, trade rate, dan volume baseline.
- Trend score 0-100 dengan hysteresis, confidence, arah, dan alasan sinyal.
- Indikator data stale yang menghentikan interpretasi live secara visual.
- Replay lokal deterministik dan API replay berbasis histori gateway.
- Pengaturan depth, rentang waktu, threshold heatmap, dan ukuran bubble.
- Layout desktop responsif serta navigasi chart dengan keyboard.

## Menjalankan aplikasi

Persyaratan: Node.js 22 atau lebih baru dan npm.

```bash
npm install
npm run dev
```

Buka `http://localhost:5173`. Perintah tersebut menjalankan Vite dan gateway secara bersamaan. Frontend development meneruskan `/api` dan `/ws` ke `http://localhost:8787`.

Untuk memaksa mode demo tanpa mengakses Binance:

```bash
XBMAP_DEMO=1 npm run dev
```

Mode yang dapat dipilih dari bagian atas aplikasi:

- `LIVE`: data gateway; mencoba Binance lalu fallback ke simulator.
- `DEMO`: simulator browser lokal sehingga tetap bekerja tanpa gateway exchange.
- `REPLAY`: rekaman deterministik empat menit dengan play, pause, seek, dan speed.

## Build produksi

```bash
npm run build
npm start
```

Buka `http://localhost:8787`. Gateway akan menyajikan hasil build Vite dari direktori `dist/` dan WebSocket dari origin yang sama.

## Docker

```bash
docker compose up --build
```

Aplikasi tersedia di `http://localhost:8787`. Untuk selalu memakai simulator:

```bash
XBMAP_DEMO=1 docker compose up --build
```

Compose memasang volume history dan backup untuk aplikasi. Topologi produksi
PostgreSQL, ClickHouse, dan object storage tersedia sebagai profile terpisah:

```bash
docker compose --profile storage up -d
```

Ganti seluruh password contoh sebelum service storage diekspos. Gateway saat ini
memakai adapter file persisten untuk development/default Compose; SQL migration
produksi tersedia di [`migrations/`](./migrations/).

## Pengujian

```bash
npm run typecheck
npm test
npm run build
```

Test mencakup order-book reconciliation, analytics/trend hysteresis, trade aggregation, ring buffer, normalisasi event, sequence-gap recovery, stale detection, reconnect, replay, formatter, dan matematika renderer.

Artefak dan verifikasi Fase 0:

```bash
npm run phase0:verify
npm run phase0:bench:quick
npm run phase0:renderer
```

Benchmark renderer memerlukan Chrome/Chromium dan menjalankan server loopback.
Baseline, keputusan produk, ADR, schema, fixture, serta exit report tersedia di
[`docs/phase-0/`](./docs/phase-0/README.md).

Verifikasi reliability Fase 1:

```bash
npm run phase1:verify
npm run phase1:soak:full
```

`phase1:verify` menjalankan typecheck, seluruh unit/integration test, replay,
fault injection, burst 3× baseline, quick-soak, dan build. Soak penuh delapan
jam sengaja menjadi perintah terpisah agar quick-soak tidak keliru dianggap
sebagai release gate. Detail ada di [`docs/phase-1/`](./docs/phase-1/README.md).

Verifikasi storage dan replay Fase 2:

```bash
npm run phase2:verify
```

Perintah ini mencakup restart persistence, query bounds, backup/restore,
retention bersamaan dengan ingestion, replay checksum, lifecycle session, dan
startup replay sintetis satu jam. Detail ada di
[`docs/phase-2/`](./docs/phase-2/README.md).

## Interaksi chart

- Gerakkan pointer untuk crosshair dan tooltip.
- Drag untuk pan waktu dan harga.
- Scroll untuk zoom waktu.
- `Alt` + scroll untuk zoom harga.
- `Shift` + scroll untuk pan.
- Double-click atau `Home` untuk kembali mengikuti data terbaru.
- Tombol panah memindahkan crosshair; `+`/`-` mengubah zoom.

## API gateway

REST:

- `GET /api/v1/health`
- `GET /api/v1/markets`
- `GET /api/v1/snapshot?exchange=binance&symbol=BTCUSDT&depth=80`
- `GET /api/v1/history?from=&to=&resolution=1s`
- `GET /api/v1/settings`
- `PUT /api/v1/settings`
- `POST /api/v1/replay/session`
- `GET /api/v1/replay/session/:id`
- `GET /api/v1/replay/raw/captures`
- `POST /api/v1/replay/raw/captures/:id/verify`
- `POST /api/v1/replay/raw/session`
- `GET/PATCH/DELETE /api/v1/replay/raw/session/:id`
- `GET /api/v1/replay/raw/session/:id/frames`

Endpoint raw replay hanya aktif jika `XBMAP_CAPTURE_DIR` dikonfigurasi. Response
frame API tidak membuka payload raw; ia hanya mengirim ordinal, stream, waktu,
dan checksum untuk menjaga batas data serta auditability.

WebSocket tersedia pada `/ws`. Pesan subscribe minimum:

```json
{
  "type": "subscribe",
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "depth": 80
}
```

Gateway mengirim event versioned `snapshot`, `depth_frame`, `trade_bucket`, `price`, `metric`, `trend_signal`, `status`, `heartbeat`, `insight` (analytics lanjutan 1×/detik), dan `alert`. Setiap event membawa field `symbol`; koneksi hanya menerima frame dari simbol yang disubscribe. Simbol yang didukung saat ini: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`.

Contoh REST per simbol: `GET /api/v1/markets` (registry instrumen + status sesi), `GET /api/v1/snapshot?symbol=ETHUSDT` (409 `SYMBOL_NOT_ACTIVE` bila belum ada klien yang subscribe). Permukaan alert: `GET|POST /api/v1/alerts/rules`, `PATCH|DELETE /api/v1/alerts/rules/:id`, `GET /api/v1/alerts/events` (audit), `GET /api/v1/signals/performance` (precision/excursion per horizon 10s–5m), dan `GET /api/v1/insights?symbol=`.

## Konfigurasi

| Variabel | Default | Keterangan |
|---|---:|---|
| `PORT` | `8787` | Port gateway dan frontend produksi |
| `HOST` | `0.0.0.0` | Alamat bind server |
| `XBMAP_DEMO` | `0` | Paksa simulator jika bernilai `1` |
| `CORS_ORIGIN` | kosong | Daftar origin yang diizinkan, dipisahkan koma |
| `NODE_ENV` | kosong | Gunakan `production` untuk cache static asset |
| `XBMAP_MAX_SESSIONS` | `8` | Batas sesi pasar simultan |
| `XBMAP_SESSION_IDLE_TTL_MS` | `300000` | Usia idle sebelum sesi tanpa klien dihentikan |
| `XBMAP_MAX_SUBSCRIPTIONS_PER_CLIENT` | `3` | Batas simbol yang bisa disubscribe satu koneksi WS |
| `XBMAP_ALERT_RULES_FILE` | kosong | File JSON aturan alert (persisten antar restart) |
| `XBMAP_ALERT_SHADOW` | `0` | `1` = evaluasi alert tanpa mengirim notifikasi |
| `XBMAP_ALERT_WEBHOOK_URL` | kosong | Endpoint POST untuk alert terpicu |
| `XBMAP_TELEGRAM_BOT_TOKEN` | kosong | Token bot Telegram (bersama chat id) |
| `XBMAP_TELEGRAM_CHAT_ID` | kosong | Chat tujuan pengiriman alert |
| `XBMAP_DERIVATIVES_POLL_MS` | `30000` | Interval polling funding/open interest |
| `XBMAP_LIQUIDATIONS` | `0` | `1` = aktifkan feed likuidasi (review lisensi dulu) |
| `XBMAP_CAPTURE_DIR` | kosong/nonaktif | Direktori privat untuk raw public-feed capture gzip |
| `XBMAP_CAPTURE_QUEUE_RECORDS` | `8192` | Batas jumlah record yang menunggu ditulis |
| `XBMAP_CAPTURE_QUEUE_BYTES` | `16777216` | Batas byte antrean recorder |
| `XBMAP_CAPTURE_MAX_BYTES` | `536870912` | Batas raw byte per sesi capture |
| `XBMAP_CAPTURE_MAX_DURATION_MS` | `86400000` | Durasi maksimum satu sesi capture (maks. 24 jam) |
| `XBMAP_CAPTURE_RETENTION_MS` | `86400000` | Retensi capture lokal (maks. 24 jam) |
| `XBMAP_HISTORY_DIR` | kosong/nonaktif | Direktori projection history persisten (subdirektori per simbol); Compose mengaktifkannya |
| `XBMAP_HISTORY_QUEUE_RECORDS` | `20000` | Batas record antrean persistence non-blocking |
| `XBMAP_HISTORY_QUERY_MAX_POINTS` | `10000` | Batas point satu response history/replay |
| `XBMAP_HISTORY_QUERY_MAX_RANGE_MS` | `86400000` | Batas rentang satu query |
| `XBMAP_HISTORY_BACKUP_DIR` | kosong/nonaktif | Direktori backup otomatis terverifikasi |
| `XBMAP_HISTORY_BACKUP_INTERVAL_MS` | `86400000` | Cadence backup otomatis |
| `XBMAP_HISTORY_BACKUP_KEEP` | `7` | Jumlah backup otomatis yang dipertahankan |
| `XBMAP_REPLAY_MAX_PAGE_FRAMES` | `5000` | Batas frame per page raw replay |

Lihat [.env.example](./.env.example) untuk contoh. Jangan menaruh credential trading di proyek ini; gateway hanya memakai endpoint market-data publik.

Raw capture dinonaktifkan secara default. Contoh pengembangan lokal:

```bash
XBMAP_CAPTURE_DIR=.liquidmap-captures npm run dev:server
```

Capture dapat berisi data pasar berlisensi. Simpan di volume privat, jangan
commit ke repository, dan pastikan hak penyimpanan/redistribusi sebelum dipakai
di luar pengujian internal.

## Arsitektur

```text
Binance REST/WebSocket ─┐
                       ├─> Market Gateway ─> Order Book ─┐
Synthetic Demo Feed ───┘                                 ├─> Analytics ─> /ws ─> React
                                      Trade Aggregator ──┘                ├─ Heatmap
                                                                         ├─ Bubbles
Durable History ─> History / Replay API <─────────────────────────────────└─ Panels
       │
       ├─ gzip segments + checksum + 1s/5s/1m rollup
       └─ retention + verified backup
```

Dokumen rancangan produk berada di [plan.md](./plan.md). Roadmap implementasi setelah MVP, prioritas sprint, dan release gate tersedia di [development-plan.md](./development-plan.md).

## Batasan MVP

- Multi-simbol beta mencakup tiga simbol perpetual (BTCUSDT, ETHUSDT, SOLUSDT);
  penambahan simbol baru memerlukan entri registry instrumen.
- Validasi performa tiga stream live pada jaringan Binance produksi dan uji FPS
  perangkat fisik minimum masih menjadi gate terbuka Fase 4
  ([laporan exit](./docs/phase-4/exit-report.md)).
- Raw replay masih satu simbol per katalog; pemilihan dataset historis
  multi-simbol di UI belum tersedia.
- Gateway hanya memakai adapter file persisten untuk development/default Compose;
  adapter runtime ClickHouse/PostgreSQL produksi dapat diaktifkan via env.
- Sinyal menggunakan aturan yang dapat dijelaskan, bukan prediksi profit.
- Eksekusi order, akun pengguna, dan penyimpanan API key belum tersedia.
