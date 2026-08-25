# Phase 1 validation harness

This directory contains independent, deterministic validation tooling for the
Phase 1 data-correctness and reliability exit criteria. It imports production
market-data modules and the committed Phase 0 fixtures, but it does not mutate
application state or contact an exchange.

## Commands

Type-check and run the unit-level suite:

```sh
npx tsc -p scripts/phase1/tsconfig.json --noEmit
npx vitest run scripts/phase1/phase1.test.ts
```

Run the complete fault report (one JSON document on stdout):

```sh
node --import tsx scripts/phase1/run.ts
```

The disconnect case uses the production feed's `snapshotFetcher` and
`socketFactory` dependency seams. Its in-memory routed sockets exercise the
real feed state machine without opening a port or contacting the internet.

Run the five-second wall-clock smoke soak:

```sh
node --expose-gc --import tsx scripts/phase1/soak.ts --quick
```

Run the Phase 1 eight-hour wall-clock exit gate:

```sh
node --expose-gc --import tsx scripts/phase1/soak.ts --full
```

Run a custom wall-clock diagnostic:

```sh
node --expose-gc --import tsx scripts/phase1/soak.ts --duration 30m
```

`--full` is deliberately distinct from `--duration 8h`: only the former is
reported as `qualification: "eight-hour-exit-gate"`. Every mode reports
`wallClock: true`, the requested and actual duration, and
`acceleratedEventClock: false`; no accelerated workload is described as an
eight-hour soak.

## Coverage

| Case | Expected invariant |
|---|---|
| Lost sequence | Explicit `gap`; candidate does not mutate the book |
| Duplicate | Explicit `ignored`; fingerprint remains unchanged |
| Late/out of order | Ahead event is not silently accepted |
| Malformed | Invalid sequence/level is rejected without mutation |
| Crossed update | Update is rolled back atomically |
| Disconnect during snapshot | Stale generation publishes no partial state |
| Burst | At least 3x the Phase 0 400-event/s gateway profile |
| Replay | All committed captures reproduce golden outcomes and fingerprints |
| Soak | Bounded wall duration plus retained-heap slope/R²/monotonicity checks |

The current production `OrderBook.fingerprint()` and `checkpoint()` APIs are
used directly and cross-checked during replay. The adapter retains a canonical
SHA-256 compatibility path for older branches and always reports which source
was used; current reports must say `OrderBook.fingerprint`.

Quick soak is a smoke test only. Passing it does not satisfy the eight-hour
criterion. Full mode requires `--expose-gc` and fails when retained heap shows
a sustained positive trend above its configured growth and slope bounds.
