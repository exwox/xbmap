# Papan Status Gate Eksternal

Terakhir diperbarui: 2026-08-25.
Setiap gate: cara menjalankan · status saat ini · bukti.

## 🔴 Blokir Jaringan (akar masalah)

```
$ getent hosts fstream.binance.com
175.111.112.37  internet-sehat.bbt.co.id
```
DNS ISP (**Internet Sehat — BBT**) memetakan semua domain Binance ke filter
kontennya, sehingga koneksi gagal total. **Dampak**: seluruh gate "live"
tertahan sampai salah satu dari:
1. Whitelist `*.binance.com` di panel ISP/router, atau ganti DNS (1.1.1.1/8.8.8.8);
2. Jalankan gateway di VPS luar negeri (`docker compose up` sudah siap);
3. Tunnel SSH/WireGuard ke mesin dengan akses bersih.

## Status per Gate

| Gate | Cara eksekusi | Status |
|---|---|---|
| F1 Soak 8 jam | `npm run phase1:soak:full` | 🟡 **BERJALAN** sejak 2026-08-25 (background, pid di `.local-run/soak8.pid`, log `soak8.log`) — feed demo; ulangi sekali lagi di jaringan live untuk edge-case Binance |
| F3 Soak 24 jam | `npm run phase3:soak24` | ⛔ belum dieksekusi (jalankan setelah soak 8h sukses) |
| F3 Load test multi-klien | `npm run phase3:loadtest` | ✅ **PASS** — 25 klien, 25.989 frame, 0 error → [`../baselines/phase-3-loadtest.md`](../baselines/phase-3-loadtest.md) |
| F5 Delivery webhook | gateway + mock receiver lokal | ✅ **E2E PASS** (5s, audit benar) → [`../baselines/webhook-delivery-e2e.md`](../baselines/webhook-delivery-e2e.md); sisa: provider eksternal nyata |
| F0/F4 Event-rate & performa 3 simbol LIVE | jalankan gateway tanpa `XBMAP_DEMO` pada jaringan bersih; `npm run measure:live` | ⛔ diblokir DNS (lihat atas) |
| F0/F3/F4 FPS & p95 perangkat fisik | `npm run dev` → buka di perangkat target, `?benchmark=renderer` | ⛔ butuh manusia + perangkat fisik |
| F2 SLO replay-start <3s di deployment nyata | deploy Docker pada VPS, ukur seek | ⛔ butuh VPS |
| F5 Kalibrasi baseline alert | shadow mode berhari-hari di jaringan bersih, tinjau `/api/v1/signals/performance` | ⛔ tertahan blokir DNS |
| F0/F5 Legal ToS/lisensi capture & likuidasi | review eksternal | ⛔ proses hukum |

## 🔓 Temuan 25 Agu: Blokir HANYA di Level DNS

Probe end-to-end dari mesin lokal (IP riil via AliDNS-DoH):
```
fstream.binance.com via 35.74.124.67 → TLS valid (verify=0), GET / = 404 (normal)
api.binance.com     via 13.249.239.121 → /api/v3/ping = 200
fapi.binance.com    via 65.8.76.4      → /fapi/v1/ping = 200
```
**Tidak ada blokiran IP/SNI** — cukup pinning `/etc/hosts`:

```
# Binance real IPs (cek ulang berkala; pool AWS Tokyo berotasi)
35.74.124.67   fstream.binance.com
54.150.3.201   fstream.binance.com
13.249.239.121 api.binance.com
65.8.76.4      fapi.binance.com
```

Verifikasi setelah pinning: `getent hosts fstream.binance.com` → IP riil,
lalu jalankan gateway tanpa `XBMAP_DEMO`.

Catatan penting:
- A-record `fstream` TTL=1 (pool Global Accelerator AWS ap-northeast-1 yang
  berotasi). Bila suatu saat kembali gagal, ambil daftar IP terbaru via
  `https://dns.alidns.com/resolve?name=fstream.binance.com&type=A`.
- Kepatuhan: domain Binance diblokir atas regulasi lokal (Bappebti/Kominfo);
  akses pasca-bypass adalah keputusan & risiko pengguna — evaluasi ToS
  exchange dan aturan yang berlaku. Untuk infrastruktur produksi, VPS luar
  negeri tetap opsi paling bersih.

## Checklist eksekusi ketika jaringan bersih tersedia
1. `npm run measure:live` (jam normal & volatil) → simpan ke `docs/baselines/`.
2. Gateway live + `XBMAP_REQUIRE_AUTH=1 XBMAP_ALERT_SHADOW=1` ≥72 jam → ekspor performance rows → kalibrasi multiplier.
3. Ulangi `phase3:loadtest` dan load test 3-simbol serentak → bandingkan dengan baseline offline.
4. Tutup checkbox gate yang terkait + lampirkan bukti di dokumen ini.
