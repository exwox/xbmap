# Phase 2 validation

The Phase 2 harness uses only generated public-market-shaped data. It does not
commit or redistribute a live exchange capture.

It validates the production storage and replay paths for:

- history rediscovery through a fresh store instance;
- explicit range and row query limits plus cursor truncation;
- checksummed backup and restore;
- bounded batched ingestion concurrent with retention;
- one-hour replay startup, including authenticated first-page decoding;
- replay checksum invariance at 0.25x and 20x, both full and seeked;
- durable replay checkpoints plus pause, seek, speed, and resume controls.

Run directly with:

```bash
node --import tsx scripts/phase2/run.ts
```

The one-hour performance result is a deterministic synthetic qualification,
not a claim about production ClickHouse/object-storage latency. Re-run the same
contract against the deployed adapters and target hardware before production
sign-off.

