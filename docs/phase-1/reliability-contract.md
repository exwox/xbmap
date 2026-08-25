# Kontrak Reliability Fase 1

Kontrak ini menetapkan kapan data boleh dipakai oleh heatmap, analytics, dan
trend signal. Status transport dan validitas order book adalah dua hal berbeda.

## State dan atomic handoff

```text
connecting -> syncing -> valid
                    \-> invalid/stale -> syncing -> valid
                                             \-> closed
```

- `transportAlive` hanya menyatakan transport depth dan trade tersedia.
- `marketActive` menyatakan event market masih diterima dalam batas waktu.
- `synchronized` hanya benar setelah snapshot dan seluruh delta buffered lolos
  validasi urutan.
- `frozen` wajib benar untuk state selain `valid`.
- snapshot kandidat dibangun pada instance book terpisah. Gateway mengganti
  book aktif hanya setelah kandidat lengkap tervalidasi.
- pergantian source atau generasi feed menerbitkan `market_reset`; analytics,
  bucket trade, dan signal lama direset sebelum sesi baru dinyatakan valid.
- endpoint snapshot mengembalikan `503 BOOK_NOT_READY` bila book tidak valid.

Frontend tidak mengaktifkan signal hanya karena WebSocket tersambung. Signal
yang pernah dihitung disembunyikan selama status `syncing`, `invalid`, `stale`,
`closed`, `frozen`, atau market tidak aktif.

## Sequence dan delivery

Ordering depth memakai `U/u/pu` venue, bukan timestamp dan bukan envelope
`sequence`. Setiap anomali memiliki counter terpisah:

- `sequenceGaps`;
- `duplicates`;
- `outOfOrder`;
- `malformedEvents`;
- `crossedBooks`;
- `resyncs`;
- `queueOverflows`.

`sequence` pada envelope tetap merupakan counter global gateway dan hanya
bersifat informasional. WebSocket menambahkan `streamId` per koneksi dan
`deliverySequence` yang kontinu untuk koneksi tersebut. Frontend hanya
mendeteksi delivery gap jika kedua field tersedia; lompatan global `sequence`
tidak boleh memicu false resync.

Envelope pemicu delivery gap, duplicate, atau posisi yang mundur tidak diteruskan
ke projection UI. Setelah gap, browser hanya membuka freeze setelah menerima
snapshot pada stream yang sama lalu status dengan seluruh proof eksplisit:
`validity=valid`, transport dan market aktif, synchronized, serta tidak frozen.

## Fingerprint

`OrderBook.fingerprint()` menghitung SHA-256 atas tick size, `lastUpdateId`, dan
seluruh level bid/ask dalam urutan kanonik. `checkpoint()` menambahkan jumlah
level dan top-of-book agar hasil replay dapat diaudit tanpa membandingkan object
besar. Fingerprint tidak memasukkan wall clock atau process id.

## Queue dan backpressure

- Buffer delta selama rekonsiliasi dibatasi; overflow membatalkan kandidat dan
  memicu resync, bukan menumbuhkan heap tanpa batas.
- Queue raw recorder dibatasi berdasarkan jumlah record dan byte. Penolakan
  tercatat sebagai drop/overflow dan membuat manifest capture tidak lengkap.
- WebSocket client yang lambat melewati soft limit dapat kehilangan derived
  frame yang aman diganti oleh frame berikutnya; hard limit menutup koneksi
  dengan code `1013`.

## Shutdown

Shutdown menghentikan ingress terlebih dahulu, menyelesaikan bucket trade yang
lengkap, menerbitkan state `closed`, lalu mem-flush recorder sebelum HTTP dan
WebSocket ditutup. Timeout process tetap menjadi pengaman terakhir, bukan jalur
shutdown normal.
