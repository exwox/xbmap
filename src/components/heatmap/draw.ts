import type {
  HeatmapDepthFrame,
  HeatmapHoverDetail,
  HeatmapLiquidityCell,
  HeatmapPricePoint,
  HeatmapTradeBucket,
  HeatmapTrendSignal,
  HeatmapViewport,
  LiquiditySide,
  MarketDataStatus,
  NormalizedTrade,
  PlotRect,
} from "./types";

const BACKGROUND = "#070b12";
const AXIS_BACKGROUND = "#090f18";
const GRID = "rgba(144, 164, 190, 0.105)";
const TEXT = "#d9e3f0";
const MUTED_TEXT = "#7e91a9";
const BUY = "#37d6bd";
const SELL = "#ff6f91";
const PRICE_LINE = "#eaf2ff";
const QUANTIZATION_LEVELS = 22;

export const CHART_INSETS = {
  left: 12,
  right: 86,
  top: 10,
  bottom: 34,
} as const;

export interface DataViewportInput {
  depthFrames: readonly HeatmapDepthFrame[];
  liquidityCells: readonly HeatmapLiquidityCell[];
  trades: readonly NormalizedTrade[];
  priceSeries: readonly HeatmapPricePoint[];
  timeWindowMs: number;
  tickSize?: number;
  fallbackNow: number;
}

export interface MarketLayerOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  dpr: number;
  viewport: HeatmapViewport;
  depthFrames: readonly HeatmapDepthFrame[];
  liquidityCells: readonly HeatmapLiquidityCell[];
  trades: readonly NormalizedTrade[];
  priceSeries: readonly HeatmapPricePoint[];
  trend?: HeatmapTrendSignal | null;
  symbol: string;
  status: MarketDataStatus;
  stale: boolean;
  staleSince?: number;
  demo: boolean;
  heatmapThreshold: number;
  bubbleScale: number;
  maxBubbleRadius: number;
  timeBucketMs?: number;
  priceBucketSize?: number;
  tickSize?: number;
  formatPrice: (price: number) => string;
  formatTime: (timestamp: number, includeSeconds?: boolean) => string;
}

export interface OverlayOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  dpr: number;
  viewport: HeatmapViewport;
  hover: HeatmapHoverDetail | null;
  pointer: { x: number; y: number } | null;
  focused: boolean;
  formatPrice: (price: number) => string;
  formatTime: (timestamp: number, includeSeconds?: boolean) => string;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeQuantity(level: { quantity?: number; size?: number }): number {
  const quantity = isFiniteNumber(level.quantity) ? level.quantity : level.size;
  return isFiniteNumber(quantity) && quantity > 0 ? quantity : 0;
}

export function getPlotRect(width: number, height: number): PlotRect {
  return {
    x: CHART_INSETS.left,
    y: CHART_INSETS.top,
    width: Math.max(1, width - CHART_INSETS.left - CHART_INSETS.right),
    height: Math.max(1, height - CHART_INSETS.top - CHART_INSETS.bottom),
  };
}

function resolvedMidPrice(frame: HeatmapDepthFrame): number | undefined {
  if (isFiniteNumber(frame.midPrice)) return frame.midPrice;
  const bestBid = frame.bids[0]?.price;
  const bestAsk = frame.asks[0]?.price;
  if (isFiniteNumber(bestBid) && isFiniteNumber(bestAsk)) {
    return (bestBid + bestAsk) / 2;
  }
  if (isFiniteNumber(bestBid)) return bestBid;
  if (isFiniteNumber(bestAsk)) return bestAsk;
  return undefined;
}

export function preparePriceSeries(
  priceSeries: readonly HeatmapPricePoint[],
  depthFrames: readonly HeatmapDepthFrame[],
): HeatmapPricePoint[] {
  const source = priceSeries.length > 0
    ? priceSeries
    : depthFrames.flatMap((frame) => {
        const price = resolvedMidPrice(frame);
        return price === undefined ? [] : [{ timestamp: frame.timestamp, price }];
      });

  return source
    .filter(
      (point) =>
        isFiniteNumber(point.timestamp) && isFiniteNumber(point.price),
    )
    .slice()
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function normalizeTrades(
  trades: readonly HeatmapTradeBucket[],
): NormalizedTrade[] {
  return trades
    .flatMap((trade): NormalizedTrade[] => {
      const price = isFiniteNumber(trade.vwap) ? trade.vwap : trade.price;
      if (!isFiniteNumber(trade.timestamp) || !isFiniteNumber(price)) return [];

      const buyVolume = isFiniteNumber(trade.buyVolume)
        ? Math.max(0, trade.buyVolume)
        : trade.side === "buy" && isFiniteNumber(trade.volume)
          ? Math.max(0, trade.volume)
          : 0;
      const sellVolume = isFiniteNumber(trade.sellVolume)
        ? Math.max(0, trade.sellVolume)
        : trade.side === "sell" && isFiniteNumber(trade.volume)
          ? Math.max(0, trade.volume)
          : 0;
      const inferredTotal = buyVolume + sellVolume;
      const totalVolume = isFiniteNumber(trade.totalVolume)
        ? Math.max(0, trade.totalVolume)
        : isFiniteNumber(trade.volume)
          ? Math.max(0, trade.volume)
          : inferredTotal;
      if (totalVolume <= 0) return [];

      return [
        {
          timestamp: trade.timestamp,
          price,
          buyVolume,
          sellVolume,
          totalVolume,
          side:
            trade.side === "buy" || trade.side === "sell"
              ? trade.side
              : buyVolume >= sellVolume
                ? "buy"
                : "sell",
          tradeCount: trade.tradeCount,
          confidence: trade.confidence,
        },
      ];
    })
    .sort((left, right) => left.timestamp - right.timestamp);
}

function includePrice(
  price: number,
  state: { min: number; max: number },
): void {
  if (!Number.isFinite(price)) return;
  state.min = Math.min(state.min, price);
  state.max = Math.max(state.max, price);
}

export function calculateDataViewport({
  depthFrames,
  liquidityCells,
  trades,
  priceSeries,
  timeWindowMs,
  tickSize,
  fallbackNow,
}: DataViewportInput): HeatmapViewport {
  let latest = Number.NEGATIVE_INFINITY;

  const includeTime = (timestamp: number): void => {
    if (!Number.isFinite(timestamp)) return;
    latest = Math.max(latest, timestamp);
  };

  depthFrames.forEach((frame) => includeTime(frame.timestamp));
  liquidityCells.forEach((cell) => includeTime(cell.timestamp));
  trades.forEach((trade) => includeTime(trade.timestamp));
  priceSeries.forEach((point) => includeTime(point.timestamp));

  if (!Number.isFinite(latest)) {
    latest = fallbackNow;
  }

  const safeTimeWindow = Math.max(1_000, timeWindowMs);
  const startTime = latest - safeTimeWindow;
  const priceRange = {
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
  };

  priceSeries.forEach((point) => {
    if (point.timestamp >= startTime) includePrice(point.price, priceRange);
  });
  trades.forEach((trade) => {
    if (trade.timestamp >= startTime) includePrice(trade.price, priceRange);
  });
  liquidityCells.forEach((cell) => {
    if (cell.timestamp >= startTime) includePrice(cell.price, priceRange);
  });
  depthFrames.forEach((frame) => {
    if (frame.timestamp < startTime) return;
    const midPrice = resolvedMidPrice(frame);
    if (midPrice !== undefined) includePrice(midPrice, priceRange);
    frame.bids.forEach((level) => includePrice(level.price, priceRange));
    frame.asks.forEach((level) => includePrice(level.price, priceRange));
  });

  if (!Number.isFinite(priceRange.min) || !Number.isFinite(priceRange.max)) {
    priceRange.min = 0;
    priceRange.max = 1;
  }

  const center = (priceRange.min + priceRange.max) / 2;
  const minimumSpan = Math.max(
    isFiniteNumber(tickSize) && tickSize > 0 ? tickSize * 20 : 0,
    Math.abs(center) * 0.001,
    1e-8,
  );
  const rawSpan = Math.max(priceRange.max - priceRange.min, minimumSpan);
  const padding = rawSpan * 0.075;

  return {
    startTime,
    endTime: latest,
    minPrice: center - rawSpan / 2 - padding,
    maxPrice: center + rawSpan / 2 + padding,
  };
}

export function xForTime(
  timestamp: number,
  viewport: HeatmapViewport,
  plot: PlotRect,
): number {
  return (
    plot.x +
    ((timestamp - viewport.startTime) /
      Math.max(1, viewport.endTime - viewport.startTime)) *
      plot.width
  );
}

export function yForPrice(
  price: number,
  viewport: HeatmapViewport,
  plot: PlotRect,
): number {
  return (
    plot.y +
    ((viewport.maxPrice - price) /
      Math.max(Number.EPSILON, viewport.maxPrice - viewport.minPrice)) *
      plot.height
  );
}

export function timeForX(
  x: number,
  viewport: HeatmapViewport,
  plot: PlotRect,
): number {
  return (
    viewport.startTime +
    ((x - plot.x) / Math.max(1, plot.width)) *
      (viewport.endTime - viewport.startTime)
  );
}

export function priceForY(
  y: number,
  viewport: HeatmapViewport,
  plot: PlotRect,
): number {
  return (
    viewport.maxPrice -
    ((y - plot.y) / Math.max(1, plot.height)) *
      (viewport.maxPrice - viewport.minPrice)
  );
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 1;
  values.sort((left, right) => left - right);
  const index = Math.floor(clamp(ratio, 0, 1) * (values.length - 1));
  return Math.max(Number.EPSILON, values[index] ?? 1);
}

function medianPositiveDelta(timestamps: readonly number[]): number | undefined {
  if (timestamps.length < 2) return undefined;
  const deltas: number[] = [];
  const stride = Math.max(1, Math.floor(timestamps.length / 512));
  for (let index = stride; index < timestamps.length; index += stride) {
    const delta = timestamps[index] - timestamps[index - stride];
    if (delta > 0 && Number.isFinite(delta)) deltas.push(delta / stride);
  }
  return deltas.length === 0 ? undefined : percentile(deltas, 0.5);
}

function inferredPriceBucket(
  frames: readonly HeatmapDepthFrame[],
  cells: readonly HeatmapLiquidityCell[],
  tickSize: number | undefined,
  viewport: HeatmapViewport,
): number {
  if (isFiniteNumber(tickSize) && tickSize > 0) return tickSize;
  const firstLevels = frames[0]?.bids ?? frames[0]?.asks;
  if (firstLevels && firstLevels.length > 1) {
    const difference = Math.abs(firstLevels[0].price - firstLevels[1].price);
    if (difference > 0 && Number.isFinite(difference)) return difference;
  }
  if (cells.length > 1) {
    const base = cells[0];
    for (let index = 1; index < Math.min(cells.length, 100); index += 1) {
      const difference = Math.abs(cells[index].price - base.price);
      if (difference > 0 && Number.isFinite(difference)) return difference;
    }
  }
  return Math.max(
    Number.EPSILON,
    (viewport.maxPrice - viewport.minPrice) / 120,
  );
}

function mix(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  ratio: number,
): [number, number, number] {
  return [
    Math.round(from[0] + (to[0] - from[0]) * ratio),
    Math.round(from[1] + (to[1] - from[1]) * ratio),
    Math.round(from[2] + (to[2] - from[2]) * ratio),
  ];
}

function liquidityColor(level: number, side: LiquiditySide): string {
  const amount = (level + 1) / QUANTIZATION_LEVELS;
  const cold: readonly [number, number, number] =
    side === "bid" ? [8, 63, 91] : [54, 37, 91];
  const medium: readonly [number, number, number] =
    side === "bid" ? [15, 191, 174] : [197, 73, 132];
  const hot: readonly [number, number, number] = [255, 213, 86];
  const hottest: readonly [number, number, number] = [255, 247, 173];
  let color: [number, number, number];

  if (amount < 0.5) {
    color = mix(cold, medium, amount / 0.5);
  } else if (amount < 0.82) {
    color = mix(medium, hot, (amount - 0.5) / 0.32);
  } else {
    color = mix(hot, hottest, (amount - 0.82) / 0.18);
  }
  const alpha = 0.2 + amount * 0.76;
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height,
  );
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function compactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function normalizedTrendDirection(
  trend: HeatmapTrendSignal | null | undefined,
): "up" | "down" | "neutral" {
  if (!trend) return "neutral";
  if (trend.direction === "up" || trend.direction === "bullish") return "up";
  if (trend.direction === "down" || trend.direction === "bearish") return "down";
  return "neutral";
}

function normalizedConfidence(value: number | undefined): number {
  if (!isFiniteNumber(value)) return 0;
  return clamp(value <= 1 ? value * 100 : value, 0, 100);
}

function drawGrid(
  context: CanvasRenderingContext2D,
  plot: PlotRect,
  verticalTicks: number,
  horizontalTicks: number,
): void {
  context.save();
  context.strokeStyle = GRID;
  context.lineWidth = 1;
  context.beginPath();
  for (let index = 0; index <= verticalTicks; index += 1) {
    const x = Math.round(plot.x + (plot.width * index) / verticalTicks) + 0.5;
    context.moveTo(x, plot.y);
    context.lineTo(x, plot.y + plot.height);
  }
  for (let index = 0; index <= horizontalTicks; index += 1) {
    const y = Math.round(plot.y + (plot.height * index) / horizontalTicks) + 0.5;
    context.moveTo(plot.x, y);
    context.lineTo(plot.x + plot.width, y);
  }
  context.stroke();
  context.restore();
}

function drawHeatmap(
  context: CanvasRenderingContext2D,
  options: MarketLayerOptions,
  plot: PlotRect,
): void {
  const {
    depthFrames,
    liquidityCells,
    viewport,
    heatmapThreshold,
    timeBucketMs,
    priceBucketSize,
    tickSize,
  } = options;
  if (depthFrames.length === 0 && liquidityCells.length === 0) return;

  let totalCellCount = liquidityCells.length;
  depthFrames.forEach((frame) => {
    totalCellCount += frame.bids.length + frame.asks.length;
  });
  const sampleStride = Math.max(1, Math.ceil(totalCellCount / 6_000));
  const quantitySample: number[] = [];
  let sampleIndex = 0;

  const sampleQuantity = (quantity: number, timestamp: number, price: number): void => {
    if (
      timestamp < viewport.startTime ||
      timestamp > viewport.endTime ||
      price < viewport.minPrice ||
      price > viewport.maxPrice
    ) return;
    if (sampleIndex % sampleStride === 0 && quantity > 0) {
      quantitySample.push(quantity);
    }
    sampleIndex += 1;
  };

  depthFrames.forEach((frame) => {
    frame.bids.forEach((level) =>
      sampleQuantity(safeQuantity(level), frame.timestamp, level.price),
    );
    frame.asks.forEach((level) =>
      sampleQuantity(safeQuantity(level), frame.timestamp, level.price),
    );
  });
  liquidityCells.forEach((cell) =>
    sampleQuantity(cell.liquidity, cell.timestamp, cell.price),
  );

  const upperLiquidity = percentile(quantitySample, 0.975);
  const logUpper = Math.log1p(upperLiquidity);
  const timestamps = depthFrames.length > 0
    ? depthFrames.map((frame) => frame.timestamp)
    : liquidityCells.slice(0, 1_500).map((cell) => cell.timestamp);
  const inferredTimeBucket =
    timeBucketMs ?? medianPositiveDelta(timestamps) ?? 1_000;
  const inferredPriceStep =
    priceBucketSize ??
    inferredPriceBucket(depthFrames, liquidityCells, tickSize, viewport);
  const cellWidth = clamp(
    (inferredTimeBucket /
      Math.max(1, viewport.endTime - viewport.startTime)) *
      plot.width +
      0.8,
    1,
    plot.width,
  );
  const cellHeight = clamp(
    (inferredPriceStep /
      Math.max(Number.EPSILON, viewport.maxPrice - viewport.minPrice)) *
      plot.height +
      0.8,
    1,
    plot.height,
  );
  const buckets = Array.from(
    { length: QUANTIZATION_LEVELS * 2 },
    (): number[] => [],
  );

  const queueCell = (
    timestamp: number,
    price: number,
    quantity: number,
    side: LiquiditySide,
  ): void => {
    if (
      quantity <= 0 ||
      timestamp + inferredTimeBucket < viewport.startTime ||
      timestamp > viewport.endTime ||
      price + inferredPriceStep / 2 < viewport.minPrice ||
      price - inferredPriceStep / 2 > viewport.maxPrice
    ) return;
    const normalized = logUpper > 0 ? Math.log1p(quantity) / logUpper : 0;
    const threshold = clamp(heatmapThreshold, 0, 0.94);
    if (normalized < threshold) return;
    const visibleIntensity = clamp(
      (normalized - threshold) / Math.max(0.06, 1 - threshold),
      0,
      1,
    );
    const level = clamp(
      Math.floor(visibleIntensity * QUANTIZATION_LEVELS),
      0,
      QUANTIZATION_LEVELS - 1,
    );
    const bucketIndex = level + (side === "ask" ? QUANTIZATION_LEVELS : 0);
    buckets[bucketIndex].push(
      xForTime(timestamp, viewport, plot),
      yForPrice(price, viewport, plot) - cellHeight / 2,
      cellWidth,
      cellHeight,
    );
  };

  depthFrames.forEach((frame) => {
    frame.bids.forEach((level) =>
      queueCell(frame.timestamp, level.price, safeQuantity(level), "bid"),
    );
    frame.asks.forEach((level) =>
      queueCell(frame.timestamp, level.price, safeQuantity(level), "ask"),
    );
  });
  liquidityCells.forEach((cell) =>
    queueCell(
      cell.timestamp,
      cell.price,
      Math.max(0, cell.liquidity),
      cell.side ?? "bid",
    ),
  );

  context.save();
  context.beginPath();
  context.rect(plot.x, plot.y, plot.width, plot.height);
  context.clip();
  buckets.forEach((rectangles, bucketIndex) => {
    if (rectangles.length === 0) return;
    const level = bucketIndex % QUANTIZATION_LEVELS;
    const side: LiquiditySide =
      bucketIndex >= QUANTIZATION_LEVELS ? "ask" : "bid";
    context.fillStyle = liquidityColor(level, side);
    context.beginPath();
    for (let index = 0; index < rectangles.length; index += 4) {
      context.rect(
        rectangles[index],
        rectangles[index + 1],
        rectangles[index + 2],
        rectangles[index + 3],
      );
    }
    context.fill();
  });
  context.restore();
}

function drawTrendTint(
  context: CanvasRenderingContext2D,
  plot: PlotRect,
  trend: HeatmapTrendSignal | null | undefined,
): void {
  const direction = normalizedTrendDirection(trend);
  const score = clamp(trend?.score ?? 0, 0, 100);
  if (direction === "neutral" || score < 40) return;
  const color = direction === "up" ? "55, 214, 189" : "255, 111, 145";
  const gradient = context.createLinearGradient(plot.x, plot.y, plot.x, plot.y + plot.height);
  gradient.addColorStop(0, `rgba(${color}, ${0.035 + score * 0.00065})`);
  gradient.addColorStop(0.38, `rgba(${color}, 0.018)`);
  gradient.addColorStop(1, `rgba(${color}, 0)`);
  context.fillStyle = gradient;
  context.fillRect(plot.x, plot.y, plot.width, plot.height);
}

function drawPriceLine(
  context: CanvasRenderingContext2D,
  options: MarketLayerOptions,
  plot: PlotRect,
): void {
  const visible = options.priceSeries.filter(
    (point) =>
      point.timestamp >= options.viewport.startTime &&
      point.timestamp <= options.viewport.endTime,
  );
  if (visible.length === 0) return;

  context.save();
  context.beginPath();
  context.rect(plot.x, plot.y, plot.width, plot.height);
  context.clip();
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  visible.forEach((point, index) => {
    const x = xForTime(point.timestamp, options.viewport, plot);
    const y = yForPrice(point.price, options.viewport, plot);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = "rgba(3, 8, 14, 0.92)";
  context.lineWidth = 4.5;
  context.stroke();
  context.strokeStyle = PRICE_LINE;
  context.lineWidth = 1.35;
  context.stroke();
  context.restore();
}

function drawBubbles(
  context: CanvasRenderingContext2D,
  options: MarketLayerOptions,
  plot: PlotRect,
): void {
  if (options.bubbleScale <= 0) return;
  const visible = options.trades.filter(
    (trade) =>
      trade.timestamp >= options.viewport.startTime &&
      trade.timestamp <= options.viewport.endTime &&
      trade.price >= options.viewport.minPrice &&
      trade.price <= options.viewport.maxPrice,
  );
  if (visible.length === 0) return;
  const volumes = visible.map((trade) => trade.totalVolume);
  const medianVolume = Math.max(Number.EPSILON, percentile(volumes, 0.5));
  const stride = Math.max(1, Math.ceil(visible.length / 2_500));

  context.save();
  context.beginPath();
  context.rect(plot.x, plot.y, plot.width, plot.height);
  context.clip();
  visible.forEach((trade, index) => {
    if (index % stride !== 0) return;
    const x = xForTime(trade.timestamp, options.viewport, plot);
    const y = yForPrice(trade.price, options.viewport, plot);
    const radius = clamp(
      4 + options.bubbleScale * 5.5 * Math.sqrt(trade.totalVolume / medianVolume),
      4,
      options.maxBubbleRadius,
    );
    const buy = trade.side === "buy";
    const color = buy ? BUY : SELL;
    const confidence = normalizedConfidence(trade.confidence);
    const alpha = confidence > 0 ? 0.18 + (confidence / 100) * 0.22 : 0.33;

    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = buy
      ? `rgba(55, 214, 189, ${alpha})`
      : `rgba(255, 111, 145, ${alpha})`;
    context.fill();
    context.setLineDash(buy ? [] : [3, 2]);
    context.strokeStyle = color;
    context.lineWidth = radius > 14 ? 2 : 1.4;
    context.stroke();
    context.setLineDash([]);

    if (radius >= 7.5) {
      const arrowSize = clamp(radius * 0.34, 2.8, 7);
      context.beginPath();
      if (buy) {
        context.moveTo(x, y - arrowSize);
        context.lineTo(x - arrowSize * 0.78, y + arrowSize * 0.48);
        context.lineTo(x + arrowSize * 0.78, y + arrowSize * 0.48);
      } else {
        context.moveTo(x, y + arrowSize);
        context.lineTo(x - arrowSize * 0.78, y - arrowSize * 0.48);
        context.lineTo(x + arrowSize * 0.78, y - arrowSize * 0.48);
      }
      context.closePath();
      context.fillStyle = color;
      context.fill();
    }

    if (radius >= 20) {
      context.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = TEXT;
      context.fillText(compactNumber(trade.totalVolume), x, y + (buy ? 10 : -10));
    }
  });
  context.restore();
}

function drawAxes(
  context: CanvasRenderingContext2D,
  options: MarketLayerOptions,
  plot: PlotRect,
): void {
  const verticalTicks = clamp(Math.floor(plot.width / 140), 3, 8);
  const horizontalTicks = clamp(Math.floor(plot.height / 68), 4, 10);
  context.save();
  context.fillStyle = AXIS_BACKGROUND;
  context.fillRect(plot.x + plot.width, 0, options.width - plot.x - plot.width, options.height);
  context.fillRect(0, plot.y + plot.height, options.width, options.height - plot.y - plot.height);
  context.strokeStyle = "rgba(139, 158, 181, 0.22)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(plot.x + plot.width + 0.5, plot.y);
  context.lineTo(plot.x + plot.width + 0.5, plot.y + plot.height);
  context.moveTo(plot.x, plot.y + plot.height + 0.5);
  context.lineTo(plot.x + plot.width, plot.y + plot.height + 0.5);
  context.stroke();

  context.font = "500 10px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.fillStyle = MUTED_TEXT;
  context.textBaseline = "middle";
  context.textAlign = "left";
  for (let index = 0; index <= horizontalTicks; index += 1) {
    const ratio = index / horizontalTicks;
    const y = plot.y + ratio * plot.height;
    const price =
      options.viewport.maxPrice -
      ratio * (options.viewport.maxPrice - options.viewport.minPrice);
    context.fillText(options.formatPrice(price), plot.x + plot.width + 8, y);
  }

  context.textAlign = "center";
  context.textBaseline = "top";
  for (let index = 0; index <= verticalTicks; index += 1) {
    const ratio = index / verticalTicks;
    const x = plot.x + ratio * plot.width;
    const timestamp =
      options.viewport.startTime +
      ratio * (options.viewport.endTime - options.viewport.startTime);
    context.fillText(options.formatTime(timestamp), x, plot.y + plot.height + 9);
  }
  context.restore();
}

function drawLastPriceMarker(
  context: CanvasRenderingContext2D,
  options: MarketLayerOptions,
  plot: PlotRect,
): void {
  let latest: HeatmapPricePoint | undefined;
  options.priceSeries.forEach((point) => {
    if (
      point.timestamp <= options.viewport.endTime &&
      (!latest || point.timestamp > latest.timestamp)
    ) latest = point;
  });
  if (!latest || latest.price < options.viewport.minPrice || latest.price > options.viewport.maxPrice) {
    return;
  }
  const y = yForPrice(latest.price, options.viewport, plot);
  const label = options.formatPrice(latest.price);
  context.save();
  context.strokeStyle = "rgba(234, 242, 255, 0.62)";
  context.setLineDash([4, 4]);
  context.beginPath();
  context.moveTo(plot.x, y + 0.5);
  context.lineTo(plot.x + plot.width, y + 0.5);
  context.stroke();
  context.setLineDash([]);
  context.font = "700 10px ui-monospace, SFMono-Regular, Menlo, monospace";
  const labelWidth = context.measureText(label).width + 14;
  roundedRect(context, plot.x + plot.width + 3, y - 10, labelWidth, 20, 4);
  context.fillStyle = "#dfe9f6";
  context.fill();
  context.fillStyle = "#07101a";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(label, plot.x + plot.width + 10, y);
  context.restore();
}

function drawHeader(
  context: CanvasRenderingContext2D,
  options: MarketLayerOptions,
  plot: PlotRect,
): void {
  const direction = normalizedTrendDirection(options.trend);
  const score = clamp(options.trend?.score ?? 0, 0, 100);
  const confidence = normalizedConfidence(options.trend?.confidence);
  const headerY = plot.y + 10;

  context.save();
  context.textBaseline = "middle";
  context.font = "700 12px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillStyle = TEXT;
  context.fillText(options.symbol, plot.x + 10, headerY + 8);

  let left = plot.x + 10 + context.measureText(options.symbol).width + 14;
  if (options.demo) {
    context.font = "700 9px Inter, ui-sans-serif, system-ui, sans-serif";
    roundedRect(context, left, headerY, 42, 17, 4);
    context.fillStyle = "rgba(255, 202, 88, 0.14)";
    context.fill();
    context.strokeStyle = "rgba(255, 202, 88, 0.6)";
    context.stroke();
    context.fillStyle = "#ffd778";
    context.textAlign = "center";
    context.fillText("DEMO", left + 21, headerY + 8.5);
    context.textAlign = "left";
    left += 51;
  }

  if (options.trend) {
    const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "◆";
    const directionLabel =
      direction === "up" ? "UP TREND" : direction === "down" ? "DOWN TREND" : "NEUTRAL";
    const trendColor = direction === "up" ? BUY : direction === "down" ? SELL : "#9caec3";
    const reason = options.trend.reasons?.[0] ?? options.trend.reason;
    const scoreText = `${arrow} ${directionLabel} ${Math.round(score)}`;
    const confidenceText = confidence > 0 ? ` · ${Math.round(confidence)}% conf` : "";
    const reasonText = reason ? ` · ${reason}` : "";
    const text = `${scoreText}${confidenceText}${reasonText}`;
    context.font = "650 10px Inter, ui-sans-serif, system-ui, sans-serif";
    const maximumWidth = Math.max(100, plot.width - (left - plot.x) - 112);
    const measuredWidth = Math.min(context.measureText(text).width + 18, maximumWidth);
    roundedRect(context, left, headerY, measuredWidth, 18, 5);
    context.fillStyle = direction === "up"
      ? "rgba(55, 214, 189, 0.12)"
      : direction === "down"
        ? "rgba(255, 111, 145, 0.12)"
        : "rgba(156, 174, 195, 0.11)";
    context.fill();
    context.strokeStyle = direction === "up"
      ? "rgba(55, 214, 189, 0.42)"
      : direction === "down"
        ? "rgba(255, 111, 145, 0.42)"
        : "rgba(156, 174, 195, 0.32)";
    context.stroke();
    context.fillStyle = trendColor;
    context.save();
    context.beginPath();
    context.rect(left + 8, headerY, Math.max(1, measuredWidth - 14), 18);
    context.clip();
    context.fillText(text, left + 9, headerY + 9);
    context.restore();
  }

  const statusText = options.stale
    ? "STALE"
    : options.status === "live"
      ? "LIVE"
      : options.status.toUpperCase();
  const statusColor = options.stale || options.status === "error"
    ? SELL
    : options.status === "live"
      ? BUY
      : "#f4c76b";
  context.font = "700 9px Inter, ui-sans-serif, system-ui, sans-serif";
  const statusWidth = context.measureText(statusText).width + 25;
  const statusX = plot.x + plot.width - statusWidth - 8;
  roundedRect(context, statusX, headerY, statusWidth, 18, 9);
  context.fillStyle = "rgba(5, 11, 18, 0.8)";
  context.fill();
  context.strokeStyle = `${statusColor}88`;
  context.stroke();
  context.fillStyle = statusColor;
  context.beginPath();
  context.arc(statusX + 9, headerY + 9, 2.5, 0, Math.PI * 2);
  context.fill();
  context.fillText(statusText, statusX + 15, headerY + 9);
  context.restore();
}

function drawLegend(
  context: CanvasRenderingContext2D,
  plot: PlotRect,
): void {
  const y = plot.y + plot.height - 15;
  const x = plot.x + 10;
  context.save();
  context.font = "600 9px Inter, ui-sans-serif, system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillStyle = "rgba(6, 12, 20, 0.74)";
  roundedRect(context, x - 5, y - 9, 190, 18, 4);
  context.fill();
  context.fillStyle = BUY;
  context.fillText("▲ BUY", x, y);
  context.fillStyle = SELL;
  context.fillText("▼ SELL", x + 48, y);
  context.fillStyle = "#facd5b";
  context.fillText("▰ HIGH LIQUIDITY", x + 100, y);
  context.restore();
}

function drawStaleOverlay(
  context: CanvasRenderingContext2D,
  options: MarketLayerOptions,
  plot: PlotRect,
): void {
  if (!options.stale) return;
  context.save();
  context.beginPath();
  context.rect(plot.x, plot.y, plot.width, plot.height);
  context.clip();
  context.fillStyle = "rgba(4, 8, 14, 0.61)";
  context.fillRect(plot.x, plot.y, plot.width, plot.height);
  context.strokeStyle = "rgba(255, 111, 145, 0.12)";
  context.lineWidth = 1;
  const stripeGap = 22;
  for (
    let offset = -plot.height;
    offset < plot.width + plot.height;
    offset += stripeGap
  ) {
    context.beginPath();
    context.moveTo(plot.x + offset, plot.y + plot.height);
    context.lineTo(plot.x + offset + plot.height, plot.y);
    context.stroke();
  }

  const boxWidth = Math.min(310, plot.width - 24);
  const boxHeight = 68;
  const boxX = plot.x + (plot.width - boxWidth) / 2;
  const boxY = plot.y + (plot.height - boxHeight) / 2;
  roundedRect(context, boxX, boxY, boxWidth, boxHeight, 8);
  context.fillStyle = "rgba(13, 18, 27, 0.95)";
  context.fill();
  context.strokeStyle = "rgba(255, 111, 145, 0.72)";
  context.lineWidth = 1.2;
  context.stroke();
  context.fillStyle = SELL;
  context.font = "800 13px Inter, ui-sans-serif, system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("⚠ DATA STALE — LIVE VIEW PAUSED", boxX + boxWidth / 2, boxY + 24);
  context.fillStyle = "#aab8c9";
  context.font = "500 10px Inter, ui-sans-serif, system-ui, sans-serif";
  const detail = options.staleSince
    ? `No valid update since ${options.formatTime(options.staleSince, true)}`
    : "Waiting for a fresh, sequence-valid market update";
  context.fillText(detail, boxX + boxWidth / 2, boxY + 45);
  context.restore();
}

function drawEmptyState(
  context: CanvasRenderingContext2D,
  options: MarketLayerOptions,
  plot: PlotRect,
): void {
  if (
    options.depthFrames.length > 0 ||
    options.liquidityCells.length > 0 ||
    options.priceSeries.length > 0 ||
    options.trades.length > 0
  ) return;
  context.save();
  context.fillStyle = "#8598af";
  context.font = "600 13px Inter, ui-sans-serif, system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("Waiting for sequence-valid market data…", plot.x + plot.width / 2, plot.y + plot.height / 2 - 8);
  context.fillStyle = "#52657c";
  context.font = "500 10px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText("The heatmap will start after the initial order-book snapshot", plot.x + plot.width / 2, plot.y + plot.height / 2 + 14);
  context.restore();
}

function configureCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number,
  alpha = false,
): CanvasRenderingContext2D | null {
  const backingWidth = Math.max(1, Math.round(width * dpr));
  const backingHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
  const context = canvas.getContext("2d", { alpha });
  if (!context) return null;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.imageSmoothingEnabled = false;
  return context;
}

export function drawMarketLayer(options: MarketLayerOptions): void {
  if (options.width <= 0 || options.height <= 0) return;
  const context = configureCanvas(
    options.canvas,
    options.width,
    options.height,
    options.dpr,
    false,
  );
  if (!context) return;
  const plot = getPlotRect(options.width, options.height);
  const verticalTicks = clamp(Math.floor(plot.width / 140), 3, 8);
  const horizontalTicks = clamp(Math.floor(plot.height / 68), 4, 10);

  context.clearRect(0, 0, options.width, options.height);
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, options.width, options.height);
  drawGrid(context, plot, verticalTicks, horizontalTicks);
  drawHeatmap(context, options, plot);
  drawTrendTint(context, plot, options.trend);
  drawGrid(context, plot, verticalTicks, horizontalTicks);
  drawPriceLine(context, options, plot);
  drawBubbles(context, options, plot);
  drawAxes(context, options, plot);
  drawLastPriceMarker(context, options, plot);
  drawHeader(context, options, plot);
  drawLegend(context, plot);
  drawEmptyState(context, options, plot);
  drawStaleOverlay(context, options, plot);
}

function nearestTimeIndex<T extends { timestamp: number }>(
  items: readonly T[],
  timestamp: number,
): number {
  if (items.length === 0) return -1;
  let low = 0;
  let high = items.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle].timestamp < timestamp) low = middle + 1;
    else high = middle - 1;
  }
  if (low <= 0) return 0;
  if (low >= items.length) return items.length - 1;
  return Math.abs(items[low].timestamp - timestamp) <
    Math.abs(items[low - 1].timestamp - timestamp)
    ? low
    : low - 1;
}

function closestLevel(
  frame: HeatmapDepthFrame,
  price: number,
): { liquidity: number; side: LiquiditySide; price: number } | undefined {
  let best:
    | { liquidity: number; side: LiquiditySide; price: number; difference: number }
    | undefined;
  const visit = (
    levels: HeatmapDepthFrame["bids"],
    side: LiquiditySide,
  ): void => {
    levels.forEach((level) => {
      const quantity = safeQuantity(level);
      if (quantity <= 0 || !isFiniteNumber(level.price)) return;
      const difference = Math.abs(level.price - price);
      if (!best || difference < best.difference) {
        best = { liquidity: quantity, side, price: level.price, difference };
      }
    });
  };
  visit(frame.bids, "bid");
  visit(frame.asks, "ask");
  return best;
}

export interface HoverLookupInput {
  pointer: { x: number; y: number };
  width: number;
  height: number;
  viewport: HeatmapViewport;
  depthFrames: readonly HeatmapDepthFrame[];
  liquidityCells: readonly HeatmapLiquidityCell[];
  trades: readonly NormalizedTrade[];
}

export function lookupHoverDetail({
  pointer,
  width,
  height,
  viewport,
  depthFrames,
  liquidityCells,
  trades,
}: HoverLookupInput): HeatmapHoverDetail | null {
  const plot = getPlotRect(width, height);
  if (
    pointer.x < plot.x ||
    pointer.x > plot.x + plot.width ||
    pointer.y < plot.y ||
    pointer.y > plot.y + plot.height
  ) return null;

  const timestamp = timeForX(pointer.x, viewport, plot);
  const pointerPrice = priceForY(pointer.y, viewport, plot);
  const detail: HeatmapHoverDetail = { timestamp, price: pointerPrice };
  const frameIndex = nearestTimeIndex(depthFrames, timestamp);
  if (frameIndex >= 0) {
    const level = closestLevel(depthFrames[frameIndex], pointerPrice);
    if (level) {
      detail.liquidity = level.liquidity;
      detail.liquiditySide = level.side;
    }
  } else if (liquidityCells.length > 0) {
    const cellIndex = nearestTimeIndex(liquidityCells, timestamp);
    let nearest: HeatmapLiquidityCell | undefined;
    for (
      let index = Math.max(0, cellIndex - 16);
      index <= Math.min(liquidityCells.length - 1, cellIndex + 16);
      index += 1
    ) {
      const cell = liquidityCells[index];
      if (!nearest || Math.abs(cell.price - pointerPrice) < Math.abs(nearest.price - pointerPrice)) {
        nearest = cell;
      }
    }
    if (nearest) {
      detail.liquidity = nearest.liquidity;
      detail.liquiditySide = nearest.side ?? "bid";
    }
  }

  const tradeIndex = nearestTimeIndex(trades, timestamp);
  let bestTrade: NormalizedTrade | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (
    let index = Math.max(0, tradeIndex - 14);
    index <= Math.min(trades.length - 1, tradeIndex + 14);
    index += 1
  ) {
    const trade = trades[index];
    const dx = xForTime(trade.timestamp, viewport, plot) - pointer.x;
    const dy = yForPrice(trade.price, viewport, plot) - pointer.y;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestTrade = trade;
    }
  }
  if (bestTrade && bestDistance <= 28) {
    detail.tradeVolume = bestTrade.totalVolume;
    detail.tradeSide = bestTrade.side;
  }
  return detail;
}

function drawTooltip(
  context: CanvasRenderingContext2D,
  options: OverlayOptions,
  plot: PlotRect,
): void {
  if (!options.hover || !options.pointer) return;
  const { hover, pointer } = options;
  const lines = [
    options.formatTime(hover.timestamp, true),
    `Price  ${options.formatPrice(hover.price)}`,
  ];
  if (hover.liquidity !== undefined) {
    const side = (hover.liquiditySide ?? "bid").toUpperCase();
    lines.push(`Liquidity ${side}  ${compactNumber(hover.liquidity)}`);
  }
  if (hover.tradeVolume !== undefined) {
    const buy = hover.tradeSide === "buy";
    lines.push(`${buy ? "▲ BUY" : "▼ SELL"} trade  ${compactNumber(hover.tradeVolume)}`);
  }

  context.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
  const width = Math.max(...lines.map((line) => context.measureText(line).width)) + 20;
  const height = lines.length * 17 + 12;
  let x = pointer.x + 16;
  let y = pointer.y + 16;
  if (x + width > plot.x + plot.width - 5) x = pointer.x - width - 16;
  if (y + height > plot.y + plot.height - 5) y = pointer.y - height - 16;
  x = clamp(x, plot.x + 5, plot.x + plot.width - width - 5);
  y = clamp(y, plot.y + 5, plot.y + plot.height - height - 5);

  roundedRect(context, x, y, width, height, 6);
  context.fillStyle = "rgba(8, 14, 23, 0.96)";
  context.fill();
  context.strokeStyle = "rgba(145, 166, 191, 0.5)";
  context.lineWidth = 1;
  context.stroke();
  lines.forEach((line, index) => {
    context.fillStyle = index === 0 ? "#8ea2ba" : TEXT;
    if (line.startsWith("▲")) context.fillStyle = BUY;
    if (line.startsWith("▼")) context.fillStyle = SELL;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(line, x + 10, y + 12 + index * 17);
  });
}

export function drawOverlay(options: OverlayOptions): void {
  if (options.width <= 0 || options.height <= 0) return;
  const context = configureCanvas(
    options.canvas,
    options.width,
    options.height,
    options.dpr,
    true,
  );
  if (!context) return;
  const plot = getPlotRect(options.width, options.height);
  context.clearRect(0, 0, options.width, options.height);

  if (options.focused) {
    context.strokeStyle = "rgba(99, 210, 255, 0.72)";
    context.lineWidth = 1.5;
    context.strokeRect(1, 1, options.width - 2, options.height - 2);
  }
  if (!options.hover || !options.pointer) return;

  const x = clamp(options.pointer.x, plot.x, plot.x + plot.width);
  const y = clamp(options.pointer.y, plot.y, plot.y + plot.height);
  context.save();
  context.strokeStyle = "rgba(222, 234, 247, 0.58)";
  context.lineWidth = 1;
  context.setLineDash([4, 4]);
  context.beginPath();
  context.moveTo(Math.round(x) + 0.5, plot.y);
  context.lineTo(Math.round(x) + 0.5, plot.y + plot.height);
  context.moveTo(plot.x, Math.round(y) + 0.5);
  context.lineTo(plot.x + plot.width, Math.round(y) + 0.5);
  context.stroke();
  context.setLineDash([]);

  const priceLabel = options.formatPrice(options.hover.price);
  context.font = "700 10px ui-monospace, SFMono-Regular, Menlo, monospace";
  const priceWidth = context.measureText(priceLabel).width + 14;
  roundedRect(context, plot.x + plot.width + 3, y - 10, priceWidth, 20, 4);
  context.fillStyle = "#8fa5bf";
  context.fill();
  context.fillStyle = "#08111b";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(priceLabel, plot.x + plot.width + 10, y);

  const timeLabel = options.formatTime(options.hover.timestamp, true);
  const timeWidth = context.measureText(timeLabel).width + 14;
  const timeX = clamp(x - timeWidth / 2, plot.x, plot.x + plot.width - timeWidth);
  roundedRect(context, timeX, plot.y + plot.height + 3, timeWidth, 20, 4);
  context.fillStyle = "#8fa5bf";
  context.fill();
  context.fillStyle = "#08111b";
  context.textAlign = "center";
  context.fillText(timeLabel, timeX + timeWidth / 2, plot.y + plot.height + 13);
  drawTooltip(context, options, plot);
  context.restore();
}
