# ADR 0003: Storage topology

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Data platform and backend engineering

## Context

MVP menyimpan sekitar satu `HistoryPoint` per detik di ring buffer 21.600 item
dan replay session selama 30 menit di memori. State hilang saat proses restart,
tidak ada raw depth capture, dan histori tersebut tidak cukup untuk membangun
ulang order book. Satu database tidak mengoptimalkan sekaligus transaksi produk,
scan time-series bervolume tinggi, dan arsip raw yang immutable.

## Decision

Gunakan tiga storage dengan tanggung jawab yang tidak tumpang tindih:

| Storage | Menyimpan | Tidak digunakan untuk |
|---|---|---|
| PostgreSQL | akun, workspace, watchlist, saved settings, alert definition, replay-session metadata, instrument metadata, migration/audit metadata | raw market event atau hot analytics scan |
| ClickHouse | normalized trades, depth snapshots/deltas, metric frames, signal frames, state fingerprints, dan agregasi 1 s/5 s/1 m | credential atau transaksi konfigurasi pengguna |
| S3-compatible object storage | raw REST/WS capture terkompresi, capture manifest, checksum, serta golden regression dataset | query dashboard interaktif |

Object storage adalah bukti raw yang immutable. ClickHouse adalah projection yang
dapat dibangun ulang dari raw capture. PostgreSQL adalah source of truth untuk
state produk. Tidak satu pun boleh menjadikan derived trend signal sebagai
pengganti raw fact.

### Ingestion and replay layout

- Recorder menulis exact raw payload beserta venue, connection/capture id,
  receive timestamp, monotonic receive ordinal, endpoint/stream, dan adapter
  version ke chunk terkompresi.
- Manifest per capture menyimpan waktu awal/akhir, simbol, count, byte count,
  schema/adapter version, chunk checksum, completeness, serta alasan disconnect.
- ClickHouse menerima batch; write path tidak melakukan insert per market event.
- Depth disimpan sebagai snapshot berkala dan delta di antaranya. Snapshot tidak
  membolehkan delta sebelum sequence bridge yang valid.
- Replay memilih snapshot terakhir pada/di bawah `from`, lalu membaca delta dan
  trade dalam deterministic capture order.
- PostgreSQL hanya menunjuk dataset/capture dan status replay; frame besar tidak
  disimpan sebagai JSON row di PostgreSQL.

### Default retention

Default berikut berlaku setelah ToS/licensing untuk environment target disetujui:

| Dataset | Hot/queryable | Archive/object storage |
|---|---:|---:|
| Raw depth delta | 14 hari | sampai 30 hari |
| Depth snapshot | 30 hari | 90 hari |
| Normalized raw trade | 90 hari | 365 hari |
| Aggregate 1 detik | 365 hari | optional sesuai kapasitas/lisensi |
| Aggregate 1 menit | 3 tahun | optional sesuai kapasitas/lisensi |
| Alert dan signal-version record | 365 hari | 3 tahun |
| Synthetic golden fixture | permanen di repository | n/a |
| Product metadata PostgreSQL | sampai dihapus pengguna/kebijakan | backup sesuai privacy policy |

Retention job harus dapat diubah per environment tanpa mengubah schema. Synthetic
golden dataset dipisahkan dari lifecycle raw produksi agar release regression
tetap reproducible. Live capture tidak boleh dijadikan fixture permanen kecuali
lisensinya secara eksplisit mengizinkan. Jika lisensi venue lebih ketat, batas
venue menang atas default ini.

Sampai clearance penyimpanan/redistribusi tersedia, raw live capture dibatasi
maksimal 24 jam pada environment engineering dengan akses terbatas dan tidak
boleh masuk repository atau dibagikan ke pengguna eksternal.

### Redis is deferred

Redis tidak dipasang pada fase penyimpanan pertama. Tambahkan hanya jika hasil
profiling menunjukkan minimal satu kebutuhan berikut:

- snapshot cache lintas lebih dari satu gateway instance;
- distributed rate limit, short-lived lease, atau subscription coordination;
- ephemeral state yang aman hilang dan memiliki TTL eksplisit.

Redis tidak boleh menjadi satu-satunya copy raw event, order-book history,
workspace, atau replay manifest. Menambahkan Redis memerlukan ADR baru yang
menyebut key ownership, TTL, eviction, failover, dan stale-cache semantics.

### External event bus is deferred

MVP tetap memakai channel/EventEmitter in-process. NATS JetStream, Redpanda,
Kafka, atau broker lain baru dievaluasi ketika salah satu trigger ini terbukti:

- ingestion harus diskalakan ke beberapa proses/host;
- ada dua atau lebih consumer independen yang membutuhkan durable delivery;
- deploy/restart tidak boleh memutus handoff antarservice;
- backpressure in-process tidak dapat memenuhi load target tiga kali peak;
- multi-exchange atau multi-region membutuhkan partition ownership eksplisit.

Sebelum trigger tersebut, raw recorder + batched ClickHouse writer menjadi dua
consumer bounded di proses yang sama. Queue harus memiliki kapasitas, metric,
dan kebijakan overload; menambahkan broker bukan pengganti backpressure.

## Alternatives considered

- **PostgreSQL saja:** sederhana, tetapi scan/retention raw depth menekan workload
  transaksional.
- **ClickHouse saja:** efisien untuk time-series, tetapi tidak ideal sebagai
  source of truth akun/configuration transactional.
- **Object storage saja:** murah dan auditable, tetapi query/replay startup
  interaktif terlalu mahal tanpa index/projection.
- **Redis/event bus sejak awal:** menambah failure mode dan operasional sebelum
  ada kebutuhan horizontal yang terukur.

## Consequences

- Backup/restore harus diuji per storage dan sebagai satu recovery workflow.
- Schema evolution raw, ClickHouse, dan PostgreSQL memiliki migration/version
  terpisah.
- Rebuild ClickHouse dari object storage menjadi disaster-recovery path yang
  wajib diuji.
- Ingestion tetap bisa berjalan saat projection tertunda selama bounded spool
  belum penuh; overload tidak boleh diam-diam membuang raw capture.

## Implementation status after Phase 2

Sudah diterapkan:

- durable file adapter berupa segmen gzip immutable, katalog/checksum atomik,
  batching, queue bounded, cursor, dan query resource limits;
- raw recorder beserta manifest/checksum serta katalog raw replay;
- snapshot berkala + delta, trade, metric interval 1 detik, dan rollup
  idempotent 5 detik/1 menit;
- retention concurrent-safe, automatic checksummed backup, dan verified restore;
- replay session metadata/checkpoint tahan restart;
- migration PostgreSQL/ClickHouse serta optional Compose profile bersama MinIO.

Gap yang tersisa:

- gateway masih memakai file adapter; runtime writer/query untuk PostgreSQL,
  ClickHouse, dan object storage belum diaktifkan;
- bucket provisioning, upload raw capture, backup lintas service, serta rebuild
  projection dari object storage belum menjadi workflow operasional;
- Redis dan external event bus tetap deferred sesuai trigger di ADR ini;
- legal clearance tetap wajib sebelum retention live default diberlakukan.
