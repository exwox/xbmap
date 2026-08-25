# Rencana Aplikasi Trading Real-Time ala Bookmap

## 1. Ringkasan Produk

Aplikasi ini adalah platform visualisasi order flow real-time untuk membantu trader melihat:

- likuiditas bid dan ask pada setiap level harga;
- perubahan order book dalam bentuk heatmap warna;
- transaksi yang benar-benar terjadi dalam bentuk bubble;
- dominasi buyer atau seller;
- tren kuat, breakout, absorption, dan potensi pembalikan;
- alert ketika kondisi pasar memenuhi aturan tertentu.

MVP berfokus pada analisis dan visualisasi (read-only), bukan eksekusi order otomatis. Pasar pertama yang disarankan adalah crypto perpetual futures karena data order book dan trade tersedia secara real-time melalui WebSocket.

## 2. Tujuan dan Batasan

### Tujuan MVP

1. Menampilkan heatmap likuiditas yang bergerak secara real-time.
2. Menampilkan bubble transaksi berdasarkan volume agresif.
3. Menampilkan candlestick atau garis harga di atas heatmap.
4. Memberikan sinyal visual ketika terdeteksi tren kuat.
5. Mendukung replay data untuk pengujian dan evaluasi strategi.
6. Tetap responsif saat menerima ribuan pembaruan per detik.

### Di luar cakupan MVP

- eksekusi order dan penyimpanan API key pengguna;
- copy trading atau trading otomatis;
- multi-broker routing;
- aplikasi mobile native;
- rekomendasi finansial atau jaminan profit;
- machine learning sebelum indikator berbasis aturan memiliki baseline yang terukur.

## 3. Pengguna Sasaran

- day trader dan scalper;
- trader futures yang memakai order flow;
- analis yang ingin melihat support/resistance berbasis likuiditas;
- pengguna yang ingin melakukan replay kondisi pasar.

## 4. Konsep Visual Utama

### Heatmap likuiditas

- Sumbu X: waktu.
- Sumbu Y: harga.
- Intensitas warna: besar likuiditas resting pada suatu level harga.
- Warna gelap: likuiditas rendah.
- Kuning/oranye/merah terang: likuiditas tinggi.
- Normalisasi warna menggunakan skala logaritmik atau percentile agar order yang sangat besar tidak menutupi detail lain.
- Bid dan ask dapat memakai palet berbeda, tetapi intensitas tetap mudah dibaca.

### Bubble transaksi

- Posisi X: waktu transaksi.
- Posisi Y: harga transaksi.
- Ukuran bubble: volume transaksi teragregasi.
- Hijau: market buy/aggressor buy.
- Merah: market sell/aggressor sell.
- Transparansi: tingkat volume atau confidence.
- Transaksi pada waktu dan harga yang berdekatan digabung agar layar tidak penuh.

Contoh formula ukuran bubble:

```text
radius = clamp(minRadius, maxRadius, scale * sqrt(volume / medianVolume))
```

### Penanda tren kuat

- Latar atau ribbon hijau ketika tren naik kuat.
- Latar atau ribbon merah ketika tren turun kuat.
- Skor kekuatan tren 0-100.
- Label alasan sinyal, misalnya `Buy imbalance + positive delta + breakout`.
- Sinyal harus selalu menampilkan confidence dan tidak boleh digambarkan sebagai kepastian.

## 5. Kebutuhan Fungsional

### P0 — wajib untuk MVP

- pemilihan exchange, simbol, dan jenis pasar;
- koneksi WebSocket dengan reconnect otomatis;
- sinkronisasi snapshot dan incremental depth update;
- validasi sequence number agar order book tidak rusak;
- heatmap order book real-time;
- bubble buy/sell dari stream trade;
- harga terakhir, spread, best bid, dan best ask;
- interval tampilan 1 detik, 5 detik, 15 detik, 1 menit, dan 5 menit;
- zoom, pan, crosshair, tooltip harga/waktu/volume;
- indikator volume delta dan cumulative volume delta (CVD);
- deteksi tren kuat berbasis aturan;
- status koneksi dan indikator data stale;
- penyimpanan data untuk replay;
- pengaturan threshold warna dan bubble.

### P1 — setelah MVP stabil

- liquidity wall dan deteksi penambahan/penghapusan likuiditas;
- absorption dan exhaustion;
- alert browser, suara, Telegram, atau webhook;
- watchlist multi-symbol;
- perbandingan spot dan perpetual;
- open interest, funding rate, dan liquidation feed;
- workspace/layout yang dapat disimpan;
- ekspor snapshot dan CSV.

### P2 — pengembangan lanjutan

- agregasi data beberapa exchange;
- footprint chart dan volume profile;
- DOM/trading ladder;
- backtesting sinyal;
- koneksi broker untuk eksekusi order dengan konfirmasi berlapis;
- desktop wrapper atau aplikasi mobile pendamping.

## 6. Aturan Pengolahan Data Pasar

### Sinkronisasi order book

1. Buka stream incremental depth.
2. Buffer event yang masuk.
3. Ambil REST snapshot beserta sequence/update ID terakhir.
4. Buang event yang lebih lama dari snapshot.
5. Terapkan event berurutan ke struktur order book lokal.
6. Jika ada gap sequence, tandai data tidak valid dan lakukan resync.
7. Kirim frame teragregasi ke UI pada frekuensi tetap, misalnya 10-20 FPS; jangan render setiap event jaringan.

### Struktur data

- Bid disimpan terurut menurun berdasarkan harga.
- Ask disimpan terurut menaik berdasarkan harga.
- Quantity `0` berarti level harga dihapus.
- Harga dinormalisasi ke tick size instrumen.
- Data heatmap disimpan per bucket waktu dan bucket harga.
- Gunakan integer tick atau decimal yang presisi; hindari perbandingan harga dengan floating-point mentah.

### Klasifikasi transaksi agresif

- Aggressor buy: buyer mengambil likuiditas pada ask.
- Aggressor sell: seller mengambil likuiditas pada bid.
- Gunakan flag maker/taker dari exchange jika tersedia.
- Jika tidak tersedia, gunakan tick rule sebagai fallback dan beri label confidence lebih rendah.

### Agregasi bubble

Transaksi digabung berdasarkan:

- bucket waktu, misalnya 100-500 ms;
- tick/rentang harga yang sama;
- sisi aggressor yang sama.

Simpan nilai `buyVolume`, `sellVolume`, `totalVolume`, `tradeCount`, `vwap`, dan `maxTrade` untuk setiap bucket.

## 7. Deteksi Tren Kuat

Detektor awal menggunakan skor berbasis aturan agar mudah dijelaskan dan diuji. Jangan langsung memakai satu indikator sebagai sinyal final.

### Fitur yang dihitung

- perubahan harga pada jendela pendek dan menengah;
- kemiringan EMA cepat dan lambat;
- volume dibanding median/percentile historis;
- volume delta dan CVD slope;
- order book imbalance dekat mid-price;
- kecepatan trade (trade rate);
- breakout dari high/low lokal;
- spread dan volatilitas;
- persistence: berapa lama kondisi bertahan.

Order book imbalance pada N level terdekat:

```text
imbalance = (bidLiquidity - askLiquidity) / (bidLiquidity + askLiquidity)
```

Contoh skor tren naik:

```text
scoreUp =
  25% momentum harga
  20% positive volume delta
  15% kemiringan CVD
  15% order book imbalance
  15% lonjakan volume/trade rate
  10% konfirmasi breakout
```

Klasifikasi awal:

- `0-39`: netral;
- `40-59`: mulai terbentuk;
- `60-79`: kuat;
- `80-100`: sangat kuat.

Sinyal hanya aktif jika skor melewati threshold selama beberapa frame dan spread/data quality masih normal. Gunakan hysteresis, misalnya sinyal masuk pada 65 dan keluar di bawah 50, untuk mencegah indikator berkedip.

### Pencegahan sinyal palsu

- abaikan sinyal ketika data stale atau order book belum sinkron;
- kurangi skor saat spread melebar ekstrem;
- gunakan nilai relatif terhadap baseline per simbol dan sesi;
- bedakan likuiditas yang tampil sesaat dengan wall yang bertahan;
- evaluasi spoofing sebagai perubahan likuiditas, bukan transaksi aktual;
- konfirmasikan breakout dengan executed volume, bukan resting order saja.

## 8. Arsitektur Teknis

```text
Exchange REST/WebSocket
        |
        v
Market Data Gateway
  - reconnect/resync
  - rate limit
  - schema normalization
        |
        v
Event Bus / Stream
        |
        +-------------------+
        |                   |
        v                   v
Order Book Engine      Trade Aggregator
        |                   |
        +---------+---------+
                  v
          Analytics Engine
          - delta/CVD
          - imbalance
          - trend score
                  |
          +-------+--------+
          |                |
          v                v
   Time-series Store   Realtime Gateway
                           |
                           v
                     Web Application
```

### Stack yang disarankan

- Frontend: React + TypeScript + Vite.
- Rendering: WebGL melalui PixiJS/regl/custom shader; Canvas 2D hanya untuk prototipe awal.
- Grafik harga/UI overlay: Lightweight Charts atau modul canvas sendiri.
- Backend data gateway: Rust untuk throughput tinggi, atau Go untuk implementasi lebih cepat.
- API: WebSocket untuk stream dan REST untuk konfigurasi/history.
- Event bus MVP: channel in-process; naikkan ke NATS JetStream atau Redpanda ketika perlu horizontal scaling.
- Database: ClickHouse untuk trade/depth historis; PostgreSQL untuk pengguna dan konfigurasi.
- Cache/state: Redis opsional untuk snapshot dan pub/sub.
- Deployment: Docker Compose untuk development, lalu Kubernetes hanya jika beban operasional membutuhkannya.
- Observability: OpenTelemetry, Prometheus, Grafana, dan structured logging.

### Format event internal

```json
{
  "type": "depth_update",
  "exchange": "example",
  "symbol": "BTC-USDT-PERP",
  "exchangeTimestamp": 0,
  "receivedTimestamp": 0,
  "sequenceStart": 0,
  "sequenceEnd": 0,
  "bids": [[0, 0]],
  "asks": [[0, 0]]
}
```

Semua exchange harus dipetakan ke schema internal yang sama sebelum masuk ke mesin analitik.

## 9. Komponen Antarmuka

1. Top bar: exchange, simbol, market, status koneksi, latency.
2. Main chart: heatmap, harga, bubble, zoom, dan crosshair.
3. Order-flow panel: delta, CVD, trade rate, buy/sell ratio.
4. Trend panel: skor 0-100, arah, confidence, dan alasan.
5. Controls: threshold heatmap, ukuran bubble, depth range, timeframe.
6. Replay controls: tanggal, play/pause, kecepatan, lompat waktu.
7. Alert drawer: daftar sinyal dengan timestamp dan kondisi pemicu.

UI harus tetap informatif bagi pengguna buta warna: arah tidak boleh dibedakan berdasarkan warna saja; tambahkan ikon, label, atau pola.

## 10. API Minimum

### REST

- `GET /api/v1/markets`
- `GET /api/v1/snapshot?exchange=&symbol=`
- `GET /api/v1/history?symbol=&from=&to=&resolution=`
- `GET /api/v1/settings`
- `PUT /api/v1/settings`
- `POST /api/v1/replay/session`

### WebSocket

- client subscribe/unsubscribe berdasarkan exchange dan simbol;
- server mengirim `depth_frame`, `trade_bucket`, `price`, `metric`, `trend_signal`, `status`;
- setiap payload memiliki versi schema, timestamp exchange, timestamp server, dan sequence;
- dukung heartbeat, backpressure, dan snapshot ulang saat client kehilangan sequence.

## 11. Penyimpanan dan Retensi

- Simpan raw trade untuk replay dan audit.
- Depth penuh sangat besar; simpan snapshot berkala ditambah delta terkompresi.
- Buat data turunan teragregasi untuk query cepat.
- Retensi awal yang disarankan:
  - raw depth: 7-14 hari;
  - raw trade: 30-90 hari;
  - agregasi 1 detik/1 menit: lebih panjang;
  - konfigurasi dan alert: sesuai kebutuhan pengguna.
- Retensi final harus disesuaikan dengan kapasitas storage dan lisensi data exchange.

## 12. Non-Functional Requirements

- Target latency internal p95 dari event diterima hingga frame tersedia: kurang dari 100 ms pada MVP.
- UI target 30-60 FPS pada perangkat desktop modern.
- Reconnect otomatis dengan exponential backoff dan jitter.
- Tidak menampilkan data sebagai live jika timestamp melewati batas stale.
- Pemakaian memori dibatasi melalui ring buffer dan window data terlihat.
- Semua timestamp disimpan dalam UTC; UI boleh menampilkan zona lokal.
- Pengujian minimal mencakup unit, integration, replay deterministik, load, dan visual regression.

## 13. Keamanan dan Kepatuhan

- MVP tidak menerima API key trading.
- Terapkan TLS, validasi input, rate limiting, dan batas ukuran message.
- Jangan log credential, token, atau data sensitif.
- Jika fitur trading ditambahkan, gunakan secret manager, izin minimum, IP allowlist jika tersedia, dan konfirmasi order.
- Tampilkan disclaimer bahwa sinyal adalah alat bantu analisis, bukan nasihat keuangan.
- Verifikasi lisensi, ToS, redistribusi, serta batas penyimpanan data setiap exchange sebelum produksi.

## 14. Tahapan Implementasi

### Fase 0 — discovery dan spike (1 minggu)

- pilih satu exchange dan satu market;
- ukur rate event pada simbol aktif;
- prototipe sinkronisasi order book;
- prototipe render 100 ribu hingga 1 juta cell;
- tetapkan baseline latency dan memori.

**Keluar fase jika:** order book hasil replay konsisten, gap terdeteksi, dan renderer mencapai minimal 30 FPS pada dataset uji.

### Fase 1 — data pipeline (2 minggu)

- market data gateway;
- normalisasi trade/depth;
- snapshot + incremental reconciliation;
- reconnect, heartbeat, metrics, dan structured logs;
- perekaman raw event dan replay deterministik.

**Keluar fase jika:** replay menghasilkan state akhir yang sama dengan live capture dan resync pulih otomatis dari gap.

### Fase 2 — heatmap dan bubble (2-3 minggu)

- agregasi time/price bucket;
- WebSocket frontend;
- WebGL heatmap;
- price overlay, bubble, tooltip, zoom, dan pan;
- kontrol warna dan threshold.

**Keluar fase jika:** chart berjalan stabil selama satu jam pada simbol aktif tanpa memory leak atau freeze.

### Fase 3 — analytics dan tren (2 minggu)

- delta, CVD, imbalance, volume baseline;
- trend score dan hysteresis;
- alasan sinyal dan confidence;
- alert internal;
- test dengan data replay berbagai kondisi pasar.

**Keluar fase jika:** setiap sinyal dapat dijelaskan dari input metric dan hasil replay deterministik.

### Fase 4 — hardening beta (2 minggu)

- load test dan chaos test koneksi;
- profiling CPU/GPU/memori;
- data-quality dashboard;
- accessibility dan responsive layout desktop;
- dokumentasi operasi dan incident runbook.

**Keluar fase jika:** target latency, FPS, recovery, dan kestabilan terpenuhi pada soak test.

### Fase 5 — pengembangan produk

- multi-symbol/multi-exchange;
- alert eksternal;
- liquidity analytics lanjutan;
- akun pengguna dan penyimpanan workspace;
- evaluasi fitur trading setelah audit keamanan dan kepatuhan.

## 15. Backlog Awal

### Epic A — market data

- adapter exchange pertama;
- REST snapshot fetcher;
- WebSocket depth/trade consumer;
- sequence validator dan resync;
- schema normalizer;
- recorder dan replay reader.

### Epic B — analytics

- local order book;
- trade bucketing;
- liquidity heatmap bucketing;
- delta dan CVD;
- imbalance;
- trend scoring dan signal state machine.

### Epic C — frontend

- shell dashboard;
- chart viewport;
- WebGL heatmap layer;
- price layer;
- bubble layer;
- interaction layer;
- metric/trend panels;
- replay controls.

### Epic D — reliability

- telemetry;
- data gap alert;
- backpressure;
- load/replay tests;
- deployment dan backup;
- feature flags.

## 16. Strategi Pengujian

- Unit test: penerapan depth delta, tick normalization, aggregation, dan formula skor.
- Property test: order book tidak crossed setelah event valid dan quantity tidak negatif.
- Integration test: snapshot + buffered event + reconnect + resync.
- Golden replay test: input event tetap harus menghasilkan frame dan sinyal yang sama.
- Load test: burst event pada beberapa kali beban puncak hasil discovery.
- Soak test: live/replay selama 8-24 jam untuk mendeteksi memory leak.
- Visual regression: warna heatmap, ukuran bubble, overlay, dan tooltip.
- Fault injection: event hilang, event duplikat, urutan salah, disconnect, clock drift, dan data malformed.

## 17. Kriteria Penerimaan MVP

- Order book tetap sinkron dan otomatis pulih ketika sequence terputus.
- Heatmap memperlihatkan perubahan likuiditas tanpa lag visual yang mengganggu.
- Bubble membedakan aggressor buy dan sell serta ukurannya proporsional terhadap volume.
- Pengguna dapat melihat detail waktu, harga, volume, sisi, dan liquidity level melalui crosshair/tooltip.
- Trend signal menampilkan arah, skor, confidence, dan alasan.
- Sinyal serta chart dapat direproduksi menggunakan replay data yang sama.
- Data stale terlihat jelas dan tidak disajikan sebagai data live normal.
- Latency p95, FPS, penggunaan memori, dan error rate terlihat di dashboard observability.
- Aplikasi lolos soak test dan fault-injection minimum sebelum beta.

## 18. Metrik Keberhasilan

### Teknis

- event-to-screen latency p50/p95/p99;
- FPS dan dropped frames;
- reconnect dan resync count;
- sequence gap rate;
- CPU, GPU, memori, dan bandwidth;
- waktu query dan replay startup.

### Produk

- pengguna aktif harian/mingguan;
- durasi sesi;
- simbol yang dipantau per sesi;
- alert yang dibuka atau ditindaklanjuti;
- retensi pengguna;
- feedback mengenai kegunaan heatmap dan false signal.

### Evaluasi sinyal

- precision/recall berdasarkan definisi outcome yang disepakati;
- adverse/favorable price excursion setelah sinyal;
- performa per simbol, sesi, volatilitas, dan horizon waktu;
- jumlah sinyal per jam dan tingkat false positive;
- jangan memakai win rate saja sebagai ukuran kualitas.

## 19. Risiko dan Mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Gap atau event WebSocket hilang | Heatmap/order book salah | Sequence validation, resync, status data quality |
| Volume event sangat tinggi | Lag dan crash | Bucketing, ring buffer, backpressure, WebGL |
| Skala warna buruk | Informasi tidak terbaca | Log scale, percentile normalization, konfigurasi pengguna |
| Spoofing/fake liquidity | Sinyal menyesatkan | Persistence metric dan konfirmasi executed volume |
| Sinyal terlalu sensitif | Banyak false positive | Baseline adaptif, hysteresis, regime filter, replay evaluation |
| Perbedaan schema exchange | Bug normalisasi | Adapter contract dan conformance test |
| Biaya penyimpanan depth | Biaya membesar cepat | Delta compression, tiering, retensi, agregasi |
| Ketergantungan exchange tunggal | Gangguan layanan | Abstraction layer dan adapter exchange kedua setelah MVP |
| Isu lisensi/ToS data | Risiko operasional | Review ToS sebelum menyimpan atau mendistribusikan data |

## 20. Keputusan yang Perlu Ditetapkan Sebelum Coding Produksi

1. Exchange dan market pertama.
2. Simbol target dan perkiraan beban puncak.
3. Tick/bucket price serta bucket waktu default.
4. Target latency dan spesifikasi perangkat minimum.
5. Durasi retensi raw depth/trade.
6. Apakah deployment lokal, cloud, atau hybrid.
7. Definisi objektif “tren kuat” dan horizon evaluasinya.
8. Palet warna, accessibility, dan identitas visual.

## 21. Rekomendasi Langkah Pertama

Bangun vertical slice kecil untuk satu simbol: ambil snapshot dan depth stream, simpan raw event, bentuk order book lokal, kirim frame teragregasi, lalu render heatmap dan bubble. Setelah jalur ini stabil dan replay-nya deterministik, tambahkan analytics. Urutan ini memberi bukti teknis paling cepat sekaligus mengurangi risiko membangun indikator di atas data yang belum benar.
