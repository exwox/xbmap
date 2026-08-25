# Phase 0 — Baseline dan Keputusan Produk

Status: **CONDITIONAL EXIT**  
Tanggal pelaksanaan: 24 Agustus 2026

Dokumen ini menjadi pintu masuk semua keluaran Fase 0 pada `development-plan.md`.

## Keluaran

- [Keputusan produk dan parameter pasar](./product-decisions.md)
- [Target non-functional dan katalog metrik](./quality-targets.md)
- [Definisi evaluasi trend signal](./trend-evaluation.md)
- [Review penggunaan data Binance](./exchange-data-review.md)
- [Percobaan pengukuran live Binance](./live-measurement.md)
- [Backlog prioritas](./backlog.md)
- [Kontrak event schema v1](../architecture/event-schema-v1.md)
- [Architecture Decision Records](../adr/README.md)
- [Dataset regression](../../fixtures/market/README.md)
- [Baseline backend sintetis](../baselines/phase-0-synthetic-benchmark.md)
- [Baseline renderer browser](../baselines/phase-0-browser-renderer.md)
- [Laporan keluar fase](./exit-report.md)

## Exit checklist

- [x] Pengguna pertama dan batas produk ditetapkan.
- [x] Simbol beta ditetapkan.
- [x] Perangkat minimum ditetapkan.
- [x] Tick, price bucket, time bucket, dan retensi default ditetapkan.
- [x] Outcome trend signal didefinisikan secara objektif.
- [x] Backlog P0/P1/P2 dibuat.
- [x] Review awal API, ToS, penyimpanan, dan redistribusi dilakukan.
- [x] Schema event versi 1 selesai diaudit.
- [x] ADR database, event bus, renderer, dan versioning disetujui.
- [x] Empat dataset regression dan checksum tersedia.
- [x] Baseline CPU, memori, bandwidth, throughput, dan latency sintetis tersedia.
- [x] Pengukuran FPS browser pada host referensi tersedia.
- [ ] Event-rate live di environment produksi tersedia.

Pengukuran live telah dicoba, tetapi egress environment menolak koneksi sehingga
angka nol tidak dipakai sebagai baseline. Checklist yang belum selesai tidak
ditandai lulus menggunakan hasil sintetis. Detail keputusan, kegagalan gate
renderer, dan pekerjaan eksternal ada di [laporan keluar fase](./exit-report.md).
