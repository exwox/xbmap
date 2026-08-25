# Kontrak replay Fase 2

## Raw capture sebagai source

Raw recorder menulis gzip NDJSON beserta manifest, exact compressed dan
uncompressed checksum, schema/adapter/analytics version, endpoint logis, serta
close reason. Katalog replay hanya membuka path di dalam capture root dan
menolak manifest incomplete, sequence tidak kontinu, size limit terlampaui,
atau checksum berubah.

Projection penuh memakai production `OrderBook`: depth yang datang sebelum
snapshot dibuffer, snapshot direconcile, lalu delta dan trade diterapkan dalam
capture order. Pengulangan capture yang sama menghasilkan checkpoint yang sama.

## Session

Raw replay session menyediakan lifecycle berikut:

- create dengan symbol, range, speed `0.25x`–`20x`, dan autoplay;
- pause/resume;
- seek timestamp;
- ubah speed tanpa mengubah urutan/checksum;
- page read dengan limit;
- delete dan expiry cleanup;
- checkpoint persisten dan restore setelah restart.

Session yang sedang playing dipulihkan sebagai paused pada committed playhead.
Rolling checksum memasukkan sequence serta checksum frame, sehingga invariant
terhadap speed dan ukuran page. Source fingerprint dipin saat session dibuat;
mutasi capture sesudahnya ditolak.

## REST API

Endpoint aktif hanya bila `XBMAP_CAPTURE_DIR` dikonfigurasi:

- `GET /api/v1/replay/raw/captures`
- `POST /api/v1/replay/raw/captures/:id/verify`
- `POST /api/v1/replay/raw/session`
- `GET|PATCH|DELETE /api/v1/replay/raw/session/:id`
- `GET /api/v1/replay/raw/session/:id/frames`

Response frame audit tidak mengekspos raw payload; hanya ordinal, stream,
timestamp, dan checksum. Batas range, verifikasi record, page size, serta rate
limit mencegah satu request menghabiskan memori server.

`GET /api/v1/history` dan replay derived lama sekarang membaca metric persisten
bila storage aktif, tetapi UI Replay masih memakai dataset lokal untuk heatmap.

## Batas seek saat ini

Seek raw session menentukan titik delivery pada/atau setelah target dan menjaga
checksum delivery deterministik. Projection verifier dapat membuktikan satu
capture penuh, tetapi endpoint seek belum melakukan pre-roll otomatis dari
snapshot valid sebelum target untuk mengembalikan full reconstructed book di
target. Integrasi UI historical heatmap harus menambahkan checkpoint/pre-roll
tersebut sebelum replay dipromosikan sebagai replay visual identik dengan live.
