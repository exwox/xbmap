# Exit report Fase 2

- Tanggal: 25 Agustus 2026
- Status: **CONDITIONAL EXIT**
- Scope: storage/replay lokal dan kontrak deployment target

## Penilaian kriteria selesai

| Kriteria roadmap | Bukti | Status |
|---|---|---|
| Histori tersedia setelah restart | fresh `FileHistoryStore` menemukan ulang 600 record dan digest identik | PASS |
| Replay satu jam mulai <3 detik | katalog, verifikasi, session, dan first page untuk 7.201 raw record jauh di bawah 3 detik pada host referensi | PASS lokal sintetis |
| Replay deterministik | frame order dan rolling checksum identik pada 0,25x dan 20x, termasuk setelah seek | PASS |
| Backup/restore diuji | 750 record dan digest terurut pulih identik; manifest ber-checksum | PASS adapter file |
| Retention tidak mengganggu live ingestion | 500 row expired dihapus sementara 500 row live tetap ter-commit | PASS harness |

Seluruh tujuh acceptance case dan seluruh suite aplikasi lulus. Baseline lengkap
tersedia di [phase-2-validation.md](../baselines/phase-2-validation.md).

## Yang selesai

- schema runtime raw trade/depth snapshot/depth delta/metric frame;
- append-only compressed history, atomic catalog, batching, bounded queue;
- periodic snapshot dan delta di antaranya;
- downsample 1s/5s/1m dengan checkpoint idempotent;
- retention, bounded query, cursor, automatic backup, verified restore;
- raw capture catalog/checksum dan deterministic projection verifier;
- replay session pause/resume/seek/speed/delete/expiry/restart checkpoint;
- endpoint health/history/raw replay dan graceful shutdown;
- migration PostgreSQL/ClickHouse dan profile Compose bersama MinIO.

## Gate yang belum tertutup

1. Gateway production belum memakai adapter PostgreSQL/ClickHouse/MinIO;
   migration dan service profile tersedia, tetapi write/query/backup lintas
   service belum menjadi runtime default.
2. Startup <3 detik diuji pada file adapter dan synthetic dataset di host
   referensi, belum pada dataset target serta hardware deployment produksi.
3. Seek REST belum pre-roll dari snapshot valid untuk menghasilkan full book
   persis pada target; API saat ini adalah raw audit delivery.
4. UI Replay belum memilih capture persisten atau menampilkan historical depth
   heatmap dari raw projection.
5. Full soak delapan jam, live licensed capture, dan legal clearance dari fase
   sebelumnya tetap gate operasional.

## Keputusan

Fase 3 dapat dimulai untuk performance dan observability pada jalur file
persisten. Beta eksternal dan klaim storage produksi tetap ditahan sampai gate
di atas diuji pada adapter deployment sebenarnya.
