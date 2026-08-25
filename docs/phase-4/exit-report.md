# Laporan Exit Fase 4 — Multi-Symbol Beta

Tanggal: 25 Agustus 2026
Status: **CONDITIONAL EXIT**

## Ringkasan

Fase 4 mengubah gateway dari single-market menjadi market-session manager yang
mendukung BTCUSDT, ETHUSDT, dan SOLUSDT perpetual secara bersamaan. Setiap
simbol memiliki gateway, order book, analytics, dan projection history yang
sepenuhnya terisolasi; sesi dibuat lazily saat client pertama subscribe dan
dihentikan otomatis setelah client terakhir pergi.

## Yang diselesaikan

### Backend
- **Market-session manager** (`server/marketSessionManager.ts`): refcounting
  per klien, eviction TTL ketika refcount 0, batas `maxSessions`, seam
  `register()` untuk sesi default, `drain()` untuk graceful shutdown semua
  sesi (flush history/capture), serta hook `disposeGateway`.
- **Registry instrumen** (`server/instruments.ts`): metadata tick size
  BTCUSDT (0.1), ETHUSDT (0.01), SOLUSDT (0.01) + normalisasi simbol; siap
  diganti discovery dinamis via exchangeInfo tanpa mengubah call site.
- **Integrasi HTTP/WS** (`server/httpServer.ts`): routing frame per simbol,
  langganan multi-simbol per koneksi dengan batas
  `XBMAP_MAX_SUBSCRIPTIONS_PER_CLIENT` (default 3), error wire baru
  (`SUBSCRIPTION_LIMIT`, `SESSION_CAPACITY`, `SYMBOL_NOT_ACTIVE`),
  `/api/v1/markets` dari registry, `?symbol=` pada snapshot/history/settings,
  readiness yang mengagregasi seluruh sesi aktif, dan mode lama single-gateway
  tetap didukung penuh (adapter `SingleSymbolSessions`) sehingga 36 file test
  lama tidak berubah.
- **Observability**: `scopedHooks()` memberi label metrik Prometheus
  per-simbol untuk setiap gateway; health `/api/v1/health` memuat ringkasan
  sesi.
- **Penyimpanan per-simbol**: `historyPersistenceFromEnvironment`
  menamespace direktori history/backup per simbol (`<root>/<symbol>/`)
  sehingga segmen, rollup, dan manifest backup tidak pernah tercampur.
- **Startup** (`server/index.ts`): manager dibangun dengan persistence per
  simbol + hooks terlabel; sesi default BTCUSDT dimulai saat boot.

### Frontend
- **Symbol picker** (`src/components/SymbolPicker.tsx`): pencarian simbol,
  watchlist persisten (localStorage `liquidmap.watchlist`), toggle bintang,
  navigasi keyboard; pergantian simbol tanpa reload — koneksi WS di-resubscribe
  oleh `marketDataClient.setSelection()`.
- **Buffer bersih saat ganti simbol**: `useMarketData.setSelection` mengosongkan
  depth/trade/price buffer sehingga tidak ada frame simbol lama yang tersisa.
- **Tick size & format harga dinamis** dari metadata instrumen (menghapus
  hardcode `tickSize: 0.1` dan ternary `priceDecimals`).

### Pengujian & pengukuran
- `server/__tests__/multiSymbol.test.ts` (5 test): isolasi frame antarsimbol,
  tanpa kebocoran simbol lama setelah switch, batas subscription tanpa
  refcount bocor, pelepasan referensi saat disconnect, REST registry +
  snapshot per simbol.
- `src/lib/useMarketData.test.tsx`: ganti simbol membersihkan buffer dan
  mengirim unsubscribe/subscribe yang benar.
- `scripts/phase4/run.ts` (`npm run phase4:validate`): lifecycle evict/rebuild,
  budget CPU/RSS proses untuk 3 sesi demo simultan, dan isolasi book — hasil
  terdokumentasi di `docs/baselines/phase-4-validation.{json,md}`.
- Total suite: 37 file / 169 test hijau; typecheck dan build produksi lulus.

## Konfigurasi baru

| Variabel | Default | Keterangan |
|---|---:|---|
| `XBMAP_MAX_SESSIONS` | `8` | Batas sesi pasar simultan |
| `XBMAP_SESSION_IDLE_TTL_MS` | `300000` | Usia idle sebelum sesi dihentikan |
| `XBMAP_MAX_SUBSCRIPTIONS_PER_CLIENT` | `3` | Batas simbol per koneksi WS |

## Kriteria fase vs status

| Kriteria | Status |
|---|---|
| Perpindahan simbol tanpa reload | ✅ terpenuhi (picker + resubscribe + clear buffer) |
| Tidak ada frame simbol lama setelah subscribe baru | ✅ teruji (routing server + clear klien) |
| Tick size & format harga selalu benar | ✅ dari registry instrumen |
| Tiga simbol bersamaan dalam target performa | ⚠️ sintetis/demo terukur; live network belum |
| Subscription tanpa klien berhenti / hemat sumber daya | ✅ eviction TTL + dispose flush |

## Gate terbuka (alasan CONDITIONAL EXIT)

1. **Validasi performa 3 simbol live** pada jaringan Binance stabil (event rate
   ETH/SOL lebih tinggi daripada demo); butuh akses jaringan produksi.
2. **Verifikasi FPS/latensi pada perangkat fisik minimum** dengan 3 stream
   bergantian — menyatu dengan gate perangkat fisik Fase 0/3.
3. **Replay multi-simbol**: raw replay runtime masih satu simbol per katalog;
   pemilihan dataset historis lintas simbol di UI ditunda ke iterasi berikutnya.
