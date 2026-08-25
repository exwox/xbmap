import { createHash } from "node:crypto";
import { FileHistoryStore } from "../../server/storage/fileHistoryStore.js";
import type { HistoricalRecord } from "../../server/storage/types.js";

async function main(): Promise<void> {
  const [directory, fromText, toText, limitText] = process.argv.slice(2);
  if (!directory || !fromText || !toText || !limitText) {
    throw new Error("restart-probe requires directory, from, to, and limit arguments");
  }
  const from = parseSafeInteger(fromText, "from");
  const to = parseSafeInteger(toText, "to");
  const limit = parseSafeInteger(limitText, "limit");
  const store = new FileHistoryStore({
    directory,
    limits: {
      defaultRows: limit,
      maxRows: limit,
      maxRangeMs: Math.max(1, to - from),
    },
  });
  await store.open();
  const result = await store.query({
    exchange: "binance",
    symbol: "BTCUSDT",
    from,
    to,
    limit,
  });
  process.stdout.write(`${JSON.stringify({
    processId: process.pid,
    records: result.records.length,
    truncated: result.truncated,
    scannedSegments: result.scannedSegments,
    scannedCompressedBytes: result.scannedCompressedBytes,
    digest: digestRecords(result.records),
  })}\n`);
}

function digestRecords(records: readonly HistoricalRecord[]): string {
  const hash = createHash("sha256");
  for (const record of records) hash.update(`${JSON.stringify(record)}\n`);
  return hash.digest("hex");
}

function parseSafeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`restart-probe ${label} must be a non-negative safe integer`);
  }
  return parsed;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
