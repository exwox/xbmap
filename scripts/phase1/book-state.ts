import { canonicalJson, sha256 } from "../fixtures/canonical.js";
import type { OrderBook } from "../../server/core/orderBook.js";

interface ProductionFingerprintApi {
  fingerprint?: (depth?: number) => unknown;
  getFingerprint?: (depth?: number) => unknown;
  stateFingerprint?: (depth?: number) => unknown;
}

export interface ResolvedFingerprint {
  value: string;
  source:
    | "OrderBook.fingerprint"
    | "OrderBook.getFingerprint"
    | "OrderBook.stateFingerprint"
    | "compatibility-canonical-state";
}

/**
 * Prefer the Phase 1 production fingerprint API when present. The canonical
 * fallback keeps this independent harness runnable while that API is being
 * introduced, and is intentionally based only on observable book state.
 */
export function fingerprintBook(book: OrderBook, depth = 1_000): ResolvedFingerprint {
  const candidate = book as unknown as ProductionFingerprintApi;
  const methods = [
    ["OrderBook.fingerprint", candidate.fingerprint],
    ["OrderBook.getFingerprint", candidate.getFingerprint],
    ["OrderBook.stateFingerprint", candidate.stateFingerprint],
  ] as const;
  for (const [source, method] of methods) {
    if (typeof method !== "function") continue;
    const result = method.call(book, depth);
    const normalized = normalizeProductionFingerprint(result);
    if (normalized) return { value: normalized, source };
  }

  return {
    value: `sha256:${sha256(canonicalJson({
      lastUpdateId: book.lastUpdateId,
      ...book.getLevels(depth),
    }))}`,
    source: "compatibility-canonical-state",
  };
}

function normalizeProductionFingerprint(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["fingerprint", "hash", "value"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}
