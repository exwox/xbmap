import type { CSSProperties } from "react";

export type LiquiditySide = "bid" | "ask";
export type AggressorSide = "buy" | "sell";
export type TrendDirection =
  | "up"
  | "down"
  | "neutral"
  | "bullish"
  | "bearish"
  | "flat";

/** A price level can use either `quantity` (the wire format) or `size`. */
export interface HeatmapPriceLevel {
  price: number;
  quantity?: number;
  size?: number;
}

export interface HeatmapDepthFrame {
  timestamp: number;
  sequence?: number;
  bids: readonly HeatmapPriceLevel[];
  asks: readonly HeatmapPriceLevel[];
  midPrice?: number | null;
}

/**
 * Optional already-bucketed input. This is useful for a replay API that stores
 * heatmap cells instead of full depth frames.
 */
export interface HeatmapLiquidityCell {
  timestamp: number;
  price: number;
  liquidity: number;
  side?: LiquiditySide;
}

export interface HeatmapTradeBucket {
  timestamp: number;
  price?: number;
  vwap?: number;
  buyVolume?: number;
  sellVolume?: number;
  totalVolume?: number;
  volume?: number;
  side?: AggressorSide | "unknown";
  tradeCount?: number;
  /** Confidence may be expressed as either 0..1 or 0..100. */
  confidence?: number;
}

export interface HeatmapPricePoint {
  timestamp: number;
  price: number;
}

export interface HeatmapTrendSignal {
  direction: TrendDirection;
  score: number;
  /** Confidence may be expressed as either 0..1 or 0..100. */
  confidence?: number;
  reasons?: readonly string[];
  reason?: string;
  timestamp?: number;
}

export interface HeatmapViewport {
  startTime: number;
  endTime: number;
  minPrice: number;
  maxPrice: number;
}

export interface HeatmapHoverDetail {
  timestamp: number;
  price: number;
  liquidity?: number;
  liquiditySide?: LiquiditySide;
  tradeVolume?: number;
  tradeSide?: AggressorSide;
}

export type MarketDataStatus =
  | "idle"
  | "connecting"
  | "syncing"
  | "live"
  | "reconnecting"
  | "demo"
  | "stale"
  | "error"
  | "replay"
  | "closed";

export interface MarketHeatmapProps {
  depthFrames?: readonly HeatmapDepthFrame[];
  liquidityCells?: readonly HeatmapLiquidityCell[];
  trades?: readonly HeatmapTradeBucket[];
  priceSeries?: readonly HeatmapPricePoint[];
  trend?: HeatmapTrendSignal | null;
  symbol?: string;
  status?: MarketDataStatus;
  isStale?: boolean;
  staleSince?: number;
  /** If set, stale status is also inferred from the newest datum. */
  staleAfterMs?: number;
  /** Injectable clock, useful for deterministic replay/tests. */
  now?: number;
  /** Default visible time span while the viewport follows live data. */
  timeWindowMs?: number;
  tickSize?: number;
  priceBucketSize?: number;
  timeBucketMs?: number;
  priceDecimals?: number;
  heatmapThreshold?: number;
  bubbleScale?: number;
  maxBubbleRadius?: number;
  locale?: string;
  timeZone?: string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  initialViewport?: HeatmapViewport;
  onViewportChange?: (viewport: HeatmapViewport) => void;
  onHover?: (detail: HeatmapHoverDetail | null) => void;
  /**
   * Opt-in deterministic sample data. It is visibly marked as DEMO and is
   * never mixed with live input. A number is used as the PRNG seed.
   */
  demoData?: boolean | number;
}

export interface NormalizedTrade {
  timestamp: number;
  price: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  side: AggressorSide;
  tradeCount?: number;
  confidence?: number;
}

export interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
