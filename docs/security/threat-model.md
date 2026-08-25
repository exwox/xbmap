# Threat Model — LiquidMap Gateway & Terminal

Terakhir diperbarui: 25 Agustus 2026 (Fase 6 fondasi).
Metode: STRIDE per permukaan. Status: ✅ mitigasi ada · 🟡 parsial · ⛔ belum.

## Permukaan & Mitigasi

| # | Ancaman (STRIDE) | Vektor | Mitigasi saat ini | Status |
|---|---|---|---|---|
| 1 | Spoofing kredensial | Brute force `/auth/login` | Lockout per akun (5 gagal → 300s), rate limit IP 240/menit, password scrypt+salt, compare constant-time | ✅ |
| 2 | Pencurian sesi | XSS / sniffing | Cookie `HttpOnly` + `SameSite=Lax` (+`Secure` di HTTPS), CSP ketat tanpa inline-script, token opaque 256-bit | ✅ |
| 3 | Repudiasi aksi alert | "Bukan saya yang buat" | Audit log bounded (`/api/v1/alerts/events`) mencatat created/updated/deleted/triggered/delivered | ✅ |
| 4 | Info disclosure metrik | Scanning `/metrics` | Guard `XBMAP_ADMIN_TOKEN`; tanpa token hanya layak di localhost | 🟡 (token opsional; wajibkan di produksi) |
| 5 | Tampering workspace/rule pengguna lain | Manipulasi ID/cookie | Workspace dikunci ke username sesi; rute admin butuh role `admin`; store memvalidasi kepemilikan | ✅ |
| 6 | Elevation of privilege | Viewer → admin endpoint | Middleware role-check pada seluruh `/api/v1/admin/*` & PATCH flags | ✅ |
| 7 | DoS ingestion | Flood WS/API | Bounded queue + backpressure (1013), batas subscription/koneksi, rate limit, maxPayload WS | ✅ |
| 8 | DoS storage | Workspace/rules raksasa | Batas body 64kb, retention history, queue bytes cap | 🟡 (cap ukuran file store belum) |
| 9 | Supply chain | Dependency berbahaya | Dependency minim (express/ws/pg), CI lockfile install; scanning otomatis belum | 🟡 |
| 10 | Spoofing feed exchange | Data palsu via MITM | Validasi sequence/checksum book, TLS pinning belum; fallback demo terdokumentasi | 🟡 |

## Out of scope / Planned
- Secret manager terpusat (env masih dipakai) — item Fase 6.
- Rate limit berbasis pengguna (saat ini per-IP) — menyusul setelah multi-user stabil.
- Audit trail untuk login/logout (hanya alert yang diaudit sekarang).

## Catatan operasional
- Jalankan dengan `XBMAP_REQUIRE_AUTH=1`, `XBMAP_ADMIN_PASSWORD` kuat, dan
  `XBMAP_ADMIN_TOKEN` berbeda dari password admin.
- Terapkan HTTPS di reverse proxy; cookie otomatis mendapat flag `Secure`
  melalui deteksi `x-forwarded-proto`.
