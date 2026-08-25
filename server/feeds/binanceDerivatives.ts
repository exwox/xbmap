/**
 * Phase 5 derivatives poller: funding rate and open interest from the public
 * Binance USD-M REST endpoints. The fetcher is injective so tests never touch
 * the network; production failures degrade to `stale` snapshots instead of
 * throwing.
 */

export interface DerivativesUpdate {
  symbol: string;
  fundingRate: number | null;
  nextFundingTime: number | null;
  markPrice: number | null;
  openInterest: number | null;
  stale: boolean;
  fetchedAtMs: number;
}

export type DerivativesListener = (update: DerivativesUpdate) => void;

export interface DerivativesPollerOptions {
  symbols?: string[];
  intervalMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface PremiumIndexEntry {
  symbol?: unknown;
  lastFundingRate?: unknown;
  nextFundingTime?: unknown;
  markPrice?: unknown;
}

export class BinanceDerivativesPoller {
  private readonly symbols: string[];
  private readonly intervalMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly listeners = new Set<DerivativesListener>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutiveFailures = 0;

  constructor(options: DerivativesPollerOptions = {}) {
    this.symbols = options.symbols ?? [];
    this.intervalMs = Math.max(10_000, options.intervalMs ?? 30_000);
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  setSymbols(symbols: string[]): void {
    if (arraysEqual(this.symbols, symbols)) return;
    this.symbols.splice(0, this.symbols.length, ...symbols);
    if (this.running && this.symbols.length > 0) void this.pollOnce();
  }

  on(listener: DerivativesListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running || this.symbols.length === 0) return;
    this.running = true;
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    if (this.symbols.length === 0) return;
    const fetchedAtMs = this.now();
    try {
      const response = await this.fetchFn(
        "https://fapi.binance.com/fapi/v1/premiumIndex",
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) throw new Error(`premiumIndex HTTP ${response.status}`);
      const payload = (await response.json()) as PremiumIndexEntry[] | PremiumIndexEntry;
      const entries = Array.isArray(payload) ? payload : [payload];
      const bySymbol = new Map<string, PremiumIndexEntry>();
      for (const entry of entries) {
        if (typeof entry.symbol === "string") bySymbol.set(entry.symbol, entry);
      }
      this.consecutiveFailures = 0;
      for (const symbol of this.symbols) {
        const entry = bySymbol.get(symbol);
        this.emit({
          symbol,
          fundingRate: toFinite(entry?.lastFundingRate),
          nextFundingTime: toFinite(entry?.nextFundingTime),
          markPrice: toFinite(entry?.markPrice),
          openInterest: await this.fetchOpenInterest(symbol),
          stale: false,
          fetchedAtMs,
        });
      }
    } catch {
      this.consecutiveFailures += 1;
      // Degrade: keep last known values but flag them stale after two misses.
      const stale = this.consecutiveFailures >= 2;
      for (const symbol of this.symbols) {
        this.emit({ symbol, fundingRate: null, nextFundingTime: null, markPrice: null, openInterest: null, stale, fetchedAtMs });
      }
    }
  }

  private async fetchOpenInterest(symbol: string): Promise<number | null> {
    try {
      const response = await this.fetchFn(
        `https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) return null;
      const payload = (await response.json()) as { openInterest?: unknown };
      return toFinite(payload.openInterest);
    } catch {
      return null;
    }
  }

  private emit(update: DerivativesUpdate): void {
    for (const listener of this.listeners) listener(update);
  }
}

function toFinite(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}