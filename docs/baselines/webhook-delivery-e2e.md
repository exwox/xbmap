# Bukti E2E Delivery Webhook Alert

Tanggal: 2026-08-25 · Lingkungan: lokal, feed DEMO (Binance diblokir DNS ISP).

## Setup
- Gateway `XBMAP_DEMO=1`, `XBMAP_ALERT_WEBHOOK_URL=http://127.0.0.1:8910/hook`
- Rules file memuat satu aturan `trend_score > 5` (scope semua simbol, cooldown 30s)
- Mock receiver HTTP di 127.0.0.1:8910 mencatat setiap POST

## Hasil
- POST pertama diterima receiver **5 detik** setelah gateway start.
- Payload lengkap sesuai kontrak: alertId/ruleId/kind/symbol/value/threshold/reason/algoVersion=`alerts-v1`/shadow=false.
- Audit trail (`/api/v1/alerts/events`) berurutan benar:
  `triggered → delivered(webhook) → suppressed_cooldown ×N`.

## Interpretasi
Jalur delivery webhook **terbukti end-to-end**. Yang tersisa untuk menutup
gate Fase 5: uji ulang dengan penyedia eksternal nyata (Telegram bot atau
webhook publik) dari jaringan yang tidak memblokir Binance.
