# phase-2 validation baseline

Dihasilkan otomatis oleh `phase-2:validate` — jangan edit manual.

| Case | Result | Duration ms | Assertions |
|---|---|---:|---:|
| history-persists-after-restart | PASS | 1160.638 | 4/4 |
| bounded-history-query | PASS | 216.214 | 7/7 |
| history-backup-restore | PASS | 265.273 | 4/4 |
| retention-concurrent-with-ingestion | PASS | 69.557 | 8/8 |
| one-hour-replay-startup | PASS | 615.535 | 3/3 |
| speed-and-seek-invariant-replay-checksum | PASS | 2120.728 | 10/10 |
| replay-session-checkpoint-restart | PASS | 595.528 | 9/9 |

Summary: 7 passed, 0 failed.
