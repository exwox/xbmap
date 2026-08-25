# Offline synthetic benchmark

This harness exercises LiquidMap's production order-book, analytics, gateway,
WebSocket serialization, and browser wire-normalization code without starting
an HTTP server or connecting to an exchange.

Run the reproducible baseline profile from the repository root:

```bash
node --expose-gc --import tsx scripts/bench/run.ts \
  --profile baseline \
  --seed 1480744257 \
  --json docs/baselines/phase-0-synthetic-benchmark.json \
  --markdown docs/baselines/phase-0-synthetic-benchmark.md
```

For a fast smoke run that does not overwrite the checked-in baseline:

```bash
node --expose-gc --import tsx scripts/bench/run.ts --profile quick
```

Validate the benchmark source itself with:

```bash
npx tsc -p scripts/bench/tsconfig.json --noEmit
```

The `baseline` profile performs three rounds. Each microbenchmark has a warm-up
pass, a throughput pass without per-operation timers, and a separate latency
sampling pass. The gateway scenario models 100 depth deltas/s, 300 trades/s,
and a 10 Hz frame clock, then serializes the exact production envelopes for one
80-level client. Payload estimates include the uncompressed server-to-client
WebSocket frame header but exclude TCP/IP, TLS, proxies, retransmission, and
client-to-server traffic.

All inputs are deterministic and synthetic. These results are useful for
regression comparison on the same machine; they are not measurements of
Binance traffic, browser FPS, or exchange-to-screen latency.
