import { createHash } from "node:crypto";
import type {
  BookCheckpoint,
  DepthSnapshot,
  DepthUpdate,
  PriceLevel,
  WirePriceLevel,
} from "../types.js";

export type BookApplyStatus =
  | "applied"
  | "ignored"
  | "gap"
  | "unsynced"
  | "invalid";

export interface BookApplyResult {
  status: BookApplyStatus;
  lastUpdateId: number;
  code?: "duplicate" | "out_of_order" | "sequence_gap" | "malformed" | "crossed" | "unsynced";
  reason?: string;
}

interface ValidatedLevel {
  ticks: number;
  quantity: number;
}

/**
 * Sequence-aware local level-2 book. Prices are stored as integer ticks so
 * delete/update lookup is deterministic and floating point is kept at the edge.
 */
export class OrderBook {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private readonly priceDecimals: number;
  private snapshotLoaded = false;
  private bridgedSnapshot = false;
  private updateId = 0;
  private fingerprintCache: string | null = null;

  constructor(readonly tickSize: number) {
    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      throw new Error("tickSize must be a finite positive number");
    }
    this.priceDecimals = decimalPlaces(tickSize);
  }

  get lastUpdateId(): number {
    return this.updateId;
  }

  get isSynchronized(): boolean {
    return this.snapshotLoaded;
  }

  get hasBridgedSnapshot(): boolean {
    return this.snapshotLoaded && this.bridgedSnapshot;
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this.snapshotLoaded = false;
    this.bridgedSnapshot = false;
    this.updateId = 0;
    this.fingerprintCache = null;
  }

  loadSnapshot(snapshot: DepthSnapshot): void {
    if (!Number.isSafeInteger(snapshot.lastUpdateId) || snapshot.lastUpdateId < 0) {
      throw new Error("Invalid snapshot lastUpdateId");
    }
    const bids = this.validateLevels(snapshot.bids, false);
    const asks = this.validateLevels(snapshot.asks, false);

    const nextBids = new Map<number, number>();
    const nextAsks = new Map<number, number>();
    this.applyValidated(nextBids, bids);
    this.applyValidated(nextAsks, asks);
    if (isCrossedMaps(nextBids, nextAsks)) {
      throw new Error("Snapshot order book is crossed");
    }

    // Commit only after the complete candidate snapshot has passed validation.
    // A rejected snapshot therefore cannot destroy the last known-good state.
    this.bids.clear();
    this.asks.clear();
    for (const entry of nextBids) this.bids.set(...entry);
    for (const entry of nextAsks) this.asks.set(...entry);
    this.updateId = snapshot.lastUpdateId;
    this.snapshotLoaded = true;
    this.bridgedSnapshot = false;
    this.fingerprintCache = null;
  }

  applyUpdate(update: DepthUpdate): BookApplyResult {
    if (!this.snapshotLoaded) {
      return this.result("unsynced", "unsynced", "A snapshot must be loaded before updates");
    }
    if (
      !Number.isSafeInteger(update.sequenceStart) ||
      !Number.isSafeInteger(update.sequenceEnd) ||
      update.sequenceStart < 0 ||
      update.sequenceEnd < update.sequenceStart
    ) {
      return this.result("invalid", "malformed", "Invalid sequence range");
    }
    if (update.sequenceEnd <= this.updateId) {
      const code = update.sequenceEnd === this.updateId ? "duplicate" : "out_of_order";
      return this.result("ignored", code, "Duplicate or out-of-order update");
    }

    if (!this.bridgedSnapshot) {
      // Binance USD-M snapshots may be bridged by an event containing either
      // lastUpdateId or lastUpdateId + 1. Requiring its end to advance avoids
      // accepting a fully stale event.
      const canBridge =
        update.sequenceStart <= this.updateId + 1 &&
        update.sequenceEnd >= this.updateId + 1;
      if (!canBridge) {
        const code = update.sequenceEnd < this.updateId + 1 ? "out_of_order" : "sequence_gap";
        return this.result("gap", code, "First event does not bridge the snapshot");
      }
    } else if (
      update.previousSequence !== undefined &&
      update.previousSequence !== this.updateId
    ) {
      return this.result(
        "gap",
        update.previousSequence < this.updateId ? "out_of_order" : "sequence_gap",
        `Previous sequence ${update.previousSequence} does not match ${this.updateId}`,
      );
    } else if (
      update.previousSequence === undefined &&
      update.sequenceStart > this.updateId + 1
    ) {
      return this.result(
        "gap",
        "sequence_gap",
        `Sequence starts at ${update.sequenceStart}, expected at most ${this.updateId + 1}`,
      );
    }

    let bids: ValidatedLevel[];
    let asks: ValidatedLevel[];
    try {
      bids = this.validateLevels(update.bids, true);
      asks = this.validateLevels(update.asks, true);
    } catch (error) {
      return this.result(
        "invalid",
        "malformed",
        error instanceof Error ? error.message : "Invalid depth level",
      );
    }

    const bidUndo = this.captureUndo(this.bids, bids);
    const askUndo = this.captureUndo(this.asks, asks);
    this.applyValidated(this.bids, bids);
    this.applyValidated(this.asks, asks);

    if (this.isCrossed()) {
      this.restore(this.bids, bidUndo);
      this.restore(this.asks, askUndo);
      return this.result("invalid", "crossed", "Update would create a crossed order book");
    }

    this.updateId = update.sequenceEnd;
    this.bridgedSnapshot = true;
    this.fingerprintCache = null;
    return this.result("applied");
  }

  /** Canonical full-depth snapshot used for atomic handoff and deterministic replay. */
  exportSnapshot(exchangeTimestamp?: number): DepthSnapshot {
    // Do not reuse the UI-oriented getLevels() cap here: reconciliation and
    // replay checkpoints must preserve every known level.
    const bids = sortedEntries(this.bids, true)
      .map(([ticks, quantity]): PriceLevel => [this.fromTicks(ticks), quantity]);
    const asks = sortedEntries(this.asks, false)
      .map(([ticks, quantity]): PriceLevel => [this.fromTicks(ticks), quantity]);
    return {
      lastUpdateId: this.updateId,
      ...(exchangeTimestamp !== undefined ? { exchangeTimestamp } : {}),
      bids,
      asks,
    };
  }

  checkpoint(): BookCheckpoint {
    const bestBid = this.getBestBid()?.[0] ?? null;
    const bestAsk = this.getBestAsk()?.[0] ?? null;
    return {
      algorithm: "sha256",
      fingerprint: this.fingerprint(),
      lastUpdateId: this.updateId,
      bidLevelCount: this.bids.size,
      askLevelCount: this.asks.size,
      bestBid,
      bestAsk,
    };
  }

  fingerprint(): string {
    if (this.fingerprintCache) return this.fingerprintCache;
    const hash = createHash("sha256");
    hash.update(`xbmap-book-v1|${this.tickSize}|${this.updateId}|`);
    for (const [ticks, quantity] of sortedEntries(this.bids, true)) {
      hash.update(`b:${ticks}:${quantity};`);
    }
    hash.update("|");
    for (const [ticks, quantity] of sortedEntries(this.asks, false)) {
      hash.update(`a:${ticks}:${quantity};`);
    }
    this.fingerprintCache = hash.digest("hex");
    return this.fingerprintCache;
  }

  getBestBid(): PriceLevel | null {
    let ticks = -Infinity;
    let quantity = 0;
    for (const [candidate, candidateQuantity] of this.bids) {
      if (candidate > ticks) {
        ticks = candidate;
        quantity = candidateQuantity;
      }
    }
    return Number.isFinite(ticks) ? [this.fromTicks(ticks), quantity] : null;
  }

  getBestAsk(): PriceLevel | null {
    let ticks = Infinity;
    let quantity = 0;
    for (const [candidate, candidateQuantity] of this.asks) {
      if (candidate < ticks) {
        ticks = candidate;
        quantity = candidateQuantity;
      }
    }
    return Number.isFinite(ticks) ? [this.fromTicks(ticks), quantity] : null;
  }

  getLevels(depth = 80): { bids: PriceLevel[]; asks: PriceLevel[] } {
    const safeDepth = Math.max(1, Math.min(1_000, Math.floor(depth)));
    const bids = [...this.bids.entries()]
      .sort(([left], [right]) => right - left)
      .slice(0, safeDepth)
      .map(([ticks, quantity]): PriceLevel => [this.fromTicks(ticks), quantity]);
    const asks = [...this.asks.entries()]
      .sort(([left], [right]) => left - right)
      .slice(0, safeDepth)
      .map(([ticks, quantity]): PriceLevel => [this.fromTicks(ticks), quantity]);
    return { bids, asks };
  }

  imbalance(depth = 20): number {
    const { bids, asks } = this.getLevels(depth);
    const bidLiquidity = bids.reduce((sum, [, quantity]) => sum + quantity, 0);
    const askLiquidity = asks.reduce((sum, [, quantity]) => sum + quantity, 0);
    const total = bidLiquidity + askLiquidity;
    return total > 0 ? (bidLiquidity - askLiquidity) / total : 0;
  }

  private result(
    status: BookApplyStatus,
    codeOrReason?: BookApplyResult["code"] | string,
    reason?: string,
  ): BookApplyResult {
    const code = reason === undefined ? undefined : codeOrReason as BookApplyResult["code"];
    const finalReason = reason ?? codeOrReason;
    return {
      status,
      lastUpdateId: this.updateId,
      ...(code ? { code } : {}),
      ...(finalReason ? { reason: finalReason } : {}),
    };
  }

  private validateLevels(levels: WirePriceLevel[], allowDelete: boolean): ValidatedLevel[] {
    if (!Array.isArray(levels)) throw new Error("Depth levels must be an array");
    const seenTicks = new Set<number>();
    return levels.map((level) => {
      if (!Array.isArray(level) || level.length < 2) {
        throw new Error("Malformed depth level");
      }
      const price = Number(level[0]);
      const quantity = Number(level[1]);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity)) {
        throw new Error("Depth price and quantity must be finite");
      }
      if (quantity < 0 || (!allowDelete && quantity === 0)) {
        throw new Error("Depth quantity must be positive, or zero only for a delta");
      }
      const ticks = Math.round(price / this.tickSize);
      if (!Number.isSafeInteger(ticks) || ticks <= 0) {
        throw new Error("Depth price cannot be represented as safe integer ticks");
      }
      const representedPrice = ticks * this.tickSize;
      if (Math.abs(representedPrice - price) > Math.max(1e-9, this.tickSize * 1e-8)) {
        throw new Error("Depth price is not aligned to tick size");
      }
      if (seenTicks.has(ticks)) throw new Error("Duplicate price level in one depth event");
      seenTicks.add(ticks);
      return { ticks, quantity };
    });
  }

  private applyValidated(side: Map<number, number>, levels: ValidatedLevel[]): void {
    for (const { ticks, quantity } of levels) {
      if (quantity === 0) side.delete(ticks);
      else side.set(ticks, quantity);
    }
  }

  private captureUndo(
    side: Map<number, number>,
    levels: ValidatedLevel[],
  ): Map<number, number | undefined> {
    const undo = new Map<number, number | undefined>();
    for (const { ticks } of levels) {
      if (!undo.has(ticks)) undo.set(ticks, side.get(ticks));
    }
    return undo;
  }

  private restore(side: Map<number, number>, undo: Map<number, number | undefined>): void {
    for (const [ticks, quantity] of undo) {
      if (quantity === undefined) side.delete(ticks);
      else side.set(ticks, quantity);
    }
  }

  private isCrossed(): boolean {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();
    return bid !== null && ask !== null && bid[0] >= ask[0];
  }

  private fromTicks(ticks: number): number {
    return Number((ticks * this.tickSize).toFixed(this.priceDecimals));
  }
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

function sortedEntries(
  levels: Map<number, number>,
  descending: boolean,
): Array<[number, number]> {
  return [...levels.entries()].sort(([left], [right]) =>
    descending ? right - left : left - right,
  );
}

function isCrossedMaps(bids: Map<number, number>, asks: Map<number, number>): boolean {
  let bestBid = -Infinity;
  let bestAsk = Infinity;
  for (const ticks of bids.keys()) bestBid = Math.max(bestBid, ticks);
  for (const ticks of asks.keys()) bestAsk = Math.min(bestAsk, ticks);
  return Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid >= bestAsk;
}
