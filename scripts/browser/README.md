# Browser renderer benchmark

Harness ini menjalankan build production LiquidMap di Chrome headless dengan
dataset deterministik yang sudah berisi 1.800 depth frame dan cadence 10 Hz.
lalu mengukur cadence animation frame, durasi draw Canvas market layer,
input-to-paint lokal, long task, dan JavaScript heap jangka pendek.

```bash
npm run build
node --import tsx scripts/browser/measure-renderer.ts
```

Hasil default ditulis ke:

- `docs/baselines/phase-0-browser-renderer.json`
- `docs/baselines/phase-0-browser-renderer.md`

Gunakan `--chrome PATH` jika Chrome tidak berada di path umum. Benchmark ini
adalah synthetic stress pada host referensi, bukan pengukuran event rate Binance
atau sertifikasi perangkat minimum. Ulangi di perangkat fisik target sebelum
beta dirilis.
