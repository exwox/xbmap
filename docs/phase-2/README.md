# Fase 2 — Penyimpanan Historis dan Replay

Status engineering workspace pada 25 Agustus 2026: **CONDITIONAL EXIT**.

Fase ini menambahkan jalur histori persisten, rollup multi-resolusi, backup dan
retention, katalog raw capture, serta replay session yang tahan restart. Seluruh
acceptance test lokal lulus. Status masih conditional karena adapter runtime
PostgreSQL/ClickHouse/object storage dan replay heatmap penuh di UI belum menjadi
jalur default produksi.

## Artefak

- [Storage runtime](./storage-runtime.md)
- [Kontrak replay](./replay-contract.md)
- [Exit report](./exit-report.md)
- [Baseline validasi](../baselines/phase-2-validation.md)
- [Migrasi storage](../../migrations/README.md)
- [Harness acceptance](../../scripts/phase2/README.md)

## Verifikasi

```bash
npm run phase2:verify
```

Perintah tersebut menjalankan typecheck aplikasi dan harness, seluruh test,
tujuh acceptance case storage/replay, lalu build frontend produksi. Dataset
acceptance dibangkitkan secara deterministik dan tidak memuat data exchange
live.

Topologi target dapat dinyalakan untuk pemeriksaan migrasi:

```bash
docker compose --profile storage up -d postgres clickhouse object-storage
docker compose --profile storage ps
```

Seluruh password contoh harus diganti sebelum service diekspos.
