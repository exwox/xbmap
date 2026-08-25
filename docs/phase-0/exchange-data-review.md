# Review Awal Penggunaan Data Binance

Tanggal pemeriksaan: 24 Agustus 2026  
Status: **bersyarat — belum merupakan legal clearance**

Dokumen ini adalah engineering risk review, bukan nasihat hukum. Ketentuan yang berlaku dapat berbeda berdasarkan badan hukum, akun, negara pengguna, dan deployment LiquidMap.

## Sumber resmi yang diperiksa

- [Binance Developer Documentation](https://developers.binance.com/en/docs/introduction)
- [USDⓈ-M Futures General Info](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info)
- [USDⓈ-M WebSocket Market Streams](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Connect)
- [Local Order Book Procedure](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly)
- [Binance Terms of Use yang disajikan pada pemeriksaan](https://www.binance.com/en/terms)

## Temuan teknis

- Dokumentasi resmi menyatakan API dapat dipakai untuk market data, dashboard, analytics, dan reporting.
- USDⓈ-M menggunakan timestamp milidetik.
- Endpoint production REST yang didokumentasikan adalah `https://fapi.binance.com`.
- Endpoint WebSocket futures saat ini memiliki routed path `public`, `market`, dan `private`.
- Koneksi WebSocket hanya berlaku 24 jam dan harus siap disconnect.
- Server mengirim ping setiap tiga menit dan mengharapkan pong sebelum batas yang didokumentasikan.
- Batas incoming message adalah 10 pesan/detik per connection dan maksimal 1.024 stream per connection.
- Prosedur resmi local book mensyaratkan buffer stream, ambil snapshot, cocokkan `U/u`, lalu validasi `pu` terhadap `u` sebelumnya.

## Temuan lisensi/ToS

Terms yang muncul pada pemeriksaan bertanggal efektif 21 Juli 2026 dan merujuk pada badan hukum ADGM. Dokumen tersebut:

- menyatakan akses Binance API tunduk pada separate API terms dan approval;
- memberi lisensi Binance IP untuk non-commercial personal atau internal business use, kecuali ada ketentuan lain;
- tidak memberikan izin redistribusi market data yang jelas dalam teks yang ditemukan;
- mengizinkan perubahan ketentuan dari waktu ke waktu.

Terms tersebut belum cukup untuk menyimpulkan bahwa raw depth/trade boleh disimpan lama, dijual, atau didistribusikan ulang dalam produk publik. Tidak ditemukannya larangan eksplisit bukanlah izin.

## Keputusan Fase 0

1. Pengembangan internal dan fixture sintetis dapat dilanjutkan.
2. Raw live capture tidak boleh masuk Git atau dibagikan ke pengguna eksternal.
3. Sampai clearance tersedia, raw live capture dibatasi 24 jam, terenkripsi, dan hanya dapat diakses engineer yang membutuhkan.
4. External/paid beta yang menampilkan atau mengirim ulang data Binance diblokir sampai applicable terms diidentifikasi dan izin penggunaan/redistribusi dikonfirmasi.
5. Produk harus menampilkan attribution sumber data dan disclaimer data dapat terlambat/tidak lengkap.
6. Rate limit, reconnect 24 jam, ping/pong, serta update documentation monitoring masuk P0.

## Gate sebelum beta eksternal

- identifikasi Binance contracting entity yang berlaku bagi operator LiquidMap;
- peroleh dan arsipkan separate API terms yang berlaku;
- minta konfirmasi tertulis atau market-data license untuk penyimpanan serta redistribusi;
- review counsel mengenai negara operasi dan negara target pengguna;
- tetapkan attribution, retention, dan takedown procedure;
- jadwalkan review ToS setiap kuartal dan saat change notice diterbitkan.

Owner: Product/Legal  
Due: sebelum beta eksternal  
Status sekarang: `BLOCK_EXTERNAL_BETA`, tidak memblokir engineering internal.
