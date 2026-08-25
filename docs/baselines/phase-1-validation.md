# Baseline Validasi Fase 1

Tanggal: 24 Agustus 2026  
Status: **CONDITIONAL EXIT**

## Hasil utama

| Gate | Hasil |
|---|---:|
| Typecheck | PASS |
| Test | 93/93 pada 21 file |
| Fault/replay cases | 8/8 |
| Raw gzip capture replay | PASS, 2 replay identik |
| Burst | 1.200 event/detik, 6.000 event, 0 depth rejection |
| Processing throughput burst | 44.711,10 event/detik |
| Quick wall-clock soak | PASS, 5,03 detik |
| Custom wall-clock diagnostic | PASS, 120,03 detik |
| Production build | PASS |
| Full wall-clock soak | **NOT RUN (8 jam)** |

Raw capture proof memakai file gzip NDJSON nyata, `captureSequence` kontinu, dan
production `OrderBook`. Dua replay menghasilkan golden SHA-256 book
`2e07027bc6fc75bfd4d7820ec3e9386dc5ce96f1398b2726ff5d78780cf377e2` pada
`lastUpdateId=104`.

Fault suite meliputi lost, duplicate, late/out-of-order, malformed, crossed
book, disconnect ketika snapshot pending, burst 3× baseline, dan repeatability
empat fixture market.

## Interpretasi memory

Quick-soak hanya smoke test. Diagnostik dua menit memproses 144.000 event pada
1.199,66 event/detik dengan GC exposed. Heap naik saat ring analytics 30.000
trade diisi, lalu terlihat mendatar sekitar 15,5–15,6 MiB setelah kapasitas
tercapai. Detector tidak menandai unbounded growth, tetapi hasil dua menit tetap
bukan pengganti soak delapan jam.

Data machine-readable ada di
[`phase-1-validation.json`](./phase-1-validation.json).

## Reproduksi

```bash
npm run phase1:verify
node --expose-gc --import tsx scripts/phase1/soak.ts --duration 2m
npm run phase1:soak:full
```

Perintah terakhir belum dijalankan pada baseline ini dan membutuhkan delapan
jam wall clock nyata.
