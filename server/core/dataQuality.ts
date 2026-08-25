import type {
  BookCheckpoint,
  ClockDriftStats,
  DataQualityCounters,
  DataQualityState,
  DataValidity,
  MarketSource,
} from "../types.js";
import type { BookApplyResult } from "./orderBook.js";

export function emptyDataQualityCounters(): DataQualityCounters {
  return {
    sequenceGaps: 0,
    duplicates: 0,
    outOfOrder: 0,
    malformedEvents: 0,
    crossedBooks: 0,
    resyncs: 0,
    queueOverflows: 0,
  };
}

export function addDataQualityCounters(
  left: DataQualityCounters,
  right: DataQualityCounters,
): DataQualityCounters {
  return {
    sequenceGaps: left.sequenceGaps + right.sequenceGaps,
    duplicates: left.duplicates + right.duplicates,
    outOfOrder: left.outOfOrder + right.outOfOrder,
    malformedEvents: left.malformedEvents + right.malformedEvents,
    crossedBooks: left.crossedBooks + right.crossedBooks,
    resyncs: left.resyncs + right.resyncs,
    queueOverflows: left.queueOverflows + right.queueOverflows,
  };
}

/** Small allocation-free accumulator shared by feed and gateway quality paths. */
export class DataQualityMonitor {
  private readonly countersValue = emptyDataQualityCounters();
  private driftLatest: number | null = null;
  private driftMinimum: number | null = null;
  private driftMaximum: number | null = null;
  private driftTotal = 0;
  private driftSamples = 0;

  get counters(): DataQualityCounters {
    return { ...this.countersValue };
  }

  get clockDrift(): ClockDriftStats {
    return {
      latestMs: this.driftLatest,
      minMs: this.driftMinimum,
      maxMs: this.driftMaximum,
      averageMs: this.driftSamples > 0 ? this.driftTotal / this.driftSamples : null,
      samples: this.driftSamples,
    };
  }

  observeClock(exchangeTimestamp: number, receivedTimestamp: number): void {
    if (!Number.isFinite(exchangeTimestamp) || !Number.isFinite(receivedTimestamp)) return;
    const drift = receivedTimestamp - exchangeTimestamp;
    this.driftLatest = drift;
    this.driftMinimum = this.driftMinimum === null ? drift : Math.min(this.driftMinimum, drift);
    this.driftMaximum = this.driftMaximum === null ? drift : Math.max(this.driftMaximum, drift);
    this.driftTotal += drift;
    this.driftSamples += 1;
  }

  recordApplyResult(result: BookApplyResult): void {
    switch (result.code) {
      case "sequence_gap":
        this.countersValue.sequenceGaps += 1;
        break;
      case "duplicate":
        this.countersValue.duplicates += 1;
        break;
      case "out_of_order":
        this.countersValue.outOfOrder += 1;
        break;
      case "malformed":
        this.countersValue.malformedEvents += 1;
        break;
      case "crossed":
        this.countersValue.crossedBooks += 1;
        break;
      default:
        break;
    }
  }

  malformed(): void {
    this.countersValue.malformedEvents += 1;
  }

  crossed(): void {
    this.countersValue.crossedBooks += 1;
  }

  resync(): void {
    this.countersValue.resyncs += 1;
  }

  queueOverflow(): void {
    this.countersValue.queueOverflows += 1;
  }
}

export interface MutableMarketSessionOptions {
  sessionId: string;
  source: MarketSource;
  reason: string;
}

/** Explicit validity state: no consumer has to infer book safety from transport status. */
export class MarketSession {
  private sessionIdValue: string;
  private sourceValue: MarketSource;
  private validityValue: DataValidity = "invalid";
  private transportAliveValue = false;
  private marketActiveValue = false;
  private synchronizedValue = false;
  private frozenValue = true;
  private reasonValue: string;
  private lastValidAtValue: number | null = null;
  private checkpointValue: BookCheckpoint | null = null;

  constructor(options: MutableMarketSessionOptions) {
    this.sessionIdValue = options.sessionId;
    this.sourceValue = options.source;
    this.reasonValue = options.reason;
  }

  get source(): MarketSource {
    return this.sourceValue;
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get validity(): DataValidity {
    return this.validityValue;
  }

  get isValid(): boolean {
    return this.validityValue === "valid" && this.synchronizedValue && !this.frozenValue;
  }

  begin(sessionId: string, source: MarketSource, reason: string): void {
    this.sessionIdValue = sessionId;
    this.sourceValue = source;
    this.validityValue = "syncing";
    this.transportAliveValue = false;
    this.marketActiveValue = false;
    this.synchronizedValue = false;
    this.frozenValue = true;
    this.reasonValue = reason;
    this.lastValidAtValue = null;
    this.checkpointValue = null;
  }

  syncing(reason: string, transportAlive: boolean): void {
    this.validityValue = "syncing";
    this.transportAliveValue = transportAlive;
    this.marketActiveValue = false;
    this.synchronizedValue = false;
    this.frozenValue = true;
    this.reasonValue = reason;
    this.checkpointValue = null;
  }

  valid(checkpoint: BookCheckpoint, reason: string, now = Date.now()): void {
    this.validityValue = "valid";
    this.transportAliveValue = true;
    this.marketActiveValue = true;
    this.synchronizedValue = true;
    this.frozenValue = false;
    this.reasonValue = reason;
    this.lastValidAtValue = now;
    this.checkpointValue = checkpoint;
  }

  refresh(checkpoint: BookCheckpoint, now = Date.now()): void {
    if (!this.isValid) return;
    this.marketActiveValue = true;
    this.lastValidAtValue = now;
    this.checkpointValue = checkpoint;
  }

  invalidate(
    validity: Exclude<DataValidity, "valid" | "closed">,
    reason: string,
    transportAlive: boolean,
  ): void {
    this.validityValue = validity;
    this.transportAliveValue = transportAlive;
    this.marketActiveValue = false;
    this.synchronizedValue = false;
    this.frozenValue = true;
    this.reasonValue = reason;
    this.checkpointValue = null;
  }

  close(reason: string): void {
    this.validityValue = "closed";
    this.transportAliveValue = false;
    this.marketActiveValue = false;
    this.synchronizedValue = false;
    this.frozenValue = true;
    this.reasonValue = reason;
    this.checkpointValue = null;
  }

  snapshot(counters: DataQualityCounters, clockDrift: ClockDriftStats): DataQualityState {
    return {
      sessionId: this.sessionIdValue,
      validity: this.validityValue,
      transportAlive: this.transportAliveValue,
      marketActive: this.marketActiveValue,
      synchronized: this.synchronizedValue,
      frozen: this.frozenValue,
      reason: this.reasonValue,
      lastValidAt: this.lastValidAtValue,
      counters: { ...counters },
      clockDrift: { ...clockDrift },
      checkpoint: this.checkpointValue ? { ...this.checkpointValue } : null,
    };
  }
}
