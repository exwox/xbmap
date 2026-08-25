# Laporan Exit Fase 5 — Analytics Lanjutan dan Alert

Tanggal: 25 Agustus 2026
Status: **CONDITIONAL EXIT**

## Ringkasan

Fase 5 menambahkan lapisan analitik order-flow lanjutan dan mesin alert yang
dapat dikonfigurasi pengguna. Semuanya dibangun sebagai state machine murni
yang dikonsumsi dari aliran event gateway, sehingga **insight dapat
direproduksi secara byte-identik dari replay** (kriteria selesai fase).

## Yang diselesaikan

### Analytics (`server/insights/insightEngine.ts`, algo `insights-v1`)
- **Rolling VWAP** 60 detik dari bucket trade (quote/base ring).
- **Liquidity wall**: level ≥ 6× median kuantitas top-book, terkonfirmasi
  setelah persistensi ≥1,5 detik; transisi appeared/disappeared diekspor
  untuk alert.
- **Added/pulled liquidity** per sisi via diffing book penuh antar-frame.
- **Absorption**: flow berat dalam 5 detik dengan pergerakan mid ≤3 tick;
  arah bullish/bearish dari delta dominan.
- **Exhaustion**: tren aktif yang kehilangan ≥30% trade rate.
- **Volume profile** dengan POC + distribusi node; **footprint** buy/sell per
  level harga.
- **Funding rate & open interest** (`server/feeds/binanceDerivatives.ts`,
  poller REST dengan fetch injektif; offline → stale tanpa crash).
- **Liquidation feed** opt-in (`XBMAP_LIQUIDATIONS=1`), agregat 60 detik.

### Alert (`server/alerts/alertEngine.ts`, algo `alerts-v1`)
- Empat jenis aturan: trend score, liquidity wall (muncul/hilang), volume
  delta, trade velocity — scope per simbol atau semua.
- **Baseline threshold per simbol**: median berjalan (min 30 sampel) ×
  multiplier, bukan angka universal; mode absolute tetap tersedia.
- **Cooldown + deduplication**, **shadow mode** (`XBMAP_ALERT_SHADOW=1`;
  evaluasi tetap jalan, delivery ditahan).
- **Audit log** bounded: created / updated / deleted / triggered / delivered /
  delivery_failed / suppressed_* — tersedia via `/api/v1/alerts/events`.
- **Evaluasi sinyal** horizon 10s/30s/1m/5m: precision, favorable/adverse
  excursion (MFE/MAE), segmentasi simbol + jam UTC + bucket volatilitas,
  versi algoritma pada tiap sinyal — endpoint
  `/api/v1/signals/performance`.
- **Delivery channel**: WS selalu; webhook dan Telegram opsional via env.

### Integrasi & UI
- Event WS baru `insight` (1×/detik per sesi) dan `alert`; hanya klien yang
  subscribe simbol tersebut yang menerimanya.
- REST: CRUD `/api/v1/alerts/rules`, `/api/v1/alerts/events`,
  `/api/v1/signals/performance`, snapshot `/api/v1/insights?symbol=`.
- Frontend: drawer **AlertsPanel** (daftar aturan + toggle + hapus, form buat
  aturan dengan baseline/multiplier atau nilai mutlak, feed terpicu, badge
  bell, notifikasi browser + beep WebAudio) dan kartu Market Insights
  (VWAP, funding, OI, POC, dinding terbesar, likuidasi).

## Kriteria fase vs status

| Kriteria | Status |
|---|---|
| Setiap sinyal menampilkan alasan & versi algoritma | ✅ field `reason` + `algoVersion` di semua payload |
| Tidak ada alert berulang tanpa cooldown | ✅ diuji unit + validasi skrip |
| Evaluasi dapat direproduksi dari replay | ✅ determinisme byte-identik tervalidasi |
| Threshold baseline per simbol | ✅ median berjalan per (simbol, metrik) |

## Verifikasi

- Suite penuh: typecheck bersih; **40 file / 184 test hijau**
  (termasuk 12 test baru insight+alert dan 3 test permukaan WS/REST).
- `npm run phase5:validate` → 3/3 PASS
  (insights-determinism, alert-cooldown-shadow, signal-horizons); artefak di
  `docs/baselines/phase-5-validation.{json,md}`.

## Gate terbuka

1. **Kalibrasi live**: baseline statistik butuh jam-jam data Binance nyata
   sebelum multiplier default dianggap bermakna; jalankan shadow mode lebih
   dulu di produksi.
2. **Liquidation feed lisensi/ToS**: koneksi `!forceOrder@arr` sudah ter-wire
   penuh (opt-in `XBMAP_LIQUIDATIONS=1`, socket injektif teruji); tetap
   nonaktif by default sampai review legal selesai.
3. **Webhook/Telegram belum diuji end-to-end** dengan penyedia eksternal
   (butuh token nyata); kontrak sudah tercakup lewat fetch injektif.
