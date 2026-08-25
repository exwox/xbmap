# Keputusan Produk dan Parameter Pasar

Tanggal keputusan: 24 Agustus 2026  
Pemilik keputusan: Product + Engineering  
Status: diterima untuk beta awal

## 1. Pengguna pertama

Pengguna pertama LiquidMap adalah **scalper dan day trader crypto perpetual yang memakai desktop**, memahami risiko leverage, dan membutuhkan visual order-flow untuk keputusan manual.

LiquidMap beta tetap:

- read-only;
- bukan penasihat investasi;
- tanpa penyimpanan API key;
- tanpa eksekusi order;
- dioptimalkan untuk analisis intraday, bukan investasi jangka panjang.

## 2. Market beta

Urutan simbol beta:

1. `BTCUSDT` perpetual;
2. `ETHUSDT` perpetual;
3. `SOLUSDT` perpetual.

Exchange pertama adalah Binance USDⓈ-M Futures. Implementasi multi-symbol baru dimulai setelah single-symbol memenuhi data-correctness dan observability gate.

## 3. Perangkat minimum

Target minimum untuk beta desktop:

| Komponen | Minimum |
|---|---|
| CPU | 4 logical core kelas Intel Core i5/Ryzen 5 tahun 2019 atau setara |
| RAM | 8 GB, dengan minimal 1 GB tersedia untuk browser |
| GPU | Integrated GPU dengan Canvas 2D hardware acceleration |
| Layar | 1366×768; 1920×1080 direkomendasikan |
| Browser | Dua versi stabil terbaru Chrome, Edge, atau Firefox |
| Jaringan | 10 Mbps, packet loss < 1%, RTT ke gateway < 150 ms |
| Sistem | Desktop 64-bit yang masih menerima security update |

Safari diuji sebagai compatibility target setelah beta desktop stabil. Perangkat mobile hanya mendapat tampilan monitoring; interaksi chart penuh tidak menjadi acceptance criterion beta pertama.

## 4. Presisi harga dan quantity

- Harga internal disimpan sebagai integer tick.
- Tick size dan quantity step harus berasal dari metadata instrument exchange.
- Floating-point hanya boleh digunakan pada batas presentasi atau analytics yang tidak mengubah state order book.
- Metadata instrument diperiksa ulang saat startup dan minimal setiap enam jam.
- Perubahan tick size memaksa session resync dan membuat boundary baru pada histori.

Nilai bootstrap saat metadata live belum tersedia:

| Simbol | Tick bootstrap | Catatan |
|---|---:|---|
| BTCUSDT | 0,1 | Sudah dipakai MVP; harus diverifikasi lewat exchange info |
| ETHUSDT | belum dikunci | Ambil dari exchange info sebelum adapter diaktifkan |
| SOLUSDT | belum dikunci | Ambil dari exchange info sebelum adapter diaktifkan |

Nilai bootstrap bukan kontrak permanen dan tidak boleh menggantikan metadata exchange di production.

## 5. Bucket dan frekuensi

| Fungsi | Default | Batas/aturan |
|---|---:|---|
| Depth ingestion | sesuai feed, target 100 ms | Jangan membuang sequence delta sebelum diterapkan ke book |
| Frame gateway ke UI | 100 ms | Adaptif sampai 250 ms ketika backpressure |
| Trade bubble bucket | 250 ms | Sama price bucket dan aggressor side |
| Time bucket heatmap default | 1 detik | Pilihan 1s, 5s, 15s, 1m, 5m |
| Price bucket display | 1 tick pada zoom dekat | Agregasi adaptif saat jumlah row melebihi pixel vertikal |
| Analytics fast window | 5 detik | Delta, trade rate, imbalance |
| Analytics medium window | 30 detik | Momentum, baseline volume, CVD slope |
| Trend confirmation | 3 frame analytics | Hysteresis masuk 65, keluar 50 |

Order book tetap menyimpan level asli. Price bucketing hanya terjadi pada frame visual atau data turunan, bukan pada canonical state.

## 6. Retensi default

Retensi teknis setelah izin penggunaan data disetujui:

| Data | Hot storage | Archive | Catatan |
|---|---:|---:|---|
| Raw depth delta | 14 hari | sampai 30 hari | Terkompresi, akses terbatas |
| Depth snapshot | 30 hari | 90 hari | Interval snapshot ditetapkan setelah benchmark storage |
| Raw trades | 90 hari | 365 hari | Dibutuhkan untuk evaluasi bubble/delta |
| Agregasi 1 detik | 365 hari | opsional | Query replay utama |
| Agregasi 1 menit | 3 tahun | opsional | Analytics jangka panjang |
| Alert dan versi sinyal | 365 hari | 3 tahun | Tanpa data pribadi berlebih |
| Synthetic fixtures | permanen | repository | Tidak berasal dari market live |

Sebelum izin penyimpanan/redistribusi jelas, raw live capture hanya boleh disimpan sementara maksimal 24 jam pada environment engineering yang dibatasi akses, tidak boleh masuk repository, dan tidak boleh diberikan kepada pengguna eksternal.

## 7. Default visual

- Rentang waktu awal: 30 detik saat session baru, dapat diperluas pengguna.
- Depth terlihat: 80 level per sisi.
- Heatmap: percentile/log normalization dalam viewport.
- Bubble: akar kuadrat volume relatif terhadap median rolling.
- Warna bukan satu-satunya pembeda; bubble memiliki arah/outline.
- Status stale harus menutupi sinyal tanpa menyembunyikan data terakhir.

## 8. Batas beta

Beta pertama dianggap berhasil jika pengguna dapat:

1. membuka BTCUSDT dan memahami status kualitas data;
2. melihat liquidity wall dan executed trades tanpa UI freeze;
3. memeriksa alasan trend score;
4. melakukan replay kondisi pasar yang sama dengan hasil deterministik;
5. menerima alert yang tidak berulang tanpa cooldown.

Multi-exchange, trading ladder, akun broker, dan order execution tidak masuk beta pertama.
