# Phase 5 validation report

Generated: 2026-08-25T17:36:50.553Z

| Case | Result | Duration ms | Assertions |
|---|---|---:|---:|
| insights-determinism | PASS | 29 | 1/1 |
| alert-cooldown-shadow | PASS | 3 | 5/5 |
| signal-horizons | PASS | 1 | 5/5 |

Summary: 3 passed, 0 failed

## insights-determinism

- **frameBytes**: `930`
- note: satisfies 'evaluasi dapat direproduksi dari replay' at the analytics layer

## alert-cooldown-shadow

- **algoVersion**: `"alerts-v1"`
- **horizonsMs**: `[10000,30000,60000,300000]`
- note: no repeated alerts without cooldown; shadow keeps evaluation but withholds delivery

## signal-horizons

- **rows**: `[{"horizonMs":10000,"resolved":1,"precision":1,"mfeBps":500,"hourUtc":0,"volBucket":"low"},{"horizonMs":10000,"resolved":1,"precision":1,"mfeBps":500,"hourUtc":0,"volBucket":"low"},{"horizonMs":30000,"resolved":1,"precision":1,"mfeBps":500,"hourUtc":0,"volBucket":"low"},{"horizonMs":30000,"resolved":1,"precision":1,"mfeBps":500,"hourUtc":0,"volBucket":"low"},{"horizonMs":60000,"resolved":1,"precision":1,"mfeBps":500,"hourUtc":0,"volBucket":"low"},{"horizonMs":60000,"resolved":1,"precision":1,"mfeBps":500,"hourUtc":0,"volBucket":"low"},{"horizonMs":300000,"resolved":1,"precision":1,"mfeBps":500,"hourUtc":0,"volBucket":"low"},{"horizonMs":300000,"resolved":1,"precision":1,"mfeBps":500,"hourUtc":0,"volBucket":"low"}]`
- note: precision/recall/MFE/MAE segmented per simbol, jam UTC, dan bucket volatilitas

