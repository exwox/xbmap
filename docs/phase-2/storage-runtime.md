# Storage runtime Fase 2

## Jalur yang aktif

Gateway memakai `HistoryPersistence` ketika `XBMAP_HISTORY_DIR` diisi. Jalur
ini menyimpan trade, depth snapshot, depth delta, dan metric frame sebagai
segmen gzip immutable. Katalog diperbarui atomik dan setiap segmen memiliki
checksum. Docker Compose mengaktifkannya dengan named volume; pengembangan npm
lokal tetap memakai buffer memori bila variabel tersebut kosong.

Ingestion memasuki queue bounded, lalu ditulis dalam batch. Queue overflow
terlihat pada health/data-quality counter. Snapshot disimpan saat reconcile dan
berkala setiap 30 detik; delta di antaranya mempertahankan urutan capture.

Metric 1 detik menyimpan fakta interval buy/sell/trade-count, bukan penjumlahan
rolling window. Worker membuat rollup 5 detik dan 1 menit secara idempotent.
Checkpoint worker persisten sehingga restart tidak menggandakan bucket.

## Resolusi dan retention default

| Data | Retention |
|---|---:|
| Trade | 90 hari |
| Depth snapshot | 30 hari |
| Depth delta | 14 hari |
| Metric 1 detik | 365 hari |
| Metric 5 detik | 365 hari |
| Metric 1 menit | 3 tahun |

Nilai dapat dioverride melalui `.env.example`. Default hanya boleh digunakan
untuk live data setelah hak penyimpanan venue disetujui. Sebelum clearance,
raw capture engineering tetap dibatasi maksimal 24 jam.

Retention memakai immutable-segment lease dan dapat berjalan bersamaan dengan
append. Query dibatasi oleh rentang, row, jumlah segmen, dan compressed bytes;
hasil internal mendukung cursor pagination.

## Backup

Jika `XBMAP_HISTORY_BACKUP_DIR` diisi, runtime membuat backup berkala dan
mempertahankan sejumlah `XBMAP_HISTORY_BACKUP_KEEP`. Sebelum snapshot backup,
writer di-flush. Manifest serta seluruh compressed segment diverifikasi dengan
SHA-256 saat restore. Restore hanya diizinkan ketika queue ingestion idle.

Acceptance test melakukan backup ke direktori terpisah, membuka store baru,
restore, lalu membandingkan jumlah row dan digest terurut.

## Topologi produksi yang disiapkan

Profile Compose `storage` menyediakan:

- PostgreSQL untuk metadata dataset, replay session, dan backup run;
- ClickHouse untuk raw trade, depth snapshot/delta, serta metric 1s/5s/1m;
- MinIO sebagai object storage S3-compatible.

Migration SQL ada di `migrations/postgres` dan `migrations/clickhouse`. Gateway
belum menulis langsung ke ketiga service tersebut; adapter file adalah runtime
default Fase 2. Karena itu backup lintas PostgreSQL/ClickHouse/MinIO, bucket
provisioning, dan rebuild projection dari object storage masih gate produksi.
