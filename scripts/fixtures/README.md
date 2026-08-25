# Deterministic market fixtures

These fixtures are small, synthetic Binance-compatible event streams for Phase 0 regression tests. No captured exchange data is committed.

Generate the committed NDJSON data and manifests:

```bash
node --import tsx scripts/fixtures/generate.ts --write
```

Verify that committed bytes still match the generator:

```bash
node --import tsx scripts/fixtures/generate.ts --check
```

Each `fixtures/market/*.events.jsonl` line has a contiguous `ordinal`, a deterministic replay clock (`at`), and one of these event kinds:

- `snapshot`, `depth`, `trade`, and `status` model the current server feed types;
- `checkpoint` requests an analytics frame at an exact event-clock timestamp;
- every depth event declares its expected order-book result.

The paired manifest records SHA-256 and byte/line metadata, the final order-book fingerprint, exact sequence outcomes, trade statistics, connection recovery, and complete metric/trend output at every checkpoint. `fixtures/market/index.json` also pins each data and manifest checksum.

Do not hand-edit generated fixture files. Change the scenario builder, run `--write`, review the manifest outcome diff, and then run the test suite.
