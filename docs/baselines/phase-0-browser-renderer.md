# Phase 0 browser renderer baseline

> Reference-host synthetic renderer measurement. It is not a Binance event-rate measurement and does not certify the agreed minimum device.

Generated: 2026-08-24T14:27:46.735Z  
Kind: `headless-chrome-renderer-synthetic-stress`  
Command: `node --import tsx scripts/browser/measure-renderer.ts --duration 12 --target-frames 1800 --seed 1480744257`

## Environment

| Field | Value |
|---|---|
| Host | `HP-348-G4` |
| OS | `linux 7.0.0-30-generic` |
| CPU | Intel(R) Core(TM) i7-7500U CPU @ 2.70GHz |
| Logical CPUs | 4 |
| Host memory | 7216.62 MiB |
| Browser | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36 |
| Browser viewport | 1366×681, DPR 1 |
| WebGL renderer | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) |

## Workload

- Deterministic seed: `1480744257`.
- Browser demo input cadence: 100 ms (synthetic stress).
- Warm-up target: 1800 depth frames; reached: yes in 0.4 s.
- Retained window at sample end: 1800 depth frames, 937 trade buckets, 1800 price points.
- Canvas CSS/backing size: 1027×586 / 1027×586 at DPR 1.
- Measured duration: 12.05 s.

## Results

| Metric | Result | Reference check |
|---|---:|---:|
| Animation frame rate | 17.01 FPS | FAIL >= 30 FPS |
| Frame interval p95 / p99 | 116.70 / 133.40 ms | diagnostic |
| Frame intervals > 25 ms | 60.00% | diagnostic |
| Market-layer draw rate | 9.54 draw/s | diagnostic |
| Market-layer draw p50 / p95 / p99 | 33.00 / 50.46 / 63.75 ms | FAIL p95 < 25 ms |
| Local input-to-paint p50 / p95 / p99 | 45.00 / 70.30 / 105.48 ms | PASS p95 < 150 ms |
| Long tasks (>50 ms) | 115 | FAIL none during sample |
| Main-thread task ratio | 87.32% | diagnostic |
| JavaScript heap start / end / delta | 19.01 MiB / 23.83 MiB / 4.81 MiB | short-run diagnostic |
| Runtime errors | 0 | PASS none |

## Interpretation

This run exercises the real production React and Canvas code with the full 1,800-frame client buffer and deterministic 10 Hz redraw/input cadence. It measures browser animation cadence, synchronous market-layer draw time, local input-to-paint delay, long tasks, and short-run heap behavior.

It is deliberately a stress workload, not a claim about Binance traffic. Headless Chrome and the listed GPU renderer may differ from a visible browser. The beta release gate still requires a repeat on the agreed minimum physical device, a normal-rate live/replay workload, and a long soak for memory growth.
