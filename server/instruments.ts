/**
 * Static instrument metadata for Phase 4 multi-symbol support.
 *
 * Tick sizes mirror Binance USD-M perpetual contract specs for the beta
 * symbols. Dynamic discovery via the exchangeInfo REST endpoint can replace
 * this registry later without changing call sites: every consumer goes
 * through `instrumentFor` / `isSupportedSymbol`.
 */

export interface Instrument {
  symbol: string;
  tickSize: number;
  /** Display metadata consumed by the frontend symbol picker. */
  base: string;
  quote: string;
}

export const INSTRUMENTS: readonly Instrument[] = [
  { symbol: "BTCUSDT", tickSize: 0.1, base: "BTC", quote: "USDT" },
  { symbol: "ETHUSDT", tickSize: 0.01, base: "ETH", quote: "USDT" },
  { symbol: "SOLUSDT", tickSize: 0.01, base: "SOL", quote: "USDT" },
] as const;

export function isSupportedSymbol(symbol: string): boolean {
  return INSTRUMENTS.some((instrument) => instrument.symbol === normalizeSymbol(symbol));
}

export function instrumentFor(symbol: string): Instrument {
  const normalized = normalizeSymbol(symbol);
  const instrument = INSTRUMENTS.find((candidate) => candidate.symbol === normalized);
  if (!instrument) {
    throw new TypeError(`Unsupported symbol: ${symbol}`);
  }
  return instrument;
}

export function supportedSymbols(): string[] {
  return INSTRUMENTS.map((instrument) => instrument.symbol);
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}
