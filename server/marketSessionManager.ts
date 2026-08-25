/**
 * Phase 4 market-session manager.
 *
 * Owns one lazily-created `MarketGateway` per supported symbol so buffers,
 * order books, and analytics stay fully isolated while the process keeps a
 * bounded resource footprint:
 *
 * - `acquire(symbol)` creates + starts a gateway on first use (refcount 0→1).
 * - `release(symbol)` drops the refcount; when it reaches zero an eviction
 *   timer stops the gateway after `idleTtlMs`, so symbols nobody subscribes
 *   to stop consuming CPU/sockets without any operator action.
 * - Re-acquiring before eviction cancels the timer; `stop()`/`start()` on
 *   `MarketGateway` is explicitly restart-safe.
 */

import { MarketGateway } from "./marketGateway.js";
import { instrumentFor, isSupportedSymbol, supportedSymbols } from "./instruments.js";

export interface MarketSessionManagerOptions {
  tickSizeFor?: (symbol: string) => number;
  maxSessions?: number;
  idleTtlMs?: number;
  now?: () => number;
  /** Test seam: override construction (e.g. forceDemo gateways). */
  createGateway?: (symbol: string, tickSize: number) => MarketGateway;
  /**
   * Phase 4: teardown hook used by eviction and `drain()`. Production passes
   * an async shutdown so durable history/capture buffers flush before the
   * process exits; the synchronous `stop()` default fits tests.
   */
  disposeGateway?: (gateway: MarketGateway) => void | Promise<void>;
  /** Phase 4: notified whenever a session gateway becomes available. */
  onSessionCreated?: (gateway: MarketGateway) => void;
}

export interface SessionStatus {
  symbol: string;
  refCount: number;
  running: boolean;
  evictAtMs: number | null;
}

interface ManagedSession {
  gateway: MarketGateway;
  refCount: number;
  evictTimer: NodeJS.Timeout | null;
}

export class UnknownSymbolError extends Error {
  override readonly name = "UnknownSymbolError";
}

export class SessionCapacityError extends Error {
  override readonly name = "SessionCapacityError";
}
export class MarketSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly tickSizeFor: (symbol: string) => number;
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly createGateway: (symbol: string, tickSize: number) => MarketGateway;
  private readonly disposeGateway: (gateway: MarketGateway) => void | Promise<void>;
  private onSessionCreated: ((gateway: MarketGateway) => void) | null;
  private readonly pendingDisposals = new Set<Promise<void>>();

  constructor(options: MarketSessionManagerOptions = {}) {
    this.tickSizeFor = options.tickSizeFor ?? ((symbol) => instrumentFor(symbol).tickSize);
    this.maxSessions = options.maxSessions ?? 8;
    this.idleTtlMs = options.idleTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.createGateway = options.createGateway
      ?? ((symbol, tickSize) => new MarketGateway({ symbol, tickSize }));
    this.disposeGateway = options.disposeGateway ?? ((gateway) => { gateway.stop(); });
    this.onSessionCreated = options.onSessionCreated ?? null;
  }

  private notifyCreated(gateway: MarketGateway): void {
    this.onSessionCreated?.(gateway);
  }

  /**
   * Late-binding seam for owners that construct the manager before the
   * transport layer (e.g. `index.ts` → `httpServer`): the listener fires for
   * every future session, and once immediately for already-registered ones.
   */
  setOnSessionCreated(listener: (gateway: MarketGateway) => void): void {
    this.onSessionCreated = listener;
    for (const [, session] of this.sessions) this.notifyCreated(session.gateway);
  }

  /**
   * Registers an externally constructed gateway (e.g. the default symbol
   * session created by `index.ts` at boot) without taking a client reference.
   * A later `acquire()` reuses it instead of building a duplicate.
   */
  register(gateway: MarketGateway, options: { start?: boolean } = {}): MarketGateway {
    const symbol = gateway.symbol.trim().toUpperCase();
    if (!isSupportedSymbol(symbol)) {
      throw new UnknownSymbolError(`Unsupported symbol: ${gateway.symbol}`);
    }
    if (this.sessions.has(symbol)) {
      throw new TypeError(`Market session already registered for ${symbol}`);
    }
    if (options.start) gateway.start();
    this.sessions.set(symbol, { gateway, refCount: 0, evictTimer: null });
    this.notifyCreated(gateway);
    return gateway;
  }

  /** Creates (or returns) the gateway for a symbol and starts it if needed. */
  acquire(symbol: string): MarketGateway {
    const normalized = this.requireSupported(symbol);
    const existing = this.sessions.get(normalized);
    if (existing) {
      existing.refCount += 1;
      this.cancelEviction(existing);
      // start() is idempotent and restart-safe after a previous eviction stop().
      existing.gateway.start();
      return existing.gateway;
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new SessionCapacityError(
        `Market session limit reached (${this.maxSessions}); release a symbol first`,
      );
    }
    const gateway = this.createGateway(normalized, this.tickSizeFor(normalized));
    gateway.start();
    this.sessions.set(normalized, { gateway, refCount: 1, evictTimer: null });
    this.notifyCreated(gateway);
    return gateway;
  }

  /** Drops one reference; schedules eviction when the last client leaves. */
  release(symbol: string): void {
    const normalized = this.requireSupported(symbol);
    const session = this.sessions.get(normalized);
    if (!session) return;
    session.refCount = Math.max(0, session.refCount - 1);
    if (session.refCount > 0 || session.evictTimer) return;
    session.evictTimer = setTimeout(() => {
      this.evict(normalized);
    }, this.idleTtlMs);
    session.evictTimer.unref?.();
  }

  /** Peeks without creating or starting anything. */
  get(symbol: string): MarketGateway | null {
    return this.sessions.get(this.requireSupported(symbol))?.gateway ?? null;
  }

  has(symbol: string): boolean {
    return this.sessions.has(this.requireSupported(symbol));
  }

  /** Tears the session down immediately, cancelling any pending eviction. */
  evict(symbol: string): void {
    const session = this.sessions.get(symbol);
    if (!session) return;
    this.disposeSession(symbol, session);
  }

  /**
   * Disposes every session and waits for asynchronous teardowns (durable
   * history flush, capture close) so callers can shut down without losing
   * buffered records.
   */
  async drain(): Promise<void> {
    for (const [symbol, session] of [...this.sessions.entries()]) {
      this.disposeSession(symbol, session);
    }
    while (this.pendingDisposals.size > 0) {
      await Promise.all([...this.pendingDisposals]);
    }
  }

  stopAll(): void {
    for (const [symbol] of this.sessions) this.evict(symbol);
  }

  list(): SessionStatus[] {
    return [...this.sessions.entries()].map(([symbol, session]) => ({
      symbol,
      refCount: session.refCount,
      running: Boolean(session.gateway.status.sessionId),
      evictAtMs: session.evictTimer
        ? this.now() + this.idleTtlMs
        : null,
    }));
  }

  static supportedSymbols(): string[] {
    return supportedSymbols();
  }

  private disposeSession(symbol: string, session: ManagedSession): void {
    if (session.evictTimer) {
      clearTimeout(session.evictTimer);
      session.evictTimer = null;
    }
    // Remove first: re-acquiring during an async dispose must build a fresh,
    // restart-safe gateway instead of touching the closing one.
    this.sessions.delete(symbol);
    try {
      const result = this.disposeGateway(session.gateway);
      if (result instanceof Promise) {
        const tracked = result.catch((error: unknown) => {
          console.error(JSON.stringify({
            level: "error",
            component: "sessions",
            message: `Gateway dispose failed for ${symbol}`,
            detail: error instanceof Error ? error.message : String(error),
          }));
        });
        this.pendingDisposals.add(tracked);
        void tracked.then(() => { this.pendingDisposals.delete(tracked); });
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        component: "sessions",
        message: `Gateway dispose failed for ${symbol}`,
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private requireSupported(symbol: string): string {
    const normalized = symbol.trim().toUpperCase();
    if (!isSupportedSymbol(normalized)) {
      throw new UnknownSymbolError(`Unsupported symbol: ${symbol}`);
    }
    return normalized;
  }

  private cancelEviction(session: ManagedSession): void {
    if (session.evictTimer) {
      clearTimeout(session.evictTimer);
      session.evictTimer = null;
    }
  }
}

