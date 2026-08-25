# Target Non-Functional dan Katalog Metrik

Tanggal baseline: 24 Agustus 2026  
Status: target disetujui; hasil aktual dicatat di `docs/baselines/`

## 1. Target beta

| Area | SLI | Target/SLO |
|---|---|---:|
| Data correctness | Sequence gap yang tidak terdeteksi | 0 |
| Data correctness | Crossed book setelah event valid | 0 |
| Data correctness | Deterministic replay mismatch | 0 |
| Latency | Gateway receive-to-frame p95 | < 50 ms |
| Latency | Gateway receive-to-frame p99 | < 100 ms |
| Latency | Event-to-screen p95, RTT < 50 ms | < 150 ms |
| Rendering | FPS saat viewport aktif | >= 30 FPS p95 session; target 60 |
| Rendering | Long task > 50 ms | < 1 per menit pada beban normal |
| Recovery | WebSocket reconnect + valid book | < 10 detik p95 |
| Staleness | Waktu sampai UI menandai stale | <= 5 detik |
| Availability | Beta service availability | >= 99,5% per bulan |
| Browser | Crash-free session | >= 99% |
| Gateway | RSS, 3 simbol + 100 client | < 512 MB setelah soak 8 jam |
| Browser | Heap, satu simbol | < 350 MB setelah soak 8 jam |
| CPU | Gateway, beban normal | < 70% dari 4 vCPU p95 interval |
| Replay | Start replay satu jam | < 3 detik p95 |
| Replay | Seek ke snapshot terdekat | < 1 detik p95 |

Target hanya dinyatakan lulus jika perangkat, dataset, jumlah client, dan durasi test dicatat.

## 2. Data-quality metrics

| Nama metric | Tipe | Label minimum | Tujuan |
|---|---|---|---|
| `market_events_received_total` | counter | exchange, symbol, type | Event rate sumber |
| `market_events_rejected_total` | counter | exchange, symbol, reason | Malformed/invalid data |
| `orderbook_sequence_gap_total` | counter | exchange, symbol | Gap terdeteksi |
| `orderbook_duplicate_total` | counter | exchange, symbol | Duplicate event |
| `orderbook_out_of_order_total` | counter | exchange, symbol | Out-of-order event |
| `orderbook_resync_total` | counter | exchange, symbol, reason | Frekuensi recovery |
| `orderbook_resync_duration_ms` | histogram | exchange, symbol | Waktu book valid kembali |
| `orderbook_crossed_total` | counter | exchange, symbol | Invariant violation |
| `market_clock_drift_ms` | gauge/histogram | exchange, symbol | Drift exchange-server |
| `market_stale_duration_ms` | histogram | exchange, symbol | Durasi data tidak segar |

## 3. Performance metrics

| Nama metric | Tipe | Label minimum |
|---|---|---|
| `gateway_event_processing_ms` | histogram | symbol, type |
| `gateway_frame_build_ms` | histogram | symbol |
| `gateway_queue_depth` | gauge | symbol, queue |
| `gateway_dropped_frame_total` | counter | symbol, reason |
| `websocket_clients` | gauge | subscription |
| `websocket_buffered_bytes` | histogram | client tier |
| `websocket_frame_bytes` | histogram | type, symbol |
| `process_cpu_ratio` | gauge | service |
| `process_rss_bytes` | gauge | service |
| `browser_frame_duration_ms` | histogram | renderer, device class |
| `browser_long_task_total` | counter | route, device class |
| `event_to_screen_ms` | histogram | symbol, source, device class |

## 4. Product metrics

| Nama | Definisi |
|---|---|
| Active user | Pengguna membuka chart dan menerima frame valid >= 60 detik |
| Valid session | Session >= 2 menit tanpa fatal error |
| Replay usage | Replay dimulai dan memainkan >= 30 detik market time |
| Symbol engagement | Simbol terlihat aktif >= 60 detik |
| Alert action rate | Alert dibuka/diperiksa dalam 5 menit |
| Retention D7 | Pengguna valid kembali pada hari ke-7 ± 1 hari |
| Crash-free session | Session tanpa uncaught frontend/backend fatal error |

Analytics produk tidak boleh memuat raw order-book payload atau informasi akun trading.

## 5. Kapasitas test standar

Benchmark wajib melaporkan minimal tiga profil:

- **Normal:** 10 depth update/s, 20 trade/s, satu simbol, satu client.
- **Busy:** 10 depth update/s, 200 trade/s, tiga simbol, 25 client.
- **Burst:** 30 depth update/s, 1.000 trade/s ekuivalen, tiga simbol, 100 client selama 60 detik.

Jika benchmark belum mendukung multi-symbol atau multi-client, hasil diberi label `partial` dan tidak dipakai untuk menyatakan SLO beta lulus.

## 6. Metodologi latency

- `exchangeTimestamp`: waktu event dari exchange.
- `receivedTimestamp`: waktu byte/payload diterima gateway.
- `frameTimestamp`: waktu envelope selesai dibentuk.
- `clientReceivedTimestamp`: waktu browser menerima payload.
- `paintTimestamp`: animation frame pertama setelah data digambar.

Gateway processing memakai `frameTimestamp - receivedTimestamp`. Event-to-screen memakai `paintTimestamp - receivedTimestamp`; bukan `Date.now - exchangeTimestamp`, karena nilai terakhir mencampur clock drift dan latency jaringan exchange.
