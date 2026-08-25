# LiquidMap

LiquidMap adalah MVP terminal order-flow real-time ala Bookmap untuk BTCUSDT perpetual. Aplikasi menampilkan histori likuiditas sebagai heatmap, transaksi agresif sebagai bubble, price path, volume delta, CVD, order-book imbalance, trade velocity, serta skor tren yang dapat dijelaskan.

> Aplikasi ini adalah alat bantu analisis dan bukan nasihat keuangan. MVP bersifat read-only dan tidak menerima API key atau mengeksekusi order.

## Fitur yang sudah tersedia

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

Gateway mengirim event versioned `snapshot`, `depth_frame`, `trade_bucket`, `price`, `metric`, `trend_signal`, `status`, dan `heartbeat`.

## Konfigurasi

| Variabel | Default | Keterangan |
|---|---:|---|
| `PORT` | `8787` | Port gateway dan frontend produksi |
| `HOST` | `0.0.0.0` | Alamat bind server |
| `XBMAP_DEMO` | `0` | Paksa simulator jika bernilai `1` |
| `CORS_ORIGIN` | kosong | Daftar origin yang diizinkan, dipisahkan koma |
| `NODE_ENV` | kosong | Gunakan `production` untuk cache static asset |
| `XBMAP_CAPTURE_DIR` | kosong/nonaktif | Direktori privat untuk raw public-feed capture gzip |
| `XBMAP_CAPTURE_QUEUE_RECORDS` | `8192` | Batas jumlah record yang menunggu ditulis |
| `XBMAP_CAPTURE_QUEUE_BYTES` | `16777216` | Batas byte antrean recorder |
| `XBMAP_CAPTURE_MAX_BYTES` | `536870912` | Batas raw byte per sesi capture |
| `XBMAP_CAPTURE_MAX_DURATION_MS` | `86400000` | Durasi maksimum satu sesi capture (maks. 24 jam) |
| `XBMAP_CAPTURE_RETENTION_MS` | `86400000` | Retensi capture lokal (maks. 24 jam) |
| `XBMAP_HISTORY_DIR` | kosong/nonaktif | Direktori projection history persisten; Compose mengaktifkannya |
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

- Hanya BTCUSDT perpetual yang didukung gateway produksi saat ini.
- Gateway hanya memakai adapter file persisten; adapter runtime ClickHouse/PostgreSQL
  produksi belum diaktifkan walaupun schema migration dan Compose profile tersedia.
- Tombol Replay UI masih memakai dataset lokal lengkap untuk demonstrasi heatmap;
  raw replay persisten tersedia melalui REST API audit dan belum menjadi pemilih
  dataset historis di UI.
- Sinyal menggunakan aturan yang dapat dijelaskan, bukan prediksi profit.
- Eksekusi order, akun pengguna, dan penyimpanan API key belum tersedia.
