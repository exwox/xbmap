# ADR 0002: Canonical event schema and versioning

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Market-data and frontend engineering

## Context

Feed exchange, order-book engine, WebSocket, REST history, dan replay perlu
berbicara dengan istilah dan unit yang sama. MVP sudah mengirim envelope dengan
`schemaVersion: 1`, tetapi tipe payload server masih `unknown`, input client tidak
memvalidasi versi, dan sequence transport bercampur dengan counter pembuatan
event global.

## Decision

LiquidMap memakai satu model domain kanonis setelah adapter exchange:

- `DepthSnapshot` untuk baseline book;
- `DepthUpdate` untuk delta berurutan;
- `NormalizedTrade` untuk executed trade dan aggressor side;
- derived events `depth_frame`, `trade_bucket`, `price`, `metric`, dan
  `trend_signal` untuk consumer realtime;
- control events `status`, `heartbeat`, `error`, `subscribed`, dan
  `unsubscribed` tidak menjadi market facts.

Kontrak wire v1 yang benar-benar berjalan dibekukan dan didokumentasikan di
[event-schema-v1.md](../architecture/event-schema-v1.md). Dokumen itu adalah
sumber kebenaran selama tipe runtime/schema validation belum dihasilkan dari
satu package bersama.

### Units and identity

- Semua timestamp wire adalah UTC Unix epoch milliseconds berupa JSON number.
- Ordering depth ditentukan oleh exchange sequence, bukan timestamp.
- Harga dan quantity pada wire adalah number; adapter boleh menerima string
  numerik dari exchange. Mesin book mengubah harga menjadi integer tick sebelum
  compare/update.
- Quantity adalah base-asset quantity; nilai `0` hanya bermakna delete pada
  depth delta.
- `side` pada trade adalah aggressor side: `buy` mengambil ask dan `sell`
  mengambil bid.
- `exchange` adalah venue logis, sedangkan `data.source` adalah provenance
  (`binance` atau `demo`).

### Sequence domains

Tiga domain tidak boleh disamakan:

1. **Book sequence**: `lastUpdateId`, `sequenceStart`, `sequenceEnd`, dan
   `previousSequence`; satu-satunya dasar untuk order-book correctness.
2. **Delivery sequence**: counter kontinu per subscription/connection yang
   dapat membuktikan event hilang pada jalur tersebut.
3. **Event identity**: identifier unik/idempotency key untuk persistence.

Field envelope `sequence` v1 saat ini hanya merupakan counter pembuatan envelope
global per proses. Ia bukan delivery sequence dan bukan book sequence. Hingga
field `streamId` + `deliverySequence` ditambahkan, consumer tidak boleh memakai
gap pada `sequence` sebagai bukti book corrupt. Snapshot recovery harus mengacu
pada book sequence atau explicit data-quality state.

`streamId` dan `deliverySequence` boleh ditambahkan sebagai field optional v1
karena additive. Mengubah arti field `sequence` yang sudah ada dilarang; jika
consumer wajib bergantung pada semantik baru, gunakan schema v2.

### Compatibility policy

- `schemaVersion` adalah integer major version.
- Perubahan additive berupa field optional atau event type baru dapat tetap v1.
  Consumer harus mengabaikan field/event yang tidak dikenali.
- Menghapus/rename field, mengubah unit/arti, mempersempit domain nilai, atau
  mengubah required/optional adalah breaking dan memerlukan v2.
- Event enum baru tidak boleh membuat koneksi ditutup; consumer boleh mencatat
  dan mengabaikannya.
- Producer v2 harus tersedia paralel melalui `/api/v2` dan subprotocol/path WS
  yang eksplisit selama migration window. Tidak ada silent negotiation.
- Client harus mengirim versi yang didukung dan server harus menolak versi yang
  tidak didukung dengan error terstruktur.
- Schema storage menyimpan `schema_version`, `adapter_version`, dan
  `analytics_version`; perubahan algoritma analytics tidak menulis ulang fakta
  raw.
- Contract tests wajib dijalankan producer dan consumer untuk setiap perubahan.

## Consequences

- Adapter venue menanggung translasi simbol, timestamp, maker/taker, dan
  sequence exchange sebelum data masuk ke book/analytics.
- Frontend tidak perlu memahami payload Binance.
- Persistence dapat menyimpan raw bytes untuk audit sekaligus event kanonis
  untuk query.
- Version migration membutuhkan dual-read/dual-serve terukur, tetapi mencegah
  perubahan arti data secara diam-diam.

## Current gaps

- `ServerEnvelope<T>` mengizinkan `data: unknown`; belum ada discriminated union
  per event atau runtime JSON schema.
- Inbound WebSocket mengabaikan `schemaVersion` dan `market`. Bentuk message
  hanya diperiksa sebagian.
- Internal `DepthSnapshot`, `DepthUpdate`, dan `NormalizedTrade` belum membawa
  `schemaVersion`, `eventId`, `adapterVersion`, atau capture metadata.
- `sequence` global dikonsumsi oleh REST snapshot dan response khusus klien,
  sehingga tidak kontinu bagi klien mana pun. Frontend saat ini tetap
  memperlakukannya sebagai delivery sequence dan dapat meminta snapshot palsu.
- `replay_frame` tercantum dalam enum server tetapi tidak memiliki producer,
  payload, atau consumer v1.
- Frontend menerima alias legacy (`trade`, `metrics`, `trend`, `pong`) yang tidak
  pernah diproduksi server; toleransi ini bukan jaminan producer contract.

