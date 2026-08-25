import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { createDeterministicDemoData } from "./heatmap/demo";
import {
  calculateDataViewport,
  clamp,
  drawMarketLayer,
  drawOverlay,
  getPlotRect,
  lookupHoverDetail,
  normalizeTrades,
  preparePriceSeries,
  priceForY,
  timeForX,
} from "./heatmap/draw";
import type {
  HeatmapDepthFrame,
  HeatmapHoverDetail,
  HeatmapLiquidityCell,
  HeatmapPricePoint,
  HeatmapTradeBucket,
  HeatmapViewport,
  MarketHeatmapProps,
} from "./heatmap/types";

export type {
  AggressorSide,
  HeatmapDepthFrame,
  HeatmapHoverDetail,
  HeatmapLiquidityCell,
  HeatmapPriceLevel,
  HeatmapPricePoint,
  HeatmapTradeBucket,
  HeatmapTrendSignal,
  HeatmapViewport,
  LiquiditySide,
  MarketDataStatus,
  MarketHeatmapProps,
} from "./heatmap/types";
export { createDeterministicDemoData } from "./heatmap/demo";

const EMPTY_DEPTH: readonly HeatmapDepthFrame[] = [];
const EMPTY_CELLS: readonly HeatmapLiquidityCell[] = [];
const EMPTY_TRADES: readonly HeatmapTradeBucket[] = [];
const EMPTY_PRICES: readonly HeatmapPricePoint[] = [];
const DEFAULT_HEIGHT = 560;
const DEFAULT_WINDOW_MS = 4 * 60 * 1_000;

interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

interface PointerPosition {
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  viewport: HeatmapViewport;
  moved: boolean;
}

interface RendererBenchmarkState {
  marketDrawMs: number[];
  inputToPaintMs: number[];
  drawTimestamps: number[];
  latest?: {
    depthFrames: number;
    trades: number;
    prices: number;
    width: number;
    height: number;
    dpr: number;
    backingWidth: number;
    backingHeight: number;
  };
}

type BenchmarkWindow = Window & {
  __liquidMapRendererBenchmark?: RendererBenchmarkState;
};

function appendBenchmarkSample(samples: number[], value: number): void {
  if (!Number.isFinite(value)) return;
  samples.push(value);
  if (samples.length > 20_000) samples.splice(0, samples.length - 20_000);
}

const visuallyHiddenStyle = {
  border: 0,
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  height: 1,
  margin: -1,
  overflow: "hidden",
  padding: 0,
  position: "absolute",
  whiteSpace: "nowrap",
  width: 1,
} as const;

function isValidViewport(viewport: HeatmapViewport | undefined): viewport is HeatmapViewport {
  return Boolean(
    viewport &&
      Number.isFinite(viewport.startTime) &&
      Number.isFinite(viewport.endTime) &&
      viewport.endTime > viewport.startTime &&
      Number.isFinite(viewport.minPrice) &&
      Number.isFinite(viewport.maxPrice) &&
      viewport.maxPrice > viewport.minPrice,
  );
}

function ensureSorted<T extends { timestamp: number }>(items: readonly T[]): readonly T[] {
  for (let index = 1; index < items.length; index += 1) {
    if (items[index].timestamp < items[index - 1].timestamp) {
      return items.slice().sort((left, right) => left.timestamp - right.timestamp);
    }
  }
  return items;
}

function latestTimestamp(
  depthFrames: readonly HeatmapDepthFrame[],
  liquidityCells: readonly HeatmapLiquidityCell[],
  trades: readonly { timestamp: number }[],
  prices: readonly HeatmapPricePoint[],
): number | undefined {
  let latest: number | undefined;
  const visit = (timestamp: number): void => {
    if (Number.isFinite(timestamp) && (latest === undefined || timestamp > latest)) {
      latest = timestamp;
    }
  };
  depthFrames.forEach((item) => visit(item.timestamp));
  liquidityCells.forEach((item) => visit(item.timestamp));
  trades.forEach((item) => visit(item.timestamp));
  prices.forEach((item) => visit(item.timestamp));
  return latest;
}

function decimalsFromTick(tickSize: number | undefined): number | undefined {
  if (!tickSize || !Number.isFinite(tickSize) || tickSize <= 0) return undefined;
  const text = tickSize.toString().toLowerCase();
  if (text.includes("e-")) {
    const exponent = Number(text.split("e-")[1]);
    return Number.isFinite(exponent) ? clamp(exponent, 0, 10) : undefined;
  }
  const fraction = text.split(".")[1];
  return clamp(fraction?.length ?? 0, 0, 10);
}

function formatAccessibleHover(
  hover: HeatmapHoverDetail | null,
  formatPrice: (price: number) => string,
  formatTime: (timestamp: number, includeSeconds?: boolean) => string,
): string {
  if (!hover) return "Crosshair is not active.";
  const segments = [
    `Crosshair ${formatTime(hover.timestamp, true)}`,
    `price ${formatPrice(hover.price)}`,
  ];
  if (hover.liquidity !== undefined) {
    segments.push(
      `${hover.liquiditySide ?? "bid"} liquidity ${hover.liquidity.toFixed(2)}`,
    );
  }
  if (hover.tradeVolume !== undefined) {
    segments.push(
      `${hover.tradeSide ?? "buy"} trade volume ${hover.tradeVolume.toFixed(2)}`,
    );
  }
  return `${segments.join(", ")}.`;
}

/**
 * Responsive, dependency-free Canvas renderer for order-book depth history.
 * The base market layer and pointer overlay use separate canvases so a moving
 * crosshair never redraws thousands of liquidity cells.
 */
function MarketHeatmapComponent({
  depthFrames = EMPTY_DEPTH,
  liquidityCells = EMPTY_CELLS,
  trades = EMPTY_TRADES,
  priceSeries = EMPTY_PRICES,
  trend = null,
  symbol = "BTC-USDT-PERP",
  status,
  isStale,
  staleSince,
  staleAfterMs = 5_000,
  now,
  timeWindowMs = DEFAULT_WINDOW_MS,
  tickSize,
  priceBucketSize,
  timeBucketMs,
  priceDecimals,
  heatmapThreshold = 0.08,
  bubbleScale = 1,
  maxBubbleRadius = 34,
  locale,
  timeZone,
  height = DEFAULT_HEIGHT,
  className,
  style,
  ariaLabel,
  initialViewport,
  onViewportChange,
  onHover,
  demoData = false,
}: MarketHeatmapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const marketCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const pendingPointerRef = useRef<PointerPosition | null>(null);
  const hoverFrameRef = useRef<number | null>(null);
  const initialNowRef = useRef(now ?? Date.now());
  const descriptionId = useId();
  const liveDetailId = useId();
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0, dpr: 1 });
  const [manualViewport, setManualViewport] = useState<HeatmapViewport | null>(
    isValidViewport(initialViewport) ? initialViewport : null,
  );
  const [pointer, setPointer] = useState<PointerPosition | null>(null);
  const [hover, setHover] = useState<HeatmapHoverDetail | null>(null);
  const [focused, setFocused] = useState(false);
  const [clock, setClock] = useState(now ?? Date.now());

  const deterministicDemo = useMemo(() => {
    if (!demoData) return null;
    const seed = typeof demoData === "number" ? demoData : 7;
    return createDeterministicDemoData(seed);
  }, [demoData]);

  const hasSuppliedMarketData =
    depthFrames.length > 0 ||
    liquidityCells.length > 0 ||
    trades.length > 0 ||
    priceSeries.length > 0;
  const usingDemo = Boolean(deterministicDemo && !hasSuppliedMarketData);
  const activeDepthFrames = useMemo(
    () =>
      ensureSorted(
        usingDemo ? deterministicDemo?.depthFrames ?? EMPTY_DEPTH : depthFrames,
      ),
    [depthFrames, deterministicDemo, usingDemo],
  );
  const activeLiquidityCells = useMemo(
    () => ensureSorted(usingDemo ? EMPTY_CELLS : liquidityCells),
    [liquidityCells, usingDemo],
  );
  const activeRawTrades = usingDemo
    ? deterministicDemo?.trades ?? EMPTY_TRADES
    : trades;
  const activeRawPrices = usingDemo
    ? deterministicDemo?.priceSeries ?? EMPTY_PRICES
    : priceSeries;
  const activeTrend = usingDemo ? deterministicDemo?.trend ?? null : trend;
  const normalizedTrades = useMemo(
    () => normalizeTrades(activeRawTrades),
    [activeRawTrades],
  );
  const resolvedPriceSeries = useMemo(
    () => preparePriceSeries(activeRawPrices, activeDepthFrames),
    [activeDepthFrames, activeRawPrices],
  );

  useEffect(() => {
    if (now !== undefined) {
      setClock(now);
      return undefined;
    }
    const interval = window.setInterval(
      () => setClock(Date.now()),
      clamp(Math.floor(staleAfterMs / 4), 500, 1_500),
    );
    return () => window.clearInterval(interval);
  }, [now, staleAfterMs]);

  const newestTimestamp = useMemo(
    () =>
      latestTimestamp(
        activeDepthFrames,
        activeLiquidityCells,
        normalizedTrades,
        resolvedPriceSeries,
      ),
    [
      activeDepthFrames,
      activeLiquidityCells,
      normalizedTrades,
      resolvedPriceSeries,
    ],
  );
  const effectiveStatus =
    status ?? (usingDemo ? "replay" : hasSuppliedMarketData ? "live" : "connecting");
  const inferredStale = Boolean(
    !usingDemo &&
      effectiveStatus !== "replay" &&
      newestTimestamp !== undefined &&
      staleAfterMs > 0 &&
      clock - newestTimestamp > staleAfterMs,
  );
  const stale = isStale ?? (effectiveStatus === "stale" || inferredStale);
  const effectiveStaleSince = staleSince ?? (inferredStale ? newestTimestamp : undefined);

  const dataViewport = useMemo(
    () =>
      calculateDataViewport({
        depthFrames: activeDepthFrames,
        liquidityCells: activeLiquidityCells,
        trades: normalizedTrades,
        priceSeries: resolvedPriceSeries,
        timeWindowMs: Math.max(1_000, timeWindowMs),
        tickSize,
        fallbackNow: now ?? initialNowRef.current,
      }),
    [
      activeDepthFrames,
      activeLiquidityCells,
      normalizedTrades,
      now,
      resolvedPriceSeries,
      tickSize,
      timeWindowMs,
    ],
  );
  const viewport = manualViewport ?? dataViewport;

  const inferredDecimals =
    priceDecimals ??
    decimalsFromTick(tickSize) ??
    (Math.abs((viewport.minPrice + viewport.maxPrice) / 2) >= 1_000 ? 2 : 4);
  const priceFormatter = useMemo(() => {
    try {
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: inferredDecimals,
        maximumFractionDigits: inferredDecimals,
      });
    } catch {
      return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: inferredDecimals,
        maximumFractionDigits: inferredDecimals,
      });
    }
  }, [inferredDecimals, locale]);
  const timeFormatters = useMemo(() => {
    const options: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    };
    try {
      return {
        short: new Intl.DateTimeFormat(locale, options),
        long: new Intl.DateTimeFormat(locale, {
          ...options,
          second: "2-digit",
          fractionalSecondDigits: 3,
        }),
      };
    } catch {
      return {
        short: new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
        long: new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }),
      };
    }
  }, [locale, timeZone]);
  const formatPrice = useCallback(
    (price: number) => priceFormatter.format(price),
    [priceFormatter],
  );
  const formatTime = useCallback(
    (timestamp: number, includeSeconds = false) =>
      (includeSeconds ? timeFormatters.long : timeFormatters.short).format(timestamp),
    [timeFormatters],
  );

  useEffect(() => {
    onViewportChange?.(viewport);
  }, [onViewportChange, viewport]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let frame = 0;
    const updateSize = (): void => {
      frame = 0;
      const rect = container.getBoundingClientRect();
      const next = {
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
        dpr: clamp(window.devicePixelRatio || 1, 1, 2.25),
      };
      setSize((current) =>
        current.width === next.width &&
        current.height === next.height &&
        current.dpr === next.dpr
          ? current
          : next,
      );
    };
    const scheduleUpdate = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(updateSize);
    };
    updateSize();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleUpdate);
    observer?.observe(container);
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const canvas = marketCanvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const benchmark = (window as BenchmarkWindow).__liquidMapRendererBenchmark;
      const drawStartedAt = benchmark ? performance.now() : 0;
      drawMarketLayer({
        canvas,
        width: size.width,
        height: size.height,
        dpr: size.dpr,
        viewport,
        depthFrames: activeDepthFrames,
        liquidityCells: activeLiquidityCells,
        trades: normalizedTrades,
        priceSeries: resolvedPriceSeries,
        trend: activeTrend,
        symbol,
        status: effectiveStatus,
        stale,
        staleSince: effectiveStaleSince,
        demo: usingDemo,
        heatmapThreshold: clamp(heatmapThreshold, 0, 0.94),
        bubbleScale: clamp(bubbleScale, 0, 8),
        maxBubbleRadius: clamp(maxBubbleRadius, 8, 80),
        timeBucketMs,
        priceBucketSize,
        tickSize,
        formatPrice,
        formatTime,
      });
      if (benchmark) {
        const drawFinishedAt = performance.now();
        appendBenchmarkSample(benchmark.marketDrawMs, drawFinishedAt - drawStartedAt);
        appendBenchmarkSample(benchmark.drawTimestamps, drawFinishedAt);
        const newestFrame = activeDepthFrames.at(-1) as
          | (HeatmapDepthFrame & { serverTimestamp?: number })
          | undefined;
        const inputTimestamp = now ?? newestFrame?.serverTimestamp ?? newestFrame?.timestamp;
        if (inputTimestamp !== undefined) {
          const inputToPaintMs = Date.now() - inputTimestamp;
          if (inputToPaintMs >= 0 && inputToPaintMs < 60_000) {
            appendBenchmarkSample(benchmark.inputToPaintMs, inputToPaintMs);
          }
        }
        benchmark.latest = {
          depthFrames: activeDepthFrames.length,
          trades: normalizedTrades.length,
          prices: resolvedPriceSeries.length,
          width: size.width,
          height: size.height,
          dpr: size.dpr,
          backingWidth: canvas.width,
          backingHeight: canvas.height,
        };
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeDepthFrames,
    activeLiquidityCells,
    activeTrend,
    bubbleScale,
    effectiveStaleSince,
    effectiveStatus,
    formatPrice,
    formatTime,
    heatmapThreshold,
    maxBubbleRadius,
    normalizedTrades,
    priceBucketSize,
    resolvedPriceSeries,
    size,
    stale,
    symbol,
    tickSize,
    timeBucketMs,
    usingDemo,
    viewport,
  ]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      drawOverlay({
        canvas,
        width: size.width,
        height: size.height,
        dpr: size.dpr,
        viewport,
        hover,
        pointer,
        focused,
        formatPrice,
        formatTime,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focused, formatPrice, formatTime, hover, pointer, size, viewport]);

  useEffect(() => {
    onHover?.(hover);
  }, [hover, onHover]);

  useEffect(
    () => () => {
      if (hoverFrameRef.current !== null) {
        window.cancelAnimationFrame(hoverFrameRef.current);
      }
    },
    [],
  );

  const relativePointer = useCallback(
    (event: { clientX: number; clientY: number }): PointerPosition => {
      const rect = overlayCanvasRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
      return {
        x: ((event.clientX - rect.left) / rect.width) * size.width,
        y: ((event.clientY - rect.top) / rect.height) * size.height,
      };
    },
    [size.height, size.width],
  );

  const resolveHover = useCallback(
    (position: PointerPosition): HeatmapHoverDetail | null =>
      lookupHoverDetail({
        pointer: position,
        width: size.width,
        height: size.height,
        viewport,
        depthFrames: activeDepthFrames,
        liquidityCells: activeLiquidityCells,
        trades: normalizedTrades,
      }),
    [
      activeDepthFrames,
      activeLiquidityCells,
      normalizedTrades,
      size.height,
      size.width,
      viewport,
    ],
  );

  useEffect(() => {
    if (!pointer || dragRef.current) return;
    setHover(resolveHover(pointer));
  }, [pointer, resolveHover]);

  const scheduleHover = useCallback(
    (position: PointerPosition): void => {
      pendingPointerRef.current = position;
      if (hoverFrameRef.current !== null) return;
      hoverFrameRef.current = window.requestAnimationFrame(() => {
        hoverFrameRef.current = null;
        const nextPointer = pendingPointerRef.current;
        if (!nextPointer) return;
        setPointer(nextPointer);
        setHover(resolveHover(nextPointer));
      });
    },
    [resolveHover],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      const position = relativePointer(event);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: position.x,
        startY: position.y,
        viewport,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [relativePointer, viewport],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      const position = relativePointer(event);
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        scheduleHover(position);
        return;
      }
      const plot = getPlotRect(size.width, size.height);
      const deltaX = position.x - drag.startX;
      const deltaY = position.y - drag.startY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) > 2) drag.moved = true;
      if (!drag.moved) return;
      const timeSpan = drag.viewport.endTime - drag.viewport.startTime;
      const priceSpan = drag.viewport.maxPrice - drag.viewport.minPrice;
      const timeShift = (-deltaX / Math.max(1, plot.width)) * timeSpan;
      const priceShift = (deltaY / Math.max(1, plot.height)) * priceSpan;
      setManualViewport({
        startTime: drag.viewport.startTime + timeShift,
        endTime: drag.viewport.endTime + timeShift,
        minPrice: drag.viewport.minPrice + priceShift,
        maxPrice: drag.viewport.maxPrice + priceShift,
      });
      setPointer(null);
      setHover(null);
    },
    [relativePointer, scheduleHover, size.height, size.width],
  );

  const endPointerDrag = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      scheduleHover(relativePointer(event));
    },
    [relativePointer, scheduleHover],
  );

  const handlePointerLeave = useCallback((): void => {
    if (dragRef.current) return;
    pendingPointerRef.current = null;
    setPointer(null);
    setHover(null);
  }, []);

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLCanvasElement>): void => {
      event.preventDefault();
      const position = relativePointer(event);
      const plot = getPlotRect(size.width, size.height);
      if (
        position.x < plot.x ||
        position.x > plot.x + plot.width ||
        position.y < plot.y ||
        position.y > plot.y + plot.height
      ) return;
      const timeSpan = viewport.endTime - viewport.startTime;
      const priceSpan = viewport.maxPrice - viewport.minPrice;

      if (event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const shift = (event.deltaY / Math.max(1, plot.width)) * timeSpan;
        setManualViewport({
          ...viewport,
          startTime: viewport.startTime + shift,
          endTime: viewport.endTime + shift,
        });
        return;
      }

      const zoomFactor = Math.exp(clamp(event.deltaY, -500, 500) * 0.0014);
      const zoomTime = !event.altKey || event.ctrlKey || event.metaKey;
      const zoomPrice = event.altKey || event.ctrlKey || event.metaKey;
      const anchorTime = timeForX(position.x, viewport, plot);
      const anchorPrice = priceForY(position.y, viewport, plot);
      const timeRatio = (anchorTime - viewport.startTime) / Math.max(1, timeSpan);
      const priceRatio =
        (anchorPrice - viewport.minPrice) / Math.max(Number.EPSILON, priceSpan);
      const nextTimeSpan = zoomTime
        ? clamp(timeSpan * zoomFactor, 1_000, 7 * 24 * 60 * 60 * 1_000)
        : timeSpan;
      const minimumPriceSpan = Math.max((tickSize ?? 1e-8) * 4, 1e-8);
      const nextPriceSpan = zoomPrice
        ? clamp(priceSpan * zoomFactor, minimumPriceSpan, priceSpan * 1_000)
        : priceSpan;

      setManualViewport({
        startTime: anchorTime - timeRatio * nextTimeSpan,
        endTime: anchorTime + (1 - timeRatio) * nextTimeSpan,
        minPrice: anchorPrice - priceRatio * nextPriceSpan,
        maxPrice: anchorPrice + (1 - priceRatio) * nextPriceSpan,
      });
      scheduleHover(position);
    },
    [relativePointer, scheduleHover, size.height, size.width, tickSize, viewport],
  );

  const moveKeyboardCrosshair = useCallback(
    (next: PointerPosition): void => {
      const plot = getPlotRect(size.width, size.height);
      const constrained = {
        x: clamp(next.x, plot.x, plot.x + plot.width),
        y: clamp(next.y, plot.y, plot.y + plot.height),
      };
      setPointer(constrained);
      setHover(resolveHover(constrained));
    },
    [resolveHover, size.height, size.width],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLCanvasElement>): void => {
      const plot = getPlotRect(size.width, size.height);
      const current = pointer ?? {
        x: plot.x + plot.width / 2,
        y: plot.y + plot.height / 2,
      };
      const stepX = Math.max(8, plot.width * 0.025);
      const stepY = Math.max(8, plot.height * 0.035);
      if (event.key === "ArrowLeft") moveKeyboardCrosshair({ ...current, x: current.x - stepX });
      else if (event.key === "ArrowRight") moveKeyboardCrosshair({ ...current, x: current.x + stepX });
      else if (event.key === "ArrowUp") moveKeyboardCrosshair({ ...current, y: current.y - stepY });
      else if (event.key === "ArrowDown") moveKeyboardCrosshair({ ...current, y: current.y + stepY });
      else if (event.key === "Home") {
        setManualViewport(null);
        moveKeyboardCrosshair(current);
      } else if (event.key === "Escape") {
        setPointer(null);
        setHover(null);
      } else if (event.key === "+" || event.key === "=" || event.key === "-") {
        const factor = event.key === "-" ? 1.25 : 0.8;
        const anchorTime = timeForX(current.x, viewport, plot);
        const span = viewport.endTime - viewport.startTime;
        const ratio = (anchorTime - viewport.startTime) / Math.max(1, span);
        const nextSpan = clamp(span * factor, 1_000, 7 * 24 * 60 * 60 * 1_000);
        setManualViewport({
          ...viewport,
          startTime: anchorTime - ratio * nextSpan,
          endTime: anchorTime + (1 - ratio) * nextSpan,
        });
      } else return;
      event.preventDefault();
    },
    [moveKeyboardCrosshair, pointer, size.height, size.width, viewport],
  );

  const handleFocus = useCallback((_: ReactFocusEvent<HTMLCanvasElement>) => {
    setFocused(true);
  }, []);
  const handleBlur = useCallback((_: ReactFocusEvent<HTMLCanvasElement>) => {
    setFocused(false);
    setPointer(null);
    setHover(null);
  }, []);
  const resetViewport = useCallback(() => setManualViewport(null), []);

  const statusDescription = stale
    ? "Market data is stale. Live interpretation is paused."
    : effectiveStatus === "live"
      ? "Market data is live."
      : `Market data status: ${effectiveStatus}.`;
  const resolvedAriaLabel =
    ariaLabel ??
    `${symbol} interactive liquidity heatmap. ${statusDescription} ` +
      "Buy trades use an upward triangle and solid outline; sell trades use a downward triangle and dashed outline.";

  return (
    <div
      ref={containerRef}
      className={className}
      role="region"
      aria-label={`${symbol} order-flow chart`}
      style={{
        position: "relative",
        width: "100%",
        height: typeof height === "number" ? `${height}px` : height,
        minHeight: 300,
        overflow: "hidden",
        borderRadius: 10,
        background: "#070b12",
        userSelect: "none",
        WebkitUserSelect: "none",
        ...style,
      }}
    >
      <canvas
        ref={marketCanvasRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
        }}
      />
      <canvas
        ref={overlayCanvasRef}
        role="img"
        tabIndex={0}
        aria-label={resolvedAriaLabel}
        aria-describedby={`${descriptionId} ${liveDetailId}`}
        title="Drag: pan · Wheel: zoom time · Alt+wheel: zoom price · Shift+wheel: pan · Double-click/Home: reset"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointerDrag}
        onPointerCancel={endPointerDrag}
        onPointerLeave={handlePointerLeave}
        onWheel={handleWheel}
        onDoubleClick={resetViewport}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
          cursor: dragRef.current ? "grabbing" : "crosshair",
          touchAction: "none",
          outline: "none",
        }}
      />
      <span id={descriptionId} style={visuallyHiddenStyle}>
        Horizontal axis is time and vertical axis is price. Liquidity intensity
        progresses from dark to yellow. Use arrow keys for the crosshair, plus
        and minus to zoom time, Home to follow the latest data, and Escape to
        clear the crosshair.
      </span>
      <span
        id={liveDetailId}
        aria-live={focused ? "polite" : "off"}
        style={visuallyHiddenStyle}
      >
        {formatAccessibleHover(hover, formatPrice, formatTime)}
      </span>
    </div>
  );
}

export const MarketHeatmap = memo(MarketHeatmapComponent);
MarketHeatmap.displayName = "MarketHeatmap";

export default MarketHeatmap;
