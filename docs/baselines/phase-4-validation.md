# Phase 4 validation report

Generated: 2026-08-25T06:06:41.153Z

| Case | Result | Duration ms | Assertions |
|---|---|---:|---:|
| session-lifecycle | PASS | 646.657 | 7/7 |
| resource-budget-3-symbols | PASS | 1978.893 | 3/3 |
| book-isolation | PASS | 723.618 | 5/5 |

Summary: 3 passed, 0 failed

## session-lifecycle

- note: evicted=all

## resource-budget-3-symbols

- **sampleMs**: `1500`
- **symbols**: `[{"symbol":"BTCUSDT","tickSize":0.1,"running":true,"lastEventTimestamp":1787638000381,"resyncs":0,"crossedBooks":0},{"symbol":"ETHUSDT","tickSize":0.01,"running":true,"lastEventTimestamp":1787638000418,"resyncs":0,"crossedBooks":0},{"symbol":"SOLUSDT","tickSize":0.01,"running":true,"lastEventTimestamp":1787638000330,"resyncs":0,"crossedBooks":0}]`
- **process**: `{"rssDeltaBytes":131072,"rssBytes":93769728,"cpuMs":300.4,"cpuMsPerSymbolPerSecond":66.75}`
- note: synthetic demo feeds; production budgets require the live-network gate

## book-isolation

- **btcTickSize**: `0.1`
- **ethTickSize**: `0.01`
- **registryEthTick**: `0.01`
- note: isolation enforced by per-symbol gateway instances with independent order books

