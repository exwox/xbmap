# ADR 0005: Data correctness and deterministic replay

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Market-data and quality engineering

## Context

Heatmap dan trend signal hanya berguna jika local order book dapat dibuktikan
benar. MVP telah memvalidasi Binance `U/u/pu`, menolak crossed book, melakukan
resync, dan menyediakan event-clock replay di browser. Namun server replay hanya
memutar derived history 1 detik, tidak menyimpan raw depth, dan belum menghitung
fingerprint state. Correctness harus ditentukan sebagai invariant yang dapat
diuji, bukan sekadar status koneksi "live".

## Decision

Raw capture yang lengkap adalah input audit. Order book, aggregation, metric,
dan signal adalah deterministic projections dengan versi algoritma eksplisit.

### Order-book state machine

Satu market session hanya boleh berada pada salah satu state:

```text
CONNECTING -> BUFFERING -> SNAPSHOT_LOADING -> RECONCILING -> VALID
      ^                                                |
      +-------------- RESYNC_REQUIRED <---------------+
```

Aturan wajib:

1. Buka incremental stream dan buffer depth update sebelum mengambil snapshot.
2. Validasi snapshot: `lastUpdateId` safe integer non-negatif; price/quantity
   finite; price > 0; snapshot quantity > 0; book tidak crossed.
3. Buang delta dengan `sequenceEnd <= lastUpdateId` snapshot.
4. Delta pertama harus bridge snapshot. Sesuai engine saat ini:
   `sequenceStart <= lastUpdateId + 1` dan
   `sequenceEnd >= lastUpdateId + 1`.
5. Setelah bridge, jika `previousSequence` ada, nilainya harus sama dengan
   current `lastUpdateId`; jika tidak ada, `sequenceStart` tidak boleh lebih dari
   `lastUpdateId + 1`.
6. `sequenceEnd <= current lastUpdateId` adalah duplicate/pre-snapshot dan boleh
   diabaikan secara terukur. Gap, malformed update, buffer overflow, atau update
   yang membuat book crossed memindahkan session ke `RESYNC_REQUIRED`.
7. Price disimpan sebagai integer tick; bid keluar descending, ask ascending;
   quantity `0` hanya menghapus level pada delta.
8. Update diterapkan atomically. Jika validasi akhir gagal, price levels dan
   `lastUpdateId` tetap seperti sebelum update.
9. State lama tidak boleh dipublikasikan sebagai valid selama resync. Client
   menerima explicit invalid/syncing state, kemudian satu reconciled snapshot
   atomik sebelum derived frame/signal baru.
10. Analytics dan trend harus reset/freeze ketika source, symbol, algorithm
    version, atau validity epoch berubah. Signal invalid selalu `active=false`.

Timestamp tidak menentukan ordering depth. Clock drift dicatat sebagai metric,
tetapi sequence venue dan capture ordinal tetap sumber urutan. Trade dengan
timestamp sama mempertahankan capture order.

### Fingerprint

Setelah snapshot reconcile dan pada checkpoint replay, hitung fingerprint dari:

- venue, symbol, tick size, validity epoch, dan `lastUpdateId`;
- seluruh bid sebagai `(priceTicks, canonicalQuantity)` descending;
- seluruh ask sebagai `(priceTicks, canonicalQuantity)` ascending;
- schema dan adapter version.

Serialization harus byte-stable dan hash algorithm diberi nama/version. Derived
analytics memiliki fingerprint terpisah yang juga memasukkan analytics version
dan state (CVD, rolling windows, trend hysteresis). Hash book tidak dicampur
dengan wall-clock atau server process id.

### Replay contract

Replay correctness berarti:

1. input adalah raw snapshot/depth/trade capture beserta capture ordinal;
2. replay memakai event clock dari capture, bukan `Date.now()`;
3. adapter/schema/analytics version dipin pada manifest;
4. event dengan timestamp sama diproses menurut capture ordinal;
5. tidak ada random, network fetch, locale, atau wall-clock di projection;
6. final book fingerprint dan checkpoint fingerprint sama pada pengulangan,
   mesin, serta speed 0.25×–20×;
7. seek dimulai dari snapshot/checkpoint valid sebelum target, lalu menerapkan
   seluruh delta sampai target; seek bukan melompat langsung ke derived metric;
8. output frame order stabil. Replay speed hanya mengubah scheduling delivery,
   bukan perhitungan atau urutan;
9. incomplete capture ditolak atau jelas berstatus degraded; tidak boleh
   menghasilkan signal seolah dataset lengkap.

Dataset regression minimum mencakup kondisi tenang, trend kuat, volatilitas
tinggi/burst, duplicate/out-of-order/gap, disconnect ketika snapshot diambil,
dan reconnect/resync. Golden expected result menyimpan checkpoint sequence,
fingerprint, metric, signal, dan expected data-quality transition.

### Failure policy

- Tidak ada silent gap. Counter gap, duplicate, out-of-order, malformed,
  crossed-book, buffer overflow, resync count/duration, dan clock drift wajib
  terlihat di telemetry.
- Backpressure pada derived client frames tidak membatalkan correctness book
  gateway. Backpressure pada raw recorder harus menghentikan status "complete"
  capture dan mengaktifkan alarm; raw loss tidak boleh disembunyikan.
- Demo dan live memiliki validity epoch terpisah. Keduanya tidak boleh berada
  dalam satu replay manifest tanpa explicit source-transition record.
- Recovery browser meminta reconciled snapshot dan mengganti state book secara
  atomik; ia tidak mencoba mengisi raw depth gap dari derived frame.

## Consequences

- Replay bukan sekadar fitur UI, tetapi test harness untuk adapter, book,
  analytics, dan migrations.
- Raw capture membutuhkan storage dan retention ADR 0003.
- Perubahan formula trend memerlukan analytics version dan golden-output baru,
  bukan modifikasi capture lama.
- Snapshot/checkpoint mempercepat seek dengan tetap mempertahankan audit trail.

## Implementation status after Phase 2

Sudah diterapkan:

- raw gzip NDJSON recorder opt-in dengan `captureSequence`, bounded queue,
  checksum, manifest lengkap/incomplete, retensi, dan graceful flush;
- explicit validity epoch, full-book SHA-256 fingerprint/checkpoint, counters
  anomaly, atomic candidate-book swap, clock drift, dan signal freeze;
- final reconciled snapshot saja yang keluar dari feed; stale connection
  generation tidak dapat memublikasikan snapshot parsial;
- delivery metadata per koneksi menggantikan asumsi bahwa global envelope
  `sequence` kontinu;
- recovery browser membuang envelope gap/duplicate/out-of-order, membersihkan
  buffer pada `market_reset`, dan menunggu snapshot diikuti status valid lengkap.

Tambahan Fase 2 yang sudah diterapkan:

- manifest raw capture memuat schema/adapter/analytics version, logical
  endpoints, close reason, dan exact checksums;
- raw catalog memvalidasi completeness, path containment, size/record bounds,
  capture order, serta mutasi byte;
- deterministic raw projection memakai production `OrderBook` dan menangani
  delta yang tiba sebelum snapshot;
- replay session memiliki source fingerprint, pause/resume/seek/speed, rolling
  checksum, bounded page, dan checkpoint persisten;
- metric history memakai fakta interval sehingga rollup tidak menjumlahkan
  rolling volume berulang.

Gap yang tersisa:

- seek delivery belum otomatis pre-roll dari snapshot/checkpoint valid sebelum
  target untuk menghasilkan full reconstructed book pada target;
- UI remote replay belum merender raw historical depth sebagai heatmap;
- analytics live masih memakai wall clock untuk rolling window; verifier raw
  membuktikan book/trade projection tetapi belum menjalankan seluruh signal
  engine memakai event clock;
- full soak delapan jam dan live licensed capture tetap gate operasional.
