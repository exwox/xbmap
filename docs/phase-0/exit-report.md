# Laporan Keluar Fase 0

Tanggal: 24 Agustus 2026  
Keputusan: **CONDITIONAL EXIT**  
Owner: Product + Engineering

## Ringkasan keputusan

Fase 0 telah dijalankan untuk seluruh pekerjaan yang dapat dieksekusi di
workspace ini. Tim dapat memulai Fase 1 untuk pekerjaan correctness, recovery,
observability, dan optimasi internal. Keputusan ini bukan izin beta eksternal.

Tiga gate belum boleh dianggap lulus:

1. event-rate Binance pada periode normal dan volatil belum dapat diukur karena
   koneksi keluar environment ditolak;
2. renderer gagal target pada host referensi dan belum diuji ulang pada
   perangkat fisik minimum dengan GPU browser normal;
3. penyimpanan serta redistribusi data belum memperoleh legal clearance yang
   berlaku bagi operator LiquidMap.

## Keluaran yang selesai

| Area | Artefak | Status |
|---|---|---|
| Pengguna, simbol, perangkat, bucket, retention | [Keputusan produk](./product-decisions.md) | Selesai |
| NFR dan katalog metric | [Quality targets](./quality-targets.md) | Selesai |
| Outcome trend objektif | [Trend evaluation](./trend-evaluation.md) | Selesai |
| Schema wire/internal v1 | [Event Schema v1](../architecture/event-schema-v1.md) | Selesai; 18 gap dicatat |
| Database, event bus, renderer, versioning, correctness | [ADR 0001–0005](../adr/README.md) | Accepted |
| Calm, strong trend, volatile, reconnect/gap | [Regression fixtures](../../fixtures/market/README.md) | 4/4 deterministik |
| CPU, memori, throughput, latency, bandwidth | [Synthetic baseline](../baselines/phase-0-synthetic-benchmark.md) | Terukur pada host referensi |
| FPS, draw, long task, input-to-paint, heap | [Browser baseline](../baselines/phase-0-browser-renderer.md) | Terukur; FPS/draw gagal target |
| Event-rate live | [Live measurement](./live-measurement.md) | Dicoba; `BLOCKED_NETWORK` |
| API/ToS/retention/redistribution | [Exchange data review](./exchange-data-review.md) | Ditinjau; `BLOCK_EXTERNAL_BETA` |
| Prioritas sprint | [Backlog P0/P1/P2](./backlog.md) | Selesai |

## Baseline terukur

### Backend dan jalur wire sintetis

Profil offline memakai tiga putaran, seed `1480744257`, satu proses, dan input
sintetis deterministik. Angka ini adalah saturation/regression baseline pada
host yang tercatat, bukan kapasitas produksi atau event-rate Binance.

| Scenario | Throughput | Latency p95 |
|---|---:|---:|
| Apply order-book delta 8 level | 147.964,67 update/s | 12,18 µs |
| Analytics dengan ring 30.000 trade | 123,65 frame/s | 11,34 ms |
| Gateway cycle + serialisasi satu client depth-80 | 634,70 cycle/s | 1,97 ms |
| Client metadata parse + normalisasi | 11.013,66 frame/s | 159,74 µs |

Model satu client depth-80 menghasilkan estimasi 56,98 KiB/s atau 0,4668
Mbit/s WebSocket. Estimasi tidak memasukkan TCP/IP, TLS, proxy, retransmission,
atau CPU fanout socket aktual.

### Renderer browser

Chrome headless menguji production React/Canvas dengan 1.800 depth frame × 80
level/sisi, 937 bubble, 1.800 price point, viewport 1366×681, DPR 1, dan redraw
10 Hz selama 12,05 detik.

| Metric | Hasil | Target referensi | Status |
|---|---:|---:|---|
| Animation frame rate | 17,01 FPS | >= 30 FPS | **FAIL** |
| Market-layer draw p95 | 50,46 ms | < 25 ms | **FAIL** |
| Local input-to-paint p95 | 70,30 ms | < 150 ms | PASS lokal |
| Long task > 50 ms | 115 / 12,05 s | < 1/menit normal | **FAIL** |
| JS heap delta singkat | +4,81 MiB | soak diperlukan | Informasi |
| Runtime error | 0 | 0 | PASS |

Host memakai Intel i7-7500U empat logical CPU, RAM host sekitar 7,2 GiB, dan
SwiftShader pada Chrome headless. Host ini lebih tua dari target perangkat dan
tidak memakai GPU browser fisik, sehingga hasilnya tidak membuktikan kegagalan
perangkat minimum. Namun hasil tersebut cukup untuk memicu profiling, viewport
pre-bucketing/culling, pengurangan allocation, dan evaluasi Worker/WebGL sesuai
[ADR renderer](../adr/0004-rendering-performance-strategy.md).

## Dataset regression

Empat scenario sintetis memiliki NDJSON, manifest, SHA-256, capture ordinal,
final book fingerprint, expected sequence outcome, checkpoint analytics/trend,
dan recovery outcome:

- `calm`;
- `strong-uptrend`;
- `high-volatility`;
- `reconnect-sequence-gap`.

Generator `--check` dan 43 test lulus. Fixture tidak berasal dari market live,
sehingga aman disimpan di repository tetapi tidak menggantikan capture real
untuk evaluasi representativeness.

## Temuan P0 utama

1. Envelope `sequence` bersifat global proses, sedangkan frontend memperlakukannya
   seperti delivery sequence per client; ini dapat memicu resync palsu.
2. Saat resync, book lama masih dapat diframe dan snapshot dapat terlihat client
   sebelum buffered delta selesai; wire recovery belum atomik.
3. Runtime belum memvalidasi penuh `schemaVersion` dan payload event.
4. Replay REST sekarang hanya derived history satu detik, bukan raw depth/trade
   yang dapat merekonstruksi book.
5. Adapter live masih perlu migrasi dan pengujian routed WebSocket path resmi
   (`DATA-007`).
6. Renderer memindai buffer/cell terlalu luas dan membuat array React baru pada
   setiap event; baseline referensi mengonfirmasi biaya ini material.
7. Izin retensi dan redistribusi data belum jelas; external/paid beta tetap
   diblokir.

## Penilaian exit criteria

| Kriteria `development-plan.md` | Penilaian | Bukti |
|---|---|---|
| Semua target non-functional memiliki angka | PASS | [Quality targets](./quality-targets.md) |
| Dataset tenang, tren, volatil, reconnect tersedia | PASS | [Fixture index](../../fixtures/market/index.json) |
| Keputusan kritis tidak bergantung pada asumsi tidak tertulis | PASS | ADR, schema gap, legal gate, dan caveat benchmark terdokumentasi |
| Baseline live normal/volatil tersedia | PENDING EXTERNAL | Koneksi environment ditolak |
| Renderer memenuhi gate beta | FAIL PADA HOST REFERENSI | 17,01 FPS dan draw p95 50,46 ms |

Karena dua baris terakhir, status tidak dinaikkan menjadi unconditional pass.

## Tindakan wajib berikutnya

1. Kerjakan `DATA-002`, `DATA-003`, `DATA-004`, dan mismatch sequence sebagai
   urutan awal Fase 1.
2. Kerjakan `DATA-007` dan contract test endpoint sebelum mengulang live test.
3. Profile renderer; mulai dari culling/pre-bucketing dan menghindari full-array
   copy. Ulangi baseline yang sama setelah setiap perubahan.
4. Jalankan pengukuran live 30 menit per simbol pada kondisi normal dan minimal
   15 menit kondisi volatil dari staging dengan egress yang diizinkan.
5. Ulangi benchmark browser pada perangkat fisik minimum dengan Chrome/Firefox
   visible dan hardware acceleration, lalu lakukan soak delapan jam.
6. Selesaikan `LEGAL-001` sebelum raw capture lebih dari 24 jam atau beta
   eksternal.

## Perintah reproduksi

```bash
npm run phase0:verify
npm run phase0:bench
npm run phase0:renderer
npm run measure:live -- --duration 1800 --symbol BTCUSDT
```

`phase0:renderer` membutuhkan Chrome/Chromium dan izin membuka server loopback.
Perintah live tidak menyimpan payload raw; hasil agregat tetap harus ditinjau
terhadap ketentuan yang berlaku.
