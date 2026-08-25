# ADR 0001: Initial market scope

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Product and market-data engineering

## Context

LiquidMap perlu memperoleh baseline correctness dan performa pada ruang lingkup
yang sempit sebelum menambah exchange atau eksekusi order. Implementasi saat ini
adalah vertical slice Binance USD-M Futures untuk `BTCUSDT`, dengan fallback
data sintetis. UI, metadata instrument, dan tick size masih mengasumsikan simbol
tersebut pada beberapa lokasi.

## Decision

Pengguna pertama adalah **scalper dan day trader crypto perpetual** yang memakai
order flow untuk analisis jangka pendek.

Ruang lingkup beta adalah:

- satu venue: Binance USD-M Futures;
- satu jenis market: linear USDT-margined perpetual;
- allowlist simbol beta: `BTCUSDT`, `ETHUSDT`, lalu `SOLUSDT`;
- onboarding berurutan: `BTCUSDT` harus lulus correctness, load, dan soak gate
  sebelum `ETHUSDT`; dua simbol itu harus lulus sebelum `SOLUSDT`;
- aplikasi read-only untuk visualisasi dan alert; tidak menerima API key, tidak
  menempatkan order, dan tidak menjanjikan hasil trading;
- tidak ada agregasi lintas exchange pada beta pertama.

`exchange` dan `symbol` pada kontrak selalu memakai identifier kanonis huruf
kecil untuk exchange (`binance`) dan huruf besar tanpa separator untuk simbol
(`BTCUSDT`). Label presentasi seperti `BTC/USDT Perpetual` tidak boleh menjadi
identifier data.

Tick size, quantity step, dan precision harus berasal dari metadata instrument
exchange sebelum suatu simbol diaktifkan. Nilai `0.1` dan `0.001` yang sekarang
dipakai untuk BTC tidak boleh disalin ke ETH atau SOL tanpa discovery.

Target perangkat beta adalah desktop 64-bit dengan CPU empat logical core kelas
Intel Core i5/Ryzen 5 tahun 2019 atau setara, RAM 8 GiB (minimal 1 GiB tersedia
untuk browser), integrated GPU dengan Canvas 2D hardware acceleration, dan layar
minimal 1366×768. Browser target adalah dua versi stabil terbaru Chrome, Edge,
atau Firefox; Safari menyusul setelah beta desktop stabil. Jaringan acceptance
memiliki bandwidth 10 Mbps, packet loss < 1%, dan RTT ke gateway < 150 ms. DPR
render dibatasi 2.25 seperti implementasi sekarang. Release harus mencatat
browser, OS, CPU, GPU, RAM, resolusi, DPR, serta kondisi jaringan perangkat
benchmark; nama "desktop modern" saja bukan bukti kelulusan.

## Non-goals

- spot, inverse/coin-margined futures, options, atau delivery futures;
- native mobile application;
- broker routing, copy trading, automation, atau order execution;
- rekomendasi finansial;
- multi-exchange normalization sebelum beta single-venue stabil.

## Consequences

- Session manager multi-symbol tetap diperlukan, tetapi kompleksitas perbedaan
  venue ditunda.
- Metric dan threshold harus dievaluasi per simbol; baseline BTC tidak otomatis
  valid untuk ETH/SOL.
- Gangguan Binance dapat menghentikan mode live. Feed demo harus selalu diberi
  label dan tidak boleh dicampur dengan capture live.
- Review ToS, lisensi, penyimpanan, dan redistribusi data Binance adalah release
  gate terpisah; ADR ini tidak menyatakan persetujuan hukum.

## Acceptance gates per symbol

Simbol hanya berstatus beta-enabled ketika:

1. metadata tick/quantity precision berasal dari instrument discovery;
2. snapshot dan delta replay menghasilkan fingerprint order book yang sama;
3. gap, duplicate, out-of-order, malformed event, reconnect, dan resync sudah
   diuji;
4. event-to-screen p95 < 150 ms, gateway processing p95 < 50 ms, dan UI >= 30
   FPS pada perangkat target;
5. soak test minimum delapan jam tidak menunjukkan pertumbuhan memori tak
   terbatas;
6. ketentuan penggunaan data telah disetujui untuk environment tersebut.

## Current gaps

- Gateway dan UI hanya benar-benar mendukung `BTCUSDT`.
- `GET /api/v1/markets` memiliki `displaySymbol` dan `quantityStep` hardcoded
  untuk BTC.
- `App.tsx` hanya mendaftarkan metadata BTC dan memilih precision dengan cabang
  khusus BTC/non-BTC.
- Gateway memakai default tick size `0.1`; belum ada instrument discovery atau
  session manager per simbol.
- Fallback server mengubah sumber menjadi `demo` sambil envelope tetap memakai
  exchange `binance`; ini benar hanya jika `source` dipahami sebagai provenance,
  bukan venue.
