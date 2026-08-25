# Phase 0 synthetic performance baseline

> Preliminary synthetic baseline. No Binance or other external network was used. These values are saturation and synchronous-processing measurements, not live-market event rates, browser FPS, or event-to-screen latency.

Generated: 2026-08-24T14:17:39.115Z  
Profile: `baseline`  
Seed: `1480744257`  
Command: `node --expose-gc --import tsx scripts/bench/run.ts --profile baseline --seed 1480744257 --json docs/baselines/phase-0-synthetic-benchmark.json --markdown docs/baselines/phase-0-synthetic-benchmark.md`

## Environment

| Field | Value |
|---|---|
| Host | `HP-348-G4` |
| OS | `linux 7.0.0-30-generic` |
| Architecture | `x64` |
| Node / V8 | `v24.19.0` / `13.6.233.17-node.51` |
| tsx / TypeScript | `4.23.12` / `5.9.3` |
| CPU | Intel(R) Core(TM) i7-7500U CPU @ 2.70GHz |
| Logical CPUs visible | 4 |
| Reported CPU speed | 3028 MHz |
| Host memory | 7216.62 MiB |
| cgroup CPU limit | `not exposed` |
| cgroup memory limit | `not exposed` |
| GC exposed | yes |
| Repository revision | `unavailable (.git revision metadata not mounted)` |
| Source fingerprint (SHA-256) | `2310f028ef8e1ad9447817b47ec260918dd7a505738135fcee260a101c8bf019` |
| Timezone | `Asia/Jakarta` |

The host allocation and current load affect these numbers. Repeat on the future minimum supported device before setting product release gates.

## Configuration and methodology

- 3 measured rounds per scenario, after scenario-specific warm-up.
- Order book: 200 levels per side; 100,000 eight-level sequenced deltas per round.
- Analytics: full 30,000-trade and CVD rings; 300 computes per round.
- Gateway: 300 synthetic 100 ms cycles per round, each with 10 depth deltas and 30 trades, plus one 80-level client serialization.
- Client: actual metadata-read plus normalization path for a 3,533-byte, 80-level/side JSON frame.
- Throughput passes do not take a timestamp around every operation. Latency percentiles come from separate warmed passes using `process.hrtime.bigint()`.
- Synthetic input-object construction is included in each operation; network decoding is not included except in the explicit client wire scenario.
- CPU is process user + system time divided by wall time. It can exceed 100% because `process.cpuUsage()` includes Node/V8 helper-thread work such as parallel GC. Memory is process-level RSS/heap sampled during each synchronous pass; retained heap is sampled after an explicit GC.

## Results

| Scenario | Aggregate throughput | p50 latency (us) | p95 latency (us) | p99 latency (us) | CPU / wall | Peak RSS (MiB) | Peak heap (MiB) |
|---|---:|---:|---:|---:|---:|---:|---:|
| order_book_apply_delta_8_levels | 147,964.67 depth updates/s | 5.15 | 12.18 | 24.33 | 107.5% | 102.23 | 16.96 |
| analytics_compute_full_ring | 123.65 analytics frames/s | 7,402.15 | 11,339.84 | 14,268.08 | 101.0% | 273.67 | 126.79 |
| gateway_one_client_pipeline | 634.70 100ms gateway cycles/s | 878.57 | 1,967.13 | 3,387.44 | 111.7% | 252.54 | 80.89 |
| client_wire_metadata_and_normalization | 11,013.66 wire depth frames/s | 75.58 | 159.74 | 177.18 | 104.1% | 270.80 | 84.36 |

The gateway throughput unit is one full synthetic 100 ms cycle. Its aggregate input processing rate is 25,388.12 synthetic market events/s. This is a saturation figure with one serialized client, not a supported live event rate.

## Estimated WebSocket frame load

The modeled stream is 10 frame cycles/s, 100 depth deltas/s, and 300 trades/s. The gateway aggregates these into outbound envelopes. Estimates include JSON UTF-8 bytes and the unmasked server WebSocket frame header; per-message compression is disabled in production.

| Depth levels/side | Messages/s | JSON KiB/s | WS KiB/s | WS Mbit/s | One-off snapshot KiB |
|---:|---:|---:|---:|---:|---:|
| 20 | 69.33 | 32.26 | 32.53 | 0.2665 | 0.99 |
| 80 | 69.33 | 56.71 | 56.98 | 0.4668 | 3.28 |
| 200 | 69.33 | 105.48 | 105.75 | 0.8663 | 8.07 |

Default 80-level client by event type:

| Event | Messages/s | Mean JSON bytes | p95 JSON bytes | WS KiB/s |
|---|---:|---:|---:|---:|
| depth_frame | 10.00 | 3,676.30 | 3,899.05 | 35.94 |
| heartbeat | 0.07 | 222.00 | 222.00 | 0.01 |
| metric | 10.00 | 479.02 | 496.00 | 4.72 |
| price | 19.27 | 236.38 | 242.00 | 4.52 |
| trade_bucket | 20.00 | 444.28 | 475.00 | 8.76 |
| trend_signal | 10.00 | 306.60 | 307.00 | 3.03 |

Linear egress-only fanout estimate for the default 80-level subscription:

| Clients | Depth levels/side | Aggregate WS Mbit/s |
|---:|---:|---:|
| 1 | 80 | 0.4668 |
| 10 | 80 | 4.6681 |
| 100 | 80 | 46.6810 |

This excludes TCP/IP, TLS, reverse proxies, retransmission, client-to-server traffic, and the CPU/kernel cost of real sockets. Startup subscription/snapshot traffic is shown separately and is not included in steady-state bytes/s.

## Implementation audit

- OrderBook.applyUpdate performs crossed-book validation by scanning both maps for best prices on every accepted delta.
- OrderBook.getLevels sorts complete maps; each gateway frame calls it for depth output and analytics imbalance calls it again.
- AnalyticsEngine.compute copies and filters the full trade ring and copies the full CVD ring on every frame; volume ratio also builds and sorts temporary collections.
- The gateway builds 200 levels/side before the WebSocket layer trims each client independently; JSON serialization is repeated for every client.
- The browser transport parses each string envelope once for sequence metadata and again during normalization.
- The app retains up to 1,800 depth frames and exposes a fresh RingBuffer array on every depth event; at 80 levels/side that is up to 288,000 retained level objects traversed by heatmap preparation/drawing.
- Canvas work is requestAnimationFrame-scheduled, but a new data reference schedules redraws at the 10 Hz gateway frame rate; actual FPS still depends on viewport, DPR, browser, and device.

## Per-round CPU, wall time, and memory

Negative memory deltas mean GC released allocations made before the measured pass. RSS is allocator/process-level and can remain high after heap collection.

| Scenario | Round | Ops/s | Wall ms | CPU ms | CPU / wall | RSS delta MiB | Heap delta MiB | Retained heap delta MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| order_book_apply_delta_8_levels | 1 | 144,590.83 | 691.61 | 764.64 | 110.6% | 7.86 | 4.43 | -0.00 |
| order_book_apply_delta_8_levels | 2 | 149,083.30 | 670.77 | 707.86 | 105.5% | -0.03 | 5.77 | 0.03 |
| order_book_apply_delta_8_levels | 3 | 150,344.73 | 665.14 | 706.06 | 106.2% | 0.07 | 1.34 | 0.04 |
| analytics_compute_full_ring | 1 | 123.62 | 2,426.90 | 2,468.66 | 101.7% | 27.46 | 31.82 | 0.02 |
| analytics_compute_full_ring | 2 | 121.03 | 2,478.66 | 2,499.27 | 100.8% | 11.85 | 18.64 | 0.06 |
| analytics_compute_full_ring | 3 | 126.41 | 2,373.20 | 2,382.21 | 100.4% | 96.04 | 82.28 | 0.00 |
| gateway_one_client_pipeline | 1 | 608.06 | 493.37 | 559.40 | 113.4% | 0.13 | 58.80 | 11.15 |
| gateway_one_client_pipeline | 2 | 611.34 | 490.73 | 544.24 | 110.9% | 0.10 | 53.57 | 11.11 |
| gateway_one_client_pipeline | 3 | 691.43 | 433.88 | 480.87 | 110.8% | 0.00 | 53.56 | 11.11 |
| client_wire_metadata_and_normalization | 1 | 10,825.07 | 1,847.56 | 1,957.41 | 105.9% | -0.13 | 29.39 | 0.07 |
| client_wire_metadata_and_normalization | 2 | 11,006.84 | 1,817.05 | 1,875.28 | 103.2% | 0.26 | 29.10 | 0.01 |
| client_wire_metadata_and_normalization | 3 | 11,216.00 | 1,783.17 | 1,838.33 | 103.1% | -0.64 | 27.57 | 0.00 |

## What remains before Phase 0 performance targets are final

- Real Binance event rates in quiet, trending, and volatile periods
- Exchange-to-gateway, gateway-to-browser, and event-to-screen network latency
- Browser Canvas sudah diukur pada host referensi; pengulangan pada minimum
  supported physical device dan visible/hardware-accelerated browser masih wajib
- Actual WebSocket fanout CPU, kernel socket buffers, TLS, proxies, packet overhead, and slow clients
- Long-running RSS/heap behavior, garbage-collection pauses, reconnect, and sequence-gap recovery

## Interpretation and next actions

1. Treat this file as a regression baseline for core hot paths on this exact environment, not as a beta SLO.
2. Capture real exchange traffic for quiet, trending, volatile, and reconnect regimes; replay it through the same production paths.
3. Repeat the browser harness on the agreed minimum physical device for Canvas FPS, frame time p95/p99, long tasks, and memory; the reference-host 1,800-frame result is in `phase-0-browser-renderer.md`.
4. Load-test actual WebSocket connections at 1, 10, and 100 clients, including a slow consumer and backpressure behavior.
5. Profile repeated book sorting/scanning, analytics full-ring copies, per-client serialization, and the client's double JSON parse before optimizing.

## Caveats

- Every measured market event is deterministic and synthetic; no external network or exchange connection is used.
- Throughput is a saturation result on one Node.js process, not a production capacity promise.
- Latency is synchronous processing time, not event-to-screen latency; per-operation timing uses process.hrtime.bigint().
- WebSocket byte estimates include uncompressed JSON payload and the server-to-client WebSocket frame header only.
- Fanout bandwidth is a linear estimate; the harness does not create sockets or measure per-client send CPU.
- Compare regressions only with the same profile, seed, runtime flags, machine allocation, and similarly idle host.
