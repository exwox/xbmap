/**
 * One-way integration contract between the gateway and the observability
 * service. `MarketGateway` only depends on this value object; it never imports
 * the registry or the HTTP layer, which keeps the dependency direction acyclic.
 */

export type IncidentKind =
  | "sequence_gap"
  | "duplicate"
  | "out_of_order"
  | "malformed"
  | "crossed_book"
  | "resync"
  | "queue_overflow"
  | "stale"
  | "recovered";

export interface GatewayMetricsHooks {
  /** A normalized event accepted from the feed pipeline. */
  received(type: string): void;
  /** A feed event rejected/countered before publication (raw rate counters). */
  rejected(reason: string): void;
  /** Wall-time duration to process a single depth/trade/snapshot item. */
  processed(type: string, durationMs: number): void;
  /** Wall-time duration to build and emit one frame. */
  frameBuilt(durationMs: number): void;
  /** Explicit invariant/recovery incident observed on the hot path. */
  incident(kind: IncidentKind, reason?: string): void;
}