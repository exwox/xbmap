import { RawCaptureRecorder } from "../../server/recording/rawCapture.js";
import {
  SYNTHETIC_CAPTURE_ID,
  SYNTHETIC_HOUR_START,
  SYNTHETIC_SYMBOL,
} from "./synthetic.js";

export interface SyntheticRawCapture {
  dataPath: string;
  manifestPath: string;
  recordCount: number;
  from: number;
  to: number;
}

/** Build a complete raw capture whose event clock spans exactly one hour. */
export async function createSyntheticRawHour(
  directory: string,
): Promise<SyntheticRawCapture> {
  let clock = SYNTHETIC_HOUR_START;
  const recorder = new RawCaptureRecorder({
    directory,
    symbol: SYNTHETIC_SYMBOL,
    id: SYNTHETIC_CAPTURE_ID,
    now: () => clock,
    maxDurationMs: 2 * 60 * 60_000,
    queueCapacity: 8_192,
    queueByteCapacity: 16 * 1024 * 1024,
    maxCaptureBytes: 64 * 1024 * 1024,
  });

  recordOrThrow(recorder, {
    capturedAt: clock,
    exchange: "binance",
    symbol: SYNTHETIC_SYMBOL,
    source: "binance",
    stream: "snapshot",
    connectionId: "phase2-connection",
    payload: JSON.stringify({
      lastUpdateId: 10_000,
      bids: [["63999.9", "5"], ["63999.8", "7"]],
      asks: [["64000.1", "4"], ["64000.2", "8"]],
    }),
  });

  let updateId = 10_000;
  for (let second = 0; second < 3_600; second += 1) {
    clock = SYNTHETIC_HOUR_START + second * 1_000 + 100;
    const previousUpdateId = updateId;
    updateId += 1;
    recordOrThrow(recorder, {
      capturedAt: clock,
      exchange: "binance",
      symbol: SYNTHETIC_SYMBOL,
      source: "binance",
      stream: "depth",
      connectionId: "phase2-connection",
      payload: JSON.stringify({
        e: "depthUpdate",
        E: clock - 2,
        T: clock - 3,
        s: SYNTHETIC_SYMBOL,
        U: updateId,
        u: updateId,
        pu: previousUpdateId,
        b: [["63999.9", canonicalQuantity(5 + (second % 17) / 10)]],
        a: [["64000.1", canonicalQuantity(4 + (second % 13) / 10)]],
      }),
    });

    clock = SYNTHETIC_HOUR_START + second * 1_000 + 200;
    recordOrThrow(recorder, {
      capturedAt: clock,
      exchange: "binance",
      symbol: SYNTHETIC_SYMBOL,
      source: "binance",
      stream: "trade",
      connectionId: "phase2-connection",
      payload: JSON.stringify({
        e: "aggTrade",
        E: clock - 2,
        T: clock - 3,
        s: SYNTHETIC_SYMBOL,
        a: second + 1,
        p: second % 2 === 0 ? "64000.1" : "63999.9",
        q: canonicalQuantity(0.01 + (second % 25) / 100),
        m: second % 3 === 0,
      }),
    });
  }

  clock = SYNTHETIC_HOUR_START + 60 * 60_000 - 1;
  const stats = await recorder.close();
  if (stats.failed || stats.droppedRecords > 0 || stats.writtenRecords !== 7_201) {
    throw new Error(
      `Synthetic raw capture failed: written=${stats.writtenRecords}, dropped=${stats.droppedRecords}, failure=${stats.failure ?? "none"}`,
    );
  }
  return {
    dataPath: stats.dataPath,
    manifestPath: stats.manifestPath,
    recordCount: stats.writtenRecords,
    from: SYNTHETIC_HOUR_START,
    to: clock,
  };
}

function recordOrThrow(
  recorder: RawCaptureRecorder,
  record: Parameters<RawCaptureRecorder["record"]>[0],
): void {
  if (!recorder.record(record)) {
    throw new Error(`Synthetic raw capture rejected ${record.stream} at ${record.capturedAt}`);
  }
}

function canonicalQuantity(value: number): string {
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
