# Architecture Decision Records

Direktori ini mencatat keputusan arsitektur yang disepakati untuk membawa
LiquidMap dari MVP satu simbol menuju beta. ADR bersifat append-only: keputusan
yang berubah tidak ditulis ulang diam-diam, tetapi digantikan oleh ADR baru yang
menautkan keputusan sebelumnya.

## Status

| ADR | Keputusan | Status |
|---|---|---|
| [0001](./0001-initial-market-scope.md) | Pengguna, venue, market, dan simbol beta pertama | Accepted |
| [0002](./0002-canonical-event-schema-versioning.md) | Schema event kanonis dan kebijakan versioning | Accepted |
| [0003](./0003-storage-topology.md) | PostgreSQL, ClickHouse, object storage, dan komponen yang ditunda | Accepted |
| [0004](./0004-rendering-performance-strategy.md) | Strategi render dan batas migrasi Canvas/WebGL | Accepted |
| [0005](./0005-data-correctness-and-replay.md) | Aturan order-book correctness dan replay deterministik | Accepted |

Kontrak yang benar-benar diimplementasikan saat ADR ini dibuat dijelaskan di
[Event Schema v1](../architecture/event-schema-v1.md). Bagian "Current gaps" di
setiap ADR membedakan keputusan target dari kondisi kode saat ini.

Angka operasional dan keputusan produk pendukung dicatat di
[Phase 0](../phase-0/README.md), terutama target kualitas, parameter market,
retensi, evaluasi trend, dan review penggunaan data exchange.

## Konvensi

- **Accepted** berarti menjadi default untuk implementasi berikutnya.
- **Proposed** berarti belum boleh dianggap sebagai kontrak.
- **Superseded** harus menyebut ADR penggantinya.
- Perubahan wire contract yang breaking memerlukan ADR baru dan versi schema
  baru.
- Timestamp pada dokumen ini menggunakan UTC epoch milliseconds, kecuali jika
  disebutkan lain.
