# Phase 0 market regression fixtures

Empat scenario sintetis dan deterministik tersedia di direktori ini:

| Scenario | Fokus |
|---|---|
| `calm` | book seimbang dan trend netral |
| `strong-uptrend` | flow bullish dan konfirmasi sinyal |
| `high-volatility` | whipsaw, flow berganti arah, dan hysteresis |
| `reconnect-sequence-gap` | gap, duplicate, reconnect, resync, dan data quality |

Setiap `*.events.jsonl` memiliki manifest dengan SHA-256, hasil sequence,
fingerprint final book, statistik trade, checkpoint analytics/trend, dan outcome
recovery. [`index.json`](./index.json) mengunci checksum seluruh set.

Data ini bukan capture exchange. File dihasilkan dari source di
[`scripts/fixtures`](../../scripts/fixtures/README.md) dan tidak boleh diedit
manual.

```bash
npm run phase0:fixtures
```
