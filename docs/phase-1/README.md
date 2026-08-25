# Fase 1 — Data Correctness dan Reliability

Status: **CONDITIONAL EXIT**  
Tanggal mulai: 24 Agustus 2026

Fase ini mengubah status koneksi menjadi kontrak kualitas data yang dapat
diaudit. Transport hidup tidak otomatis berarti book valid; analytics dan trend
hanya boleh aktif setelah snapshot serta seluruh delta buffered direkonsiliasi.

## Ruang lingkup

- raw capture yang opt-in, bounded, dan dapat di-flush;
- fingerprint state order book dan replay deterministik;
- counters anomaly, resync, queue, dan clock drift;
- atomic resync tanpa state parsial ke client;
- data-quality UX dan signal freeze;
- fault injection, burst test, serta soak harness;
- graceful shutdown.

## Dokumen dan tooling

- [Kontrak reliability](./reliability-contract.md)
- [Raw public-feed capture](./raw-capture.md)
- [Validation harness](../../scripts/phase1/README.md)
- [Baseline validasi](../baselines/phase-1-validation.md)
- [Exit report](./exit-report.md)

## Acceptance checklist

- [x] Tidak ada silent sequence gap.
- [x] Duplicate, out-of-order, malformed, crossed book, dan overflow terukur.
- [x] Client tidak menerima book parsial sebagai valid saat resync.
- [x] Resync berhasil tanpa reload browser.
- [x] Trend selalu inactive ketika data invalid/stale/syncing.
- [x] Replay input sama menghasilkan fingerprint serta signal sama.
- [x] Burst minimal tiga kali baseline tidak crash atau membuang raw fact diam-diam.
- [ ] Soak delapan jam tidak menunjukkan unbounded memory growth.
- [x] Shutdown menyelesaikan buffer/capture yang masih tertunda.

Checklist hanya ditandai lulus dengan bukti test atau benchmark. Accelerated
event-clock soak tidak menggantikan wall-clock soak delapan jam.
