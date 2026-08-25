# Rencana Pengembangan LiquidMap

## 1. Tujuan Dokumen

Dokumen ini adalah roadmap pengembangan setelah MVP LiquidMap selesai. Fokusnya adalah mengubah vertical slice yang sudah berjalan menjadi produk beta yang stabil, terukur, aman, dan siap digunakan untuk analisis pasar real-time.

Rencana produk dan arsitektur awal tetap tersedia di [`plan.md`](./plan.md). Dokumen ini berfokus pada urutan pengerjaan, prioritas, estimasi, dependensi, dan kriteria kelulusan setiap fase.

## 2. Kondisi Produk Saat Ini

### Sudah tersedia

- dashboard React + TypeScript;
- heatmap likuiditas berbasis Canvas;
- bubble aggressor buy/sell;
- pan, zoom, crosshair, tooltip, fullscreen, dan keyboard navigation;
- gateway Binance USD-M Futures untuk BTCUSDT;
- snapshot dan incremental order-book reconciliation;
- validasi sequence, gap detection, reconnect, dan resync;
- delta, CVD, imbalance, trade rate, volume ratio, dan trend score;
- indikator stale dan data-quality status;
- mode live, demo, dan replay;
- REST API serta WebSocket internal;
- unit test, build produksi, dan deployment Docker dasar.

### Batasan saat ini

- gateway hanya mendukung BTCUSDT perpetual;
- gateway dapat memakai depth/trade/metric history file persisten, tetapi
  adapter database produksi belum menjadi jalur runtime;
- schema serta profile PostgreSQL/ClickHouse/object storage tersedia, sementara
  integrasi write/query lintas service masih belum aktif;
- raw replay session dan checkpoint tahan restart tersedia melalui REST, tetapi
  historical depth heatmap belum terhubung ke UI;
- belum ada autentikasi, akun, atau workspace pengguna;
- alert eksternal belum tersedia;
- belum ada footprint, volume profile, open interest, funding, atau liquidation feed;
- belum ada eksekusi order;
- koneksi Binance live perlu divalidasi lebih lanjut pada environment produksi yang memiliki akses jaringan stabil.

## 3. Sasaran Pengembangan

### Sasaran 90 hari

1. Menjamin kebenaran order book dan analytics melalui replay deterministik.
2. Menyediakan penyimpanan historis yang tahan restart.
3. Menjalankan beta terbatas dengan observability dan data-quality monitoring.
4. Mendukung beberapa simbol utama tanpa menurunkan performa.
5. Menyediakan alert yang dapat dikonfigurasi pengguna.

### Sasaran 6 bulan

1. Mendukung minimal dua exchange dan sepuluh simbol aktif.
2. Menyediakan replay historis yang cepat dan dapat dipakai untuk evaluasi sinyal.
3. Menambahkan analytics order-flow lanjutan.
4. Menyediakan akun, workspace, watchlist, dan konfigurasi tersimpan.
5. Memiliki proses release, incident response, backup, dan pemulihan yang teruji.

### Prinsip prioritas

Urutan pengembangan harus selalu mengikuti prioritas berikut:

1. kebenaran data;
2. ketahanan koneksi;
3. performa dan observability;
4. pengalaman pengguna;
5. fitur analytics baru;
6. monetisasi atau eksekusi order.

## 4. Roadmap Utama

Estimasi berikut mengasumsikan tim kecil berisi dua sampai empat engineer. Durasi dapat berjalan tumpang tindih jika frontend, backend, dan quality engineering dikerjakan paralel.

| Fase | Durasi | Fokus | Hasil utama |
|---|---:|---|---|
| 0 | 1 minggu | Baseline dan keputusan produk | Target performa, schema, serta prioritas disepakati |
| 1 | 2 minggu | Data correctness dan reliability | Gateway dapat diaudit dan pulih dari semua kegagalan umum |
| 2 | 2 minggu | Penyimpanan dan replay | Histori tahan restart dan replay deterministik |
| 3 | 2 minggu | Performance dan observability | Dashboard operasional serta load/soak test |
| 4 | 2 minggu | Multi-symbol beta | Beberapa simbol dan watchlist dasar |
| 5 | 2 minggu | Analytics dan alert | Sinyal lanjutan serta notifikasi terukur |
| 6 | 2 minggu | Product beta | Workspace, onboarding, keamanan, dan beta terbatas |

Total target awal: **13 minggu**, termasuk fase penetapan baseline.

## 5. Fase 0 — Baseline dan Keputusan Produk

**Status pelaksanaan 24 Agustus 2026:** engineering discovery selesai dengan
`CONDITIONAL EXIT`. ADR, schema v1, target NFR, fixture regression, benchmark
sintetis, benchmark renderer, backlog, dan review data tersedia di
[`docs/phase-0/`](./docs/phase-0/). Pengukuran event-rate live normal/volatil,
uji browser pada perangkat fisik minimum, dan legal clearance tetap menjadi
gate eksternal yang terdokumentasi; lihat
[`exit-report.md`](./docs/phase-0/exit-report.md).

**Durasi:** 1 minggu  
**Tujuan:** memastikan tim memiliki definisi keberhasilan yang sama sebelum memperluas sistem.

### Pekerjaan

- tetapkan target pengguna pertama: scalper crypto perpetual;
- tetapkan simbol beta: BTCUSDT, ETHUSDT, dan SOLUSDT;
- tetapkan target perangkat minimum;
- ukur event rate Binance pada jam normal dan volatil;
- dokumentasikan schema event internal versi 1;
- tetapkan tick size, price bucket, time bucket, dan retention default;
- definisikan outcome objektif untuk evaluasi trend signal;
- buat dashboard backlog dan klasifikasi P0/P1/P2;
- review ToS, lisensi, serta aturan penyimpanan data exchange.

### Keluaran

- Architecture Decision Records untuk database, event bus, dan schema versioning;
- baseline CPU, memori, bandwidth, FPS, dan latency;
- dataset rekaman pasar untuk regression test;
- daftar metrik produk dan teknis.

### Kriteria selesai

- semua target non-functional memiliki angka yang terukur;
- dataset uji mencakup kondisi tenang, tren kuat, volatilitas tinggi, dan reconnect;
- tidak ada keputusan kritis yang masih bergantung pada asumsi tidak tertulis.

## 6. Fase 1 — Data Correctness dan Reliability

**Status pelaksanaan 24 Agustus 2026:** implementasi dan verifikasi workspace
selesai dengan `CONDITIONAL EXIT`. Atomic reconciliation, raw capture,
fingerprint, explicit validity, signal freeze, fault/replay/burst harness, dan
graceful shutdown telah lulus 93 test. Full soak delapan jam dan live capture
berizin tetap menjadi gate operasional; lihat
[`docs/phase-1/exit-report.md`](./docs/phase-1/exit-report.md).

**Durasi:** 2 minggu  
**Prioritas:** P0

### Backend

- simpan raw feed capture untuk pengujian;
- tambahkan checksum atau state fingerprint order book;
- tambahkan sequence-gap, duplicate, out-of-order, dan malformed-event counters;
- bedakan transport alive, market inactive, dan data stale;
- tingkatkan proses resync agar tidak mengirim state parsial ke client;
- tambahkan clock-drift monitoring antara exchange dan server;
- tambah bounded queue serta kebijakan backpressure;
- tambahkan graceful shutdown yang menyelesaikan buffer terakhir.

### Frontend

- tampilkan alasan data-quality degraded;
- tampilkan waktu update terakhir dan jumlah resync;
- kosongkan atau bekukan sinyal ketika book tidak valid;
- tambahkan reconnect/resync state yang tidak membingungkan pengguna;
- tambahkan error boundary untuk chart dan dashboard.

### Pengujian

- replay raw capture harus menghasilkan final order book yang sama;
- fault injection untuk event hilang, duplikat, terlambat, dan salah urutan;
- test disconnect saat snapshot sedang diambil;
- test burst traffic minimal tiga kali baseline puncak;
- soak test minimum delapan jam.

### Kriteria selesai

- tidak ada silent sequence gap;
- resync berhasil tanpa reload browser;
- sinyal tidak aktif saat state data tidak valid;
- replay yang sama menghasilkan state dan sinyal identik;
- soak test tidak menunjukkan memory leak yang terus meningkat.

## 7. Fase 2 — Penyimpanan Historis dan Replay

**Status pelaksanaan 25 Agustus 2026:** implementasi dan validasi workspace
selesai dengan `CONDITIONAL EXIT`. Histori gzip tahan restart, batching,
downsampling 1s/5s/1m, retention, verified backup/restore, raw replay
ber-checksum, serta session pause/seek/speed persisten telah lulus seluruh tujuh
acceptance case. Adapter runtime PostgreSQL/ClickHouse/object storage, seek
full-book dengan snapshot pre-roll, dan historical heatmap UI tetap menjadi
gate produksi; lihat [`docs/phase-2/exit-report.md`](./docs/phase-2/exit-report.md).

**Durasi:** 2 minggu  
**Prioritas:** P0

### Arsitektur yang disarankan

- PostgreSQL untuk akun, konfigurasi, dan metadata;
- ClickHouse untuk trade, depth delta, dan agregasi time-series;
- object storage untuk raw capture terkompresi;
- Redis hanya jika dibutuhkan untuk snapshot cache atau coordination.

### Pekerjaan

- desain tabel raw trade, depth snapshot, depth delta, dan metric frame;
- simpan snapshot berkala ditambah delta di antara snapshot;
- gunakan batching dan compression;
- buat retention policy per resolusi;
- bangun worker untuk downsampling 1 detik, 5 detik, dan 1 menit;
- buat replay session yang dapat dipause, seek, dan diubah kecepatannya;
- validasi replay dengan checksum state;
- tambahkan migrasi database dan backup otomatis;
- tambahkan batas query agar satu permintaan tidak menghabiskan memori server.

### Kriteria selesai

- histori tetap tersedia setelah restart;
- replay satu jam dapat dimulai kurang dari tiga detik pada dataset target;
- hasil replay deterministik;
- backup dan restore berhasil diuji;
- retention job tidak mengganggu ingestion live.

## 8. Fase 3 — Performance dan Observability

**Durasi:** 2 minggu  
**Prioritas:** P0

### Target awal

| Metrik | Target beta |
|---|---:|
| Event-to-screen latency p95 | < 150 ms |
| Gateway processing latency p95 | < 50 ms |
| UI frame rate | >= 30 FPS |
| WebSocket reconnect recovery | < 10 detik |
| Sequence gap tidak terdeteksi | 0 |
| Error-free browser sessions | >= 99% |
| Availability beta | >= 99,5% |

### Pekerjaan

- instrumentasi OpenTelemetry pada ingestion, analytics, API, dan client;
- metrik Prometheus untuk latency, queue, drop, resync, memory, dan client count;
- dashboard Grafana untuk operasional;
- alert internal untuk stale feed, error rate, dan memory pressure;
- profiling Canvas render dan pengurangan allocation per frame;
- pindahkan komputasi berat frontend ke Web Worker jika profiling membuktikan perlu;
- lakukan load test multi-client;
- lakukan soak test 24 jam;
- tambahkan release health check dan readiness check terpisah.

### Kriteria selesai

- setiap incident data memiliki jejak log dan metric yang cukup;
- target latency/FPS tercapai pada perangkat minimum;
- overload menghasilkan backpressure atau graceful degradation, bukan crash;
- alert operasional diuji melalui simulasi kegagalan.

## 9. Fase 4 — Multi-Symbol Beta

**Durasi:** 2 minggu  
**Prioritas:** P1

### Pekerjaan

- ubah gateway dari single-market menjadi market-session manager;
- tambahkan metadata instrument dan tick-size discovery;
- dukung BTCUSDT, ETHUSDT, dan SOLUSDT perpetual;
- batasi jumlah subscription per client;
- tambahkan watchlist;
- tambah pencarian simbol;
- pertahankan buffer terpisah per simbol;
- tambahkan cache snapshot dan lifecycle subscription;
- tambahkan test isolasi agar data tidak tercampur antarsimbol;
- ukur biaya CPU/memori per simbol dan per client.

### Kriteria selesai

- perpindahan simbol tidak memerlukan reload;
- tidak ada frame dari simbol lama setelah subscription baru aktif;
- tick size dan format harga selalu benar;
- tiga simbol berjalan bersamaan dalam target performa;
- subscription tanpa client berhenti atau masuk mode hemat sumber daya.

## 10. Fase 5 — Analytics Lanjutan dan Alert

**Durasi:** 2 minggu  
**Prioritas:** P1

### Analytics

- liquidity wall persistence;
- added/pulled liquidity;
- absorption;
- exhaustion;
- rolling VWAP;
- volume profile;
- footprint sederhana;
- funding rate dan open interest;
- liquidation feed jika sumber data dan lisensi memungkinkan.

### Alert

- alert trend score;
- alert liquidity wall muncul/hilang;
- alert volume delta dan trade velocity;
- cooldown serta deduplication;
- browser notification dan suara;
- webhook dan Telegram sebagai tahap berikutnya;
- audit log kapan alert dibuat, dipicu, dan dikirim.

### Evaluasi sinyal

- definisikan horizon 10 detik, 30 detik, 1 menit, dan 5 menit;
- ukur precision, recall, favorable excursion, dan adverse excursion;
- pisahkan hasil berdasarkan simbol, volatilitas, dan jam perdagangan;
- simpan versi formula/parameter pada setiap sinyal;
- jalankan mode shadow sebelum alert dianggap stabil.

### Kriteria selesai

- setiap sinyal menampilkan alasan dan versi algoritma;
- tidak ada alert berulang tanpa cooldown;
- evaluasi dapat direproduksi dari replay;
- threshold memiliki baseline per simbol, bukan angka universal tanpa kalibrasi.

## 11. Fase 6 — Product Beta

**Durasi:** 2 minggu  
**Prioritas:** P1

### Fitur produk

- autentikasi dan session management;
- workspace tersimpan;
- watchlist pengguna;
- penyimpanan layout, threshold, warna, dan alert;
- onboarding interaktif;
- shortcut dan command palette;
- ekspor screenshot serta CSV;
- halaman status sistem dan release notes.

### Keamanan

- threat modeling;
- rate limiting berbasis pengguna/IP;
- CSP yang sesuai untuk deployment produksi;
- dependency dan container scanning;
- secret manager;
- audit log perubahan konfigurasi;
- backup terenkripsi;
- data retention dan penghapusan akun.

### Operasional beta

- kelompok 10-30 pengguna pertama;
- feature flag untuk fitur eksperimental;
- feedback form di dalam aplikasi;
- runbook disconnect, data corruption, dan database failure;
- proses rollback satu perintah;
- jadwal on-call dan klasifikasi severity.

### Kriteria selesai

- seluruh jalur kritis memiliki monitoring dan runbook;
- akun dan workspace bertahan setelah restart/deployment;
- tidak ada temuan keamanan severity tinggi;
- feedback beta dapat dikaitkan dengan versi aplikasi dan kondisi data.

## 12. Prioritas Backlog

### P0 — sebelum beta eksternal

- DATA-001: raw feed recorder;
- DATA-002: deterministic replay checksum;
- DATA-003: resync atomic state;
- DATA-004: stale dan clock-drift monitoring;
- STORE-001: ClickHouse schema dan ingestion;
- STORE-002: snapshot/delta retention;
- OBS-001: metrics dan tracing;
- OBS-002: data-quality dashboard;
- PERF-001: load test dan baseline;
- PERF-002: soak test 24 jam;
- SEC-001: production headers, rate limit, dan container scan;
- OPS-001: backup/restore dan incident runbook.

### P1 — beta

- MARKET-001: market-session manager;
- MARKET-002: ETHUSDT dan SOLUSDT;
- UI-001: watchlist dan symbol search;
- UI-002: workspace persistence;
- ALERT-001: in-app/browser alert;
- FLOW-001: liquidity persistence;
- FLOW-002: absorption dan exhaustion;
- AUTH-001: akun dan autentikasi;
- PRODUCT-001: onboarding dan feedback.

### P2 — setelah beta stabil

- multi-exchange aggregation;
- footprint chart lengkap;
- DOM/trading ladder;
- alert Telegram/webhook;
- aplikasi desktop;
- strategy backtesting;
- broker connectivity;
- order execution.

Eksekusi order harus menjadi proyek terpisah karena menambah risiko keamanan, kepatuhan, dan kerugian finansial. Fitur tersebut tidak boleh dimulai hanya dengan memperluas izin gateway market-data saat ini.

## 13. Pembagian Tim yang Disarankan

### Backend/market data engineer

- exchange adapter;
- order-book engine;
- storage dan replay;
- backpressure dan reliability;
- latency profiling.

### Frontend/visualization engineer

- Canvas/WebGL renderer;
- chart interaction;
- worker dan memory management;
- workspace serta UX analytics.

### Platform/quality engineer

- CI/CD;
- infrastructure;
- observability;
- load, soak, dan fault-injection testing;
- security automation.

### Product/data analyst

- definisi sinyal;
- labeling dan evaluasi;
- threshold per market;
- feedback beta dan prioritas produk.

Jika tim hanya terdiri dari satu atau dua orang, urutkan fase secara serial dan jangan mengembangkan analytics baru sebelum Fase 1 sampai Fase 3 selesai.

## 14. Strategi Branch dan Release

- gunakan branch pendek per issue;
- setiap pull request wajib lulus type-check, unit test, dan build;
- perubahan schema wajib menyertakan versioning dan compatibility test;
- deploy otomatis ke staging setelah merge;
- jalankan replay regression dan smoke test di staging;
- promosi ke production menggunakan immutable image;
- gunakan semantic versioning;
- patch release untuk bug, minor untuk fitur kompatibel, major untuk perubahan kontrak;
- simpan changelog dan migration notes.

### Release gate

Release tidak boleh dipromosikan jika:

- order-book replay berbeda dari golden result;
- terdapat sequence gap yang tidak memicu resync;
- test atau build gagal;
- p95 latency melewati target tanpa waiver tertulis;
- terdapat vulnerability severity tinggi;
- database migration tidak memiliki rollback atau forward-fix plan;
- data source ToS/licensing belum disetujui.

## 15. Definition of Done

Sebuah backlog item dianggap selesai hanya jika:

1. implementasi dan acceptance criteria terpenuhi;
2. unit/integration test ditambahkan;
3. telemetry ditambahkan jika memengaruhi jalur runtime;
4. error dan degraded state dapat dipahami pengguna;
5. dokumentasi/API contract diperbarui;
6. tidak menambah regression performa yang signifikan;
7. telah diuji dengan replay atau data nyata yang relevan;
8. security dan privacy impact sudah diperiksa;
9. dapat di-deploy dan di-rollback;
10. lolos review minimal satu anggota tim lain.

## 16. Metrik yang Dipantau

### Data quality

- sequence gaps;
- resync count dan duration;
- stale duration;
- exchange/server clock drift;
- crossed-book incidents;
- dropped/duplicate events.

### Performa

- event-to-screen p50/p95/p99;
- gateway processing time;
- WebSocket queue dan buffered bytes;
- FPS dan dropped frame;
- CPU, GPU, heap, RSS, disk, dan bandwidth;
- replay startup dan seek latency.

### Produk

- daily/weekly active users;
- session duration;
- symbol switch dan replay usage;
- alert created/triggered/opened;
- retention pengguna;
- crash-free sessions;
- feedback severity dan feature demand.

### Sinyal

- jumlah sinyal per jam;
- precision dan recall;
- favorable/adverse excursion;
- hasil per simbol dan volatility regime;
- false-positive report dari pengguna;
- perbedaan hasil antarversi algoritma.

## 17. Risiko Utama

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Data exchange terputus atau dibatasi | Analisis berhenti | Multi-feed, fallback, reconnect, status jelas |
| Order book tidak sinkron | Sinyal salah | Sequence validation, checksum, atomic resync |
| Depth storage membesar cepat | Biaya tinggi | Compression, retention, tiering, downsampling |
| Renderer overload | UI lag | Profiling, bucketing, Web Worker, WebGL bila perlu |
| Spoofing | Sinyal menyesatkan | Persistence dan executed-volume confirmation |
| Threshold overfit | Hasil buruk di market lain | Evaluasi per simbol/regime dan versioning |
| Scope berkembang terlalu cepat | Reliability tertunda | Release gate dan prioritas data-first |
| ToS atau lisensi data | Risiko hukum/operasional | Review sebelum penyimpanan dan redistribusi |
| Eksekusi order prematur | Risiko finansial | Proyek terpisah, audit, dan izin eksplisit |

## 18. Rencana Sprint Pertama

### Minggu 1

- rekam 3-5 dataset pasar dengan regime berbeda;
- ukur event rate, latency, CPU, memori, dan FPS;
- buat checksum order-book state;
- buat test replay raw depth;
- dokumentasikan schema event versi 1;
- tetapkan ClickHouse schema awal.

### Minggu 2

- implementasikan raw feed recorder;
- implementasikan fault-injection harness;
- buat atomic resync state;
- tambahkan metric sequence gap, stale, dan clock drift;
- tampilkan data-quality reason pada UI.

### Minggu 3

- jalankan soak test delapan jam;
- perbaiki memory/queue issue;
- implementasikan ingestion ClickHouse tahap pertama;
- simpan trade dan depth snapshot/delta;
- buat query histori dasar.

### Hasil sprint pertama

Pada akhir minggu ketiga, tim harus dapat membuktikan bahwa data yang direkam dapat diputar ulang dan menghasilkan order book akhir yang sama, serta setiap gangguan urutan event terdeteksi dan dipulihkan secara otomatis.

## 19. Urutan Implementasi yang Direkomendasikan

```text
Data correctness
      ↓
Persistent storage + deterministic replay
      ↓
Observability + performance hardening
      ↓
Multi-symbol
      ↓
Analytics lanjutan + alert
      ↓
Account, workspace, dan beta
      ↓
Multi-exchange
      ↓
Evaluasi terpisah untuk order execution
```

Jangan memindahkan fase multi-symbol atau analytics ke depan jika replay correctness, recovery, dan observability belum memenuhi release gate.
