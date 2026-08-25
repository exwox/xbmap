# Backlog Prioritas Setelah Fase 0

Status: disepakati untuk masuk perencanaan sprint  
Skala estimasi: S (<= 2 hari), M (3-5 hari), L (1-2 minggu)

## P0 — release blocker beta

| ID | Item | Estimasi | Dependensi | Acceptance ringkas |
|---|---|---:|---|---|
| DATA-001 | Raw feed recorder | M | Compliance gate | Capture terkompresi, bounded, tanpa secret |
| DATA-002 | Golden replay + state checksum | M | Fixtures | State dan sinyal identik setiap replay |
| DATA-003 | Atomic order-book resync | M | DATA-002 | Client tidak melihat partial/invalid book |
| DATA-004 | Gap/duplicate/out-of-order counters | S | Schema metrics | Semua failure mode memiliki counter |
| DATA-005 | Clock-drift monitor | S | Timestamp contract | Drift dilaporkan per symbol/source |
| DATA-006 | Metadata instrument discovery | M | Binance exchange info | Tick/step tidak hardcoded di production |
| DATA-007 | Routed WebSocket endpoint migration | S | Official API docs | Adapter memakai path resmi dan diuji |
| STORE-001 | ClickHouse schema + migration | L | ADR storage, legal gate | Depth/trade tersimpan dan queryable |
| STORE-002 | Snapshot/delta retention job | M | STORE-001 | Retention berjalan tanpa ingestion stall |
| STORE-003 | Backup/restore drill | M | STORE-001 | Restore fixture dan checksum berhasil |
| OBS-001 | OpenTelemetry + Prometheus metrics | L | Metrics catalog | Jalur ingestion sampai WS terlihat |
| OBS-002 | Data-quality dashboard | M | OBS-001 | Gap, stale, drift, resync terlihat |
| PERF-001 | Load profiles normal/busy/burst | M | Benchmark harness | Hasil reproducible dan machine-readable |
| PERF-002 | Soak test 8/24 jam | M | OBS-001 | Tidak ada unbounded memory growth |
| UI-001 | Error boundary chart/dashboard | S | Tidak ada | Fatal render memberi recovery action |
| UI-002 | Data-quality reason panel | S | DATA-004 | Pengguna memahami degraded state |
| SEC-001 | CSP, container scan, rate-limit review | M | Deployment target | Tidak ada high-severity finding |
| LEGAL-001 | API terms dan redistribution clearance | eksternal | Operator entity | External beta mendapat keputusan tertulis |

## P1 — beta feature

| ID | Item | Estimasi | Dependensi |
|---|---|---:|---|
| MARKET-001 | Market-session manager | L | DATA/OBS P0 |
| MARKET-002 | ETHUSDT adapter/config | M | MARKET-001, metadata discovery |
| MARKET-003 | SOLUSDT adapter/config | M | MARKET-001, metadata discovery |
| UI-101 | Symbol search dan watchlist | M | MARKET-001 |
| UI-102 | Workspace persistence | M | Auth/config storage |
| FLOW-101 | Liquidity persistence | M | Persistent depth |
| FLOW-102 | Added/pulled liquidity | M | FLOW-101 |
| FLOW-103 | Absorption/exhaustion | L | Persistent trade + depth |
| ALERT-101 | Alert state machine + cooldown | M | Signal versioning |
| ALERT-102 | Browser notification/sound | S | ALERT-101 |
| PRODUCT-101 | Guided onboarding | M | Stable UI |

## P2 — setelah beta stabil

- multi-exchange normalization;
- footprint chart dan volume profile lengkap;
- DOM/trading ladder;
- Telegram/webhook alert;
- desktop wrapper;
- long-horizon backtesting;
- broker connectivity;
- order execution sebagai program keamanan dan kepatuhan terpisah.

## Urutan sprint berikutnya

1. DATA-001 sampai DATA-007.
2. OBS-001 dan OBS-002.
3. PERF-001, lalu PERF-002.
4. STORE-001 sampai STORE-003 setelah LEGAL-001 menjelaskan retensi yang diizinkan.
5. UI-001, UI-002, SEC-001.
6. Baru mulai MARKET dan FLOW P1.

Tidak ada item P1 yang boleh menurunkan prioritas kebenaran data, recovery, atau observability.
