# Raw Public-Feed Capture

Recorder Fase 1 bersifat opt-in. Tanpa `XBMAP_CAPTURE_DIR`, aplikasi tidak
membuka file capture dan perilaku runtime sama seperti sebelumnya.

## Mengaktifkan

```bash
XBMAP_CAPTURE_DIR=.liquidmap-captures npm run dev:server
```

Direktori yang dibuat recorder menggunakan mode `0700`; direktori yang sudah
ada tidak diubah permission-nya. Data dan manifest dibuat dengan mode `0600`.
Data disimpan sebagai gzip NDJSON. Setiap record menyimpan `captureSequence`
1-based yang kontinu, waktu terima, exchange, symbol, source, channel
(`snapshot`, `depth`, atau `trade`), identitas generasi koneksi, dan payload
upstream sebelum normalisasi.

Saat shutdown normal, queue diselesaikan dan stream gzip ditutup. Manifest
mencatat dua SHA-256: checksum exact file `.gz` dan checksum NDJSON
terdekompresi termasuk newline. Manifest dipublikasikan tanpa overwrite secara
atomik dan hanya berstatus lengkap jika tidak ada kegagalan I/O maupun record
yang ditolak.

## Batas default

| Batas | Default |
|---|---:|
| Queue record | 8.192 |
| Queue byte | 16 MiB |
| Raw byte per sesi | 512 MiB |
| Durasi capture | 24 jam |
| Retensi lokal | 24 jam |

Semua batas dapat diturunkan melalui variabel di `.env.example`. Durasi dan
retensi tetap di-cap 24 jam pada Fase 1. Jika queue atau batas sesi tercapai,
loss terlihat pada statistik dan capture tidak boleh dipakai sebagai golden
dataset lengkap.

## Keamanan dan lisensi

- Recorder hanya menerima public market data dan tidak membutuhkan API key.
- Direktori capture masuk `.gitignore` dan `.dockerignore`.
- Gunakan volume privat/persisten bila recorder berjalan di container.
- Jangan mempublikasikan capture sebelum hak penyimpanan dan redistribusi data
  exchange disetujui.
- Hapus capture yang tidak lagi diperlukan sesuai kebijakan retensi organisasi.

Capture ini merupakan input audit Fase 1, bukan storage historis produk. Object
storage, katalog dataset, migrasi, dan retention multi-tier berada di Fase 2.

Gap metadata yang masih disengaja pada Fase 1: endpoint upstream, versi adapter,
dan alasan disconnect belum menjadi field eksplisit capture. Informasi tersebut
harus ditambahkan sebelum capture dipromosikan menjadi format arsip lintas versi.
