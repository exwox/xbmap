import { createHash } from "node:crypto";
import { OrderBook } from "../core/orderBook.js";
import type { RawCaptureEnvelope } from "../recording/rawCapture.js";
import type {
  BookCheckpoint,
  DepthSnapshot,
  DepthUpdate,
  NormalizedTrade,
  PriceLevel,
  WirePriceLevel,
} from "../types.js";
import { envelopeChecksum } from "./replaySource.js";

export interface RawProjectionOptions {
  symbol: string;
  tickSize: number;
  strict?: boolean;
  maxPendingDepth?: number;
}

export interface RawProjectionResult {
  symbol: string;
  records: number;
  snapshots: number;
  depthApplied: number;
  depthIgnored: number;
  trades: number;
  buyVolume: number;
  sellVolume: number;
  firstCapturedAt: number | null;
  lastCapturedAt: number | null;
  checkpoint: BookCheckpoint;
  levels: { bids: PriceLevel[]; asks: PriceLevel[] };
  replayChecksum: string;
}

/**
 * Projects an ordered raw capture into the production OrderBook. Depth events
 * observed while REST reconciliation is in flight are buffered by connection
 * and drained after that connection's snapshot, matching the live adapter.
 */
export async function projectRawCapture(
  envelopes: AsyncIterable<RawCaptureEnvelope> | Iterable<RawCaptureEnvelope>,
  options: RawProjectionOptions,
): Promise<RawProjectionResult> {
  const symbol = normalizeSymbol(options.symbol);
  const strict = options.strict !== false;
  const maxPendingDepth = clampInteger(options.maxPendingDepth ?? 20_000, 1, 100_000);
  const book = new OrderBook(options.tickSize);
  const pendingByConnection = new Map<string, DepthUpdate[]>();
  const replayHash = createHash("sha256");
  replayHash.update("raw-projection-v1\n");
  let activeConnection: string | null = null;
  let records = 0;
  let snapshots = 0;
  let depthApplied = 0;
  let depthIgnored = 0;
  let trades = 0;
  let buyVolume = 0;
  let sellVolume = 0;
  let firstCapturedAt: number | null = null;
  let lastCapturedAt: number | null = null;

  for await (const envelope of envelopes) {
    if (envelope.symbol !== symbol) {
      if (strict) throw new Error(`Replay symbol mismatch: expected ${symbol}, got ${envelope.symbol}`);
      continue;
    }
    records += 1;
    firstCapturedAt ??= envelope.capturedAt;
    lastCapturedAt = envelope.capturedAt;
    replayHash.update(`${envelopeChecksum(envelope)}\n`);

    if (envelope.stream === "snapshot") {
      const snapshot = parseRawSnapshot(envelope.payload);
      book.loadSnapshot(snapshot);
      activeConnection = envelope.connectionId;
      snapshots += 1;
      const buffered = pendingByConnection.get(activeConnection) ?? [];
      pendingByConnection.clear();
      for (const update of buffered) {
        if (update.sequenceEnd <= snapshot.lastUpdateId) {
          depthIgnored += 1;
          continue;
        }
        const status = book.applyUpdate(update);
        if (status.status === "applied") depthApplied += 1;
        else if (status.status === "ignored") depthIgnored += 1;
        else if (strict) throw projectionError(update, status.status, status.reason);
      }
      continue;
    }

    if (envelope.stream === "depth") {
      const update = parseRawDepth(envelope);
      if (!book.isSynchronized || envelope.connectionId !== activeConnection) {
        const pending = pendingByConnection.get(envelope.connectionId) ?? [];
        if (pending.length >= maxPendingDepth) {
          throw new Error(
            `Raw replay pending depth exceeded ${maxPendingDepth} events for ${envelope.connectionId}`,
          );
        }
        pending.push(update);
        pendingByConnection.set(envelope.connectionId, pending);
        continue;
      }
      const status = book.applyUpdate(update);
      if (status.status === "applied") depthApplied += 1;
      else if (status.status === "ignored") depthIgnored += 1;
      else if (strict) throw projectionError(update, status.status, status.reason);
      continue;
    }

    if (envelope.stream === "trade") {
      const trade = parseRawTrade(envelope);
      trades += 1;
      if (trade.side === "buy") buyVolume += trade.quantity;
      else sellVolume += trade.quantity;
    }
  }

  if (!book.isSynchronized) throw new Error("Raw replay did not contain a valid depth snapshot");
  return {
    symbol,
    records,
    snapshots,
    depthApplied,
    depthIgnored,
    trades,
    buyVolume,
    sellVolume,
    firstCapturedAt,
    lastCapturedAt,
    checkpoint: book.checkpoint(),
    levels: book.getLevels(1_000),
    replayChecksum: replayHash.digest("hex"),
  };
}

export function parseRawSnapshot(payload: string): DepthSnapshot {
  const value = parsePayload(payload);
  if (!isObject(value)
    || !Number.isSafeInteger(value.lastUpdateId)
    || (value.lastUpdateId as number) < 0) {
    throw new Error("Malformed raw REST depth snapshot");
  }
  return {
    lastUpdateId: value.lastUpdateId as number,
    ...(nonNegativeInteger(value.E) ? { exchangeTimestamp: value.E } : {}),
    bids: parseLevels(value.bids),
    asks: parseLevels(value.asks),
  };
}

export function parseRawDepth(envelope: RawCaptureEnvelope): DepthUpdate {
  const value = parsePayload(envelope.payload);
  if (!isObject(value)
    || value.e !== "depthUpdate"
    || value.s !== envelope.symbol
    || !nonNegativeInteger(value.E)
    || !nonNegativeInteger(value.U)
    || !nonNegativeInteger(value.u)
    || value.u < value.U
    || (value.pu !== undefined && !nonNegativeInteger(value.pu))) {
    throw new Error("Malformed raw Binance depth payload");
  }
  const exchangeTimestamp = nonNegativeInteger(value.T) ? value.T : value.E;
  return {
    exchangeTimestamp,
    receivedTimestamp: envelope.capturedAt,
    sequenceStart: value.U,
    sequenceEnd: value.u,
    ...(value.pu !== undefined ? { previousSequence: value.pu as number } : {}),
    bids: parseLevels(value.b),
    asks: parseLevels(value.a),
  };
}

export function parseRawTrade(envelope: RawCaptureEnvelope): NormalizedTrade {
  const value = parsePayload(envelope.payload);
  if (!isObject(value)
    || value.e !== "aggTrade"
    || value.s !== envelope.symbol
    || !nonNegativeInteger(value.E)
    || !nonNegativeInteger(value.T)
    || !nonNegativeInteger(value.a)
    || typeof value.p !== "string"
    || typeof value.q !== "string"
    || typeof value.m !== "boolean") {
    throw new Error("Malformed raw Binance aggregate-trade payload");
  }
  const price = Number(value.p);
  const quantity = Number(value.q);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Raw Binance aggregate trade has invalid price or quantity");
  }
  return {
    id: String(value.a),
    exchangeTimestamp: value.T,
    receivedTimestamp: envelope.capturedAt,
    price,
    quantity,
    side: value.m ? "sell" : "buy",
  };
}

function parsePayload(payload: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error("Raw capture payload is not valid JSON");
  }
  if (isObject(value) && "data" in value) return value.data;
  return value;
}

function parseLevels(value: unknown): WirePriceLevel[] {
  if (!Array.isArray(value)) throw new Error("Raw depth levels must be an array");
  return value.map((level) => {
    if (!Array.isArray(level)
      || level.length < 2
      || !isWireNumber(level[0])
      || !isWireNumber(level[1])) {
      throw new Error("Malformed raw depth level");
    }
    return [level[0], level[1]];
  });
}

function projectionError(
  update: DepthUpdate,
  status: string,
  reason: string | undefined,
): Error {
  return new Error(
    `Depth ${update.sequenceStart}-${update.sequenceEnd} was ${status}: ${reason ?? "unknown"}`,
  );
}

function normalizeSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,48}$/.test(normalized)) throw new TypeError("Raw replay symbol is invalid");
  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWireNumber(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
