import { createHash } from "node:crypto";
import {
  compareHistoryRecords,
  type HistoricalRecord,
  type HistoryResolutionMs,
  type StoredMetricFrame,
} from "./types.js";

/**
 * Deterministically rolls interval facts into a larger resolution. Rolling
 * fields in MetricFrame are copied from the last source frame; they are never
 * summed, preventing the repeated-rolling-volume bug documented as EVT-011.
 */
export function downsampleMetricFrames(
  input: readonly StoredMetricFrame[],
  targetResolutionMs: Exclude<HistoryResolutionMs, 1_000>,
): StoredMetricFrame[] {
  if (input.length === 0) return [];
  const ordered = [...input].sort(compareHistoryRecords);
  const sourceResolution = ordered[0]!.resolutionMs;
  if (sourceResolution >= targetResolutionMs || targetResolutionMs % sourceResolution !== 0) {
    throw new TypeError("Target resolution must be a larger multiple of the source resolution");
  }
  if (ordered.some((record) => record.resolutionMs !== sourceResolution)) {
    throw new TypeError("Downsample input must have one source resolution");
  }

  const groups = new Map<string, StoredMetricFrame[]>();
  for (const record of ordered) {
    const bucketStart = Math.floor(record.intervalStart / targetResolutionMs) * targetResolutionMs;
    const key = `${record.exchange}\0${record.symbol}\0${record.captureId}\0${bucketStart}`;
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }

  return [...groups.values()].map((records) => {
    const first = records[0]!;
    const latest = records[records.length - 1]!;
    const intervalStart = Math.floor(first.intervalStart / targetResolutionMs) * targetResolutionMs;
    const intervalBuyVolume = sum(records, (record) => record.intervalBuyVolume);
    const intervalSellVolume = sum(records, (record) => record.intervalSellVolume);
    const intervalTradeCount = sum(records, (record) => record.intervalTradeCount);
    const analyticsFingerprint = createHash("sha256").update(JSON.stringify({
      algorithm: "liquidmap-downsample-v1",
      sourceResolution,
      targetResolutionMs,
      sourceFingerprints: records.map((record) => record.analyticsFingerprint),
      intervalBuyVolume,
      intervalSellVolume,
      intervalTradeCount,
    })).digest("hex");
    return {
      ...latest,
      exchangeTimestamp: intervalStart,
      receivedTimestamp: Math.max(...records.map((record) => record.receivedTimestamp)),
      captureSequence: Math.max(...records.map((record) => record.captureSequence)),
      resolutionMs: targetResolutionMs,
      intervalStart,
      intervalEnd: intervalStart + targetResolutionMs,
      intervalBuyVolume,
      intervalSellVolume,
      intervalTradeCount,
      // Keep all rolling/point-in-time analytics from the final source frame.
      metric: structuredClone(latest.metric),
      trend: structuredClone(latest.trend),
      bookFingerprint: latest.bookFingerprint,
      analyticsFingerprint,
    } satisfies StoredMetricFrame;
  }).sort(compareHistoryRecords);
}

function sum(
  records: readonly StoredMetricFrame[],
  select: (record: StoredMetricFrame) => number,
): number {
  return records.reduce((total, record) => total + select(record), 0);
}

export function metricFrames(records: readonly HistoricalRecord[]): StoredMetricFrame[] {
  return records.filter((record): record is StoredMetricFrame => record.kind === "metric_frame");
}
