# Percobaan Pengukuran Live Binance

Tanggal: 24 Agustus 2026 14:07:25 UTC  
Environment: Linux x64, Node.js v24.19.0  
Status: **tidak berhasil — diblokir jaringan environment**

## Perintah

```bash
npx tsx scripts/live/measure-binance.ts --duration 8 --handshake-timeout 5000
```

## Endpoint resmi yang diuji

- Depth: `wss://fstream.binance.com/public/ws/btcusdt@depth@100ms`
- Trade: `wss://fstream.binance.com/market/ws/btcusdt@aggTrade`

## Hasil

| Stream | Socket terbuka | Pesan | Error |
|---|---:|---:|---|
| Depth | Tidak | 0 | `ECONNREFUSED 175.111.112.37:443` |
| Trade | Tidak | 0 | `ECONNREFUSED 175.111.112.37:443` |

Durasi observasi 8,117 detik. Kedua socket ditutup dengan code 1006 dan tidak menghasilkan sample latency maupun event-rate.

## Interpretasi

Angka `0 event/s` **bukan** karakteristik Binance dan tidak boleh dipakai sebagai baseline kapasitas. Environment eksekusi tidak dapat mencapai endpoint tersebut. Pengukuran normal/volatile harus diulang dari staging atau host produksi dengan egress langsung yang diizinkan.

Script pengukuran sudah disediakan agar percobaan dapat direproduksi tanpa perubahan kode. Minimum capture yang diterima untuk menutup Fase 0:

- 30 menit kondisi normal untuk setiap simbol beta;
- minimal satu jendela volatil 15 menit, atau capture saat trade-rate mencapai percentile 95 dari observasi 24 jam;
- simpan hanya hasil agregat event-rate/bytes/latency sampai legal clearance untuk raw capture tersedia.

## Command produksi yang direkomendasikan

```bash
npm run measure:live -- --duration 1800 --symbol BTCUSDT
```

Ulangi untuk `ETHUSDT` dan `SOLUSDT`. Jangan menjalankan beberapa collector yang tidak diperlukan karena setiap koneksi menambah beban dan harus mematuhi batas Binance.
