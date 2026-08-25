# ADR 0004: Rendering and performance strategy

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Frontend visualization engineering

## Context

Renderer saat ini adalah Canvas 2D dependency-free. Ia sudah memisahkan market
layer dari overlay pointer, mengagregasi trade di gateway, membatasi depth, dan
memakai ring buffer. Namun setiap perubahan market masih dapat memindai banyak
depth cell dan membuat array React baru. Migrasi langsung ke WebGL tanpa baseline
akan menambah kompleksitas dan belum menjawab apakah bottleneck ada di network,
normalization, React state, preprocessing, atau draw calls.

## Decision

Pertahankan **Canvas 2D dua layer sebagai renderer beta awal**, lalu migrasikan
berdasarkan profiling, bukan berdasarkan perkiraan.

Pipeline render normatif:

```text
raw exchange events
  -> order book + trade aggregation (gateway)
  -> coalesced depth/metric frames
  -> bounded normalized buffers (client)
  -> viewport filtering + visual bucketing
  -> market canvas (heatmap/price/bubbles/axes)
  -> overlay canvas (crosshair/tooltip)
```

### Rules

- Raw exchange update tidak boleh memicu render. Gateway default mengirim market
  frame setiap 100 ms; configurable 50–1.000 ms.
- Main chart dan pointer overlay tetap pada canvas terpisah. Pointer move hanya
  menggambar overlay.
- Draw dijadwalkan dengan `requestAnimationFrame`; resize juga didebounce satu
  animation frame.
- Buffer harus bounded per market. Konfigurasi aplikasi saat ini adalah 1.800
  depth frame, 2.500 trade bucket, dan 3.000 price tick.
- Subscription depth dibatasi 10–200 level per side.
- DPR backing store dibatasi 2.25 untuk menahan memory/fill cost.
- Liquidity memakai log normalization terhadap percentile 97,5%, 22 intensity
  bins per side, dan batched path per warna.
- Bubble yang digambar disampling hingga sekitar 2.500 item terlihat dan radius
  dibatasi.
- Viewport filtering dan price/time bucketing dilakukan sebelum membuat draw
  primitive. Data di luar viewport tidak boleh menjadi draw call.
- Overload WebSocket boleh menurunkan fidelity derived frame, tetapi tidak boleh
  mengubah raw persistence atau menyamarkan status degraded.

### Performance gates

Pada perangkat target ADR 0001, dataset tenang, trend kuat, volatil, dan burst
harus memenuhi:

| Metric | Beta gate |
|---|---:|
| Event-to-screen latency p95, RTT < 50 ms | < 150 ms |
| Gateway processing latency p95 | < 50 ms |
| Gateway processing latency p99 | < 100 ms |
| UI frame rate | >= 30 FPS pada p95 session; target 60 |
| Long task (> 50 ms) during normal live view | < 1 per minute |
| Reconnect + valid book recovery p95 | < 10 detik |
| Browser heap, satu simbol setelah soak 8 jam | < 350 MiB |
| Unbounded heap growth during 8-hour soak | 0 |

Benchmark harus melaporkan jumlah input event, visible frame/level/cell/bubble,
canvas CSS/backing resolution, browser/hardware, dan p50/p95/p99; angka FPS tanpa
dataset dan perangkat tidak valid.

### Escalation path

Optimasi dilakukan dalam urutan berikut:

1. kurangi allocation dan hindari `toArray()`/full scan yang tidak perlu;
2. pre-bucket/cull data hanya untuk viewport dan reuse typed buffers;
3. pindahkan normalization/preprocessing ke Web Worker jika main-thread compute
   melewati 8 ms p95 per update;
4. pindahkan heatmap ke WebGL2 instancing/texture ketika Canvas market-layer draw
   tetap melewati 25 ms p95 atau UI gagal 30 FPS pada dataset gate;
5. pertimbangkan OffscreenCanvas hanya setelah dukungan browser target dan biaya
   transfer data diukur.

Axes, accessibility overlay, dan interaction dapat tetap Canvas 2D/DOM ketika
heatmap pindah ke WebGL. Tidak ada migrasi renderer yang boleh mengubah schema
market event.

## Backpressure and degradation

- `bufferedAmount` > 1 MiB saat ini membuang `depth_frame`, `metric`, dan `price`;
  `trade_bucket`, trend, status, dan control tetap dikirim.
- `bufferedAmount` > 8 MiB menutup client dengan code 1013.
- Strategi beta harus menandai degraded/drop count dan mengirim snapshot terbaru
  setelah recovery. Drop derived depth frame tidak identik dengan gap raw book.
- Degradation order: kurangi cadence/depth/visual history, lalu matikan label
  bubble kecil; jangan menampilkan stale signal sebagai fresh.

## Consequences

- Canvas 2D menjaga implementasi sederhana selama baseline masih memenuhi gate.
- WebGL bukan dependency wajib untuk Phase 0/1, tetapi migration seam tetap pada
  `drawMarketLayer` dan data visual yang sudah dibucket.
- Memori dan CPU dihitung per simbol dan per client sebelum multi-symbol aktif.

## Current gaps

- Renderer masih memindai seluruh depth buffer untuk percentile dan queue cell;
  sampling 6.000 hanya membatasi sample percentile, bukan jumlah cell yang
  diantrikan untuk draw.
- Control `timeBucketMs` saat ini mengubah lebar cell visual tetapi tidak
  mengagregasi depth frame menjadi bucket 1s/5s/15s/1m/5m; banyak frame dapat
  saling menimpa pada bucket tampilan yang sama.
- `useMarketData` mengubah ring buffer menjadi array baru pada setiap event;
  React update dapat lebih mahal daripada canvas draw.
- Pilihan time window 5 menit melebihi sekitar 3 menit histori depth pada cadence
  default 10 FPS dengan kapasitas aplikasi 1.800 frame.
- Harness opt-in Phase 0 sudah mengukur FPS, market-layer draw, long task,
  local input-to-paint, GPU renderer, dan short-run heap pada Chrome headless;
  telemetry production dan dropped-render counter masih belum ada.
- Drop WS saat backpressure tidak menghasilkan status degraded yang dipahami UI;
  frontend justru menganggap setiap loncatan envelope sequence sebagai data gap.
- Belum ada Web Worker, OffscreenCanvas, atau WebGL path. Baseline referensi
  1.800-frame gagal gate FPS/draw pada CPU lama dengan SwiftShader, sehingga
  profiling dan optimasi tahap 1–3 pada escalation path sekarang wajib sebelum
  keputusan migrasi WebGL.
