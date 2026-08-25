import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardErrorBoundary } from './components/DashboardErrorBoundary';
import MarketHeatmap, {
  createDeterministicDemoData,
  type HeatmapTradeBucket,
  type MarketDataStatus,
} from './components/MarketHeatmap';
import { Icon } from './components/Icon';
import { OrderFlowPanel } from './components/OrderFlowPanel';
import { RecentTrades, type TapeTrade } from './components/RecentTrades';
import { ReplayBar } from './components/ReplayBar';
import {
  SettingsPanel,
  type VisualSettings,
} from './components/SettingsPanel';
import { TrendPanel } from './components/TrendPanel';
import { createDemoReplay } from './demoReplay';
import { fetchReplayCapture } from './lib/replayApi';
import {
  assessDataQuality,
  formatCompactNumber,
  formatLatency,
  formatPrice,
  formatSignedNumber,
  formatTimestamp,
  useMarketData,
  validatedTrend,
} from './lib';

type UiMode = 'live' | 'demo' | 'replay';

const SYMBOLS = {
  BTCUSDT: { short: 'BTC', quote: 'USDT', mark: '₿', accent: '#f59d21' },
} as const;

const TIME_BUCKETS = [
  { label: '1s', value: 1_000 },
  { label: '5s', value: 5_000 },
  { label: '15s', value: 15_000 },
  { label: '1m', value: 60_000 },
  { label: '5m', value: 300_000 },
];

const DEFAULT_VISUAL_SETTINGS: VisualSettings = {
  heatmapThreshold: 0.08,
  bubbleScale: 1,
  depth: 80,
  timeWindowMs: 30_000,
};

// Renderer benchmarks use the production component tree with a deterministic,
// high-rate browser source. The query flag is intentionally opt-in so normal
// users and production sessions keep the live gateway defaults.
const RENDERER_BENCHMARK =
  new URLSearchParams(window.location.search).get('benchmark') === 'renderer';

function loadVisualSettings(): VisualSettings {
  try {
    const raw = localStorage.getItem('liquidmap.visual-settings');
    if (!raw) return DEFAULT_VISUAL_SETTINGS;
    return { ...DEFAULT_VISUAL_SETTINGS, ...JSON.parse(raw) } as VisualSettings;
  } catch {
    return DEFAULT_VISUAL_SETTINGS;
  }
}

function chartStatus(mode: UiMode, state: string, stale: boolean): MarketDataStatus {
  if (mode === 'replay') return 'replay';
  if (stale) return 'stale';
  if (state === 'error' || state === 'closed') return 'error';
  if (state === 'reconnecting') return 'reconnecting';
  if (state === 'connecting' || state === 'syncing' || state === 'idle') return 'connecting';
  return 'live';
}

function trendRegime(strength: string | undefined): string {
  switch (strength) {
    case 'very_strong': return 'Sangat kuat';
    case 'strong': return 'Momentum';
    case 'forming': return 'Terbentuk';
    default: return 'Observasi';
  }
}

function App() {
  const [visualSettings, setVisualSettings] = useState(loadVisualSettings);
  const [timeBucketMs, setTimeBucketMs] = useState(1_000);
  const [showBubbles, setShowBubbles] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const chartPanelRef = useRef<HTMLElement>(null);
  const [rendererBenchmarkNow, setRendererBenchmarkNow] = useState(Date.now);
  const rendererBenchmarkData = useMemo(
    () => RENDERER_BENCHMARK
      ? createDeterministicDemoData(1_480_744_257, {
          frameCount: 1_800,
          levelsPerSide: 80,
          intervalMs: 100,
          startTimestamp: Date.now() - 179_900,
        })
      : null,
    [],
  );

  const market = useMarketData({
    mode: RENDERER_BENCHMARK ? 'demo' : 'live',
    autoConnect: !RENDERER_BENCHMARK,
    selection: {
      exchange: 'binance',
      symbol: 'BTCUSDT',
      market: 'perpetual',
      depth: visualSettings.depth,
    },
    staleAfterMs: 5_000,
    capacities: {
      depthFrames: 1_800,
      trades: 2_500,
      priceSeries: 3_000,
    },
  });

  useEffect(() => {
    if (!RENDERER_BENCHMARK) return undefined;
    const interval = window.setInterval(() => setRendererBenchmarkNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, []);

  const replayActive = market.replay.status !== 'idle';
  const uiMode: UiMode = replayActive ? 'replay' : market.mode;
  const symbolMeta = SYMBOLS[market.selection.symbol as keyof typeof SYMBOLS] ?? {
    short: market.selection.symbol.replace(/USDT$/, ''),
    quote: 'USDT',
    mark: market.selection.symbol.slice(0, 1),
    accent: '#50c8ff',
  };

  useEffect(() => {
    localStorage.setItem('liquidmap.visual-settings', JSON.stringify(visualSettings));
  }, [visualSettings]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const latestDepth = market.depthFrames.at(-1);
  const latestPricePoint = market.priceSeries.at(-1);
  const latestTrade = market.trades.at(-1);
  const currentPrice = market.metrics?.lastPrice ?? latestPricePoint?.price ?? latestDepth?.midPrice ?? null;
  const comparisonPrice = market.priceSeries.at(-Math.min(300, market.priceSeries.length))?.price ?? currentPrice;
  const priceChange = currentPrice !== null && comparisonPrice
    ? (currentPrice - comparisonPrice) / comparisonPrice
    : 0;

  const buyVolume = market.metrics?.buyVolume ?? 0;
  const sellVolume = market.metrics?.sellVolume ?? 0;
  const totalVolume = buyVolume + sellVolume;
  const buyRatio = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 50;
  const bidLiquidity = latestDepth?.bids.slice(0, 20).reduce((sum, level) => sum + level.quantity, 0) ?? 0;
  const askLiquidity = latestDepth?.asks.slice(0, 20).reduce((sum, level) => sum + level.quantity, 0) ?? 0;
  const lastMarketUpdateAt = RENDERER_BENCHMARK
    ? rendererBenchmarkData?.depthFrames.at(-1)?.timestamp ?? null
    : [
        market.status.lastValidAt ?? undefined,
        market.status.lastEventTimestamp ?? undefined,
        latestDepth?.timestamp,
        latestPricePoint?.timestamp,
        latestTrade?.timestamp,
        market.metrics?.timestamp,
      ].reduce<number | null>((latest, timestamp) => (
        timestamp !== undefined && (latest === null || timestamp > latest) ? timestamp : latest
      ), null);
  const dataQuality = assessDataQuality({
    mode: RENDERER_BENCHMARK ? 'replay' : uiMode,
    status: RENDERER_BENCHMARK
      ? { ...market.status, state: 'live', stale: false, message: 'Renderer benchmark' }
      : market.status,
    isStale: RENDERER_BENCHMARK ? false : uiMode !== 'replay' && market.isStale,
    hasBook: Boolean(rendererBenchmarkData?.depthFrames.length ?? market.depthFrames.length),
    bookStale: RENDERER_BENCHMARK ? false : latestDepth?.stale,
  });
  const validatedMarketTrend = validatedTrend(market.trend, dataQuality);
  const displayedTrend = RENDERER_BENCHMARK
    ? rendererBenchmarkData?.trend ?? null
    : validatedMarketTrend;
  const lastUpdateLabel = lastMarketUpdateAt
    ? `UTC ${formatTimestamp(lastMarketUpdateAt, { timeZone: 'UTC', includeMilliseconds: true })}`
    : 'Belum ada update valid';

  const heatmapTrades = useMemo<HeatmapTradeBucket[]>(
    () => (rendererBenchmarkData?.trades ?? market.trades).map((trade) => ({
      ...trade,
      side: trade.side === 'unknown' ? undefined : trade.side,
    })),
    [market.trades, rendererBenchmarkData],
  );

  const tape = useMemo<TapeTrade[]>(
    () => market.trades.slice(-10).reverse().map((trade, index) => ({
      id: `${trade.timestamp}-${trade.sequence}-${index}`,
      time: formatTimestamp(trade.timestamp, { includeMilliseconds: true }),
      price: formatPrice(trade.vwap || trade.price, { tickSize: 0.1 }),
      size: formatCompactNumber(trade.totalVolume, { maximumFractionDigits: 3 }),
      side: trade.side === 'sell' ? 'sell' : 'buy',
    })),
    [market.trades],
  );

  const flowMetrics = useMemo(() => [
    {
      label: 'Volume Delta',
      value: formatSignedNumber(market.metrics?.delta, { maximumFractionDigits: 2 }),
      detail: 'AGGRESSOR · 5 DETIK',
      tone: (market.metrics?.delta ?? 0) > 0 ? 'positive' as const : (market.metrics?.delta ?? 0) < 0 ? 'negative' as const : 'neutral' as const,
    },
    {
      label: 'Cumulative Delta',
      value: formatSignedNumber(market.metrics?.cvd, { maximumFractionDigits: 1 }),
      detail: 'SEJAK SESI DIMULAI',
      tone: (market.metrics?.cvd ?? 0) > 0 ? 'positive' as const : (market.metrics?.cvd ?? 0) < 0 ? 'negative' as const : 'neutral' as const,
    },
    {
      label: 'Book Imbalance',
      value: `${formatSignedNumber((market.metrics?.imbalance ?? 0) * 100, { maximumFractionDigits: 1 })}%`,
      detail: '20 LEVEL TERDEKAT',
      tone: (market.metrics?.imbalance ?? 0) > 0.05 ? 'positive' as const : (market.metrics?.imbalance ?? 0) < -0.05 ? 'negative' as const : 'neutral' as const,
    },
    {
      label: 'Trade Velocity',
      value: `${formatCompactNumber(market.metrics?.tradeRate, { maximumFractionDigits: 1 })}/s`,
      detail: `${(market.metrics?.volumeRatio ?? 0).toFixed(1)}× BASELINE`,
      tone: (market.metrics?.volumeRatio ?? 0) > 1.5 ? 'positive' as const : 'neutral' as const,
    },
  ], [market.metrics]);

  const selectMode = useCallback((mode: UiMode) => {
    if (mode === 'replay') {
      // Prefer the durable raw capture from the gateway; fall back to the
      // synthetic demo dataset when raw replay is disabled or still empty so
      // the heatmap never renders an empty historical view.
      void fetchReplayCapture()
        .then((capture) => {
          if (capture.events.length === 0) throw new Error('capture kosong');
          market.replayControls.load(capture.events, { autoplay: true });
          setToast(`Replay historis dimuat (${capture.events.length} event dari capture gateway).`);
        })
        .catch(() => {
          market.replayControls.load(createDemoReplay(), { autoplay: true });
          setToast('Capture historis belum tersedia; memuat replay demo sintetis.');
        });
      return;
    }
    market.replayControls.goLive();
    market.setMode(mode);
  }, [market.replayControls, market.setMode]);

  const recoverData = useCallback(() => {
    if (dataQuality.action === 'reconnect') {
      market.connect();
      setToast('Menghubungkan ulang gateway dan menunggu book tervalidasi.');
      return;
    }
    market.requestSnapshot();
    setToast('Snapshot rekonsiliasi diminta; sinyal tetap ditahan sampai status valid.');
  }, [dataQuality.action, market.connect, market.requestSnapshot]);

  const recoverDashboard = useCallback(() => {
    market.clear();
    if (replayActive && market.replay.range) {
      market.replayControls.pause();
      market.replayControls.seek(market.replay.range.from);
    } else {
      market.connect();
      market.requestSnapshot();
    }
    setToast('Dashboard dipulihkan; menunggu snapshot book yang valid.');
  }, [
    market.clear,
    market.connect,
    market.replay.range,
    market.replayControls,
    market.requestSnapshot,
    replayActive,
  ]);

  const updateVisualSettings = useCallback((next: VisualSettings) => {
    setVisualSettings(next);
    if (next.depth !== market.selection.depth) market.setSelection({ depth: next.depth });
  }, [market.selection.depth, market.setSelection]);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const seekReplay = useCallback((progress: number) => {
    const range = market.replay.range;
    if (!range) return;
    market.replayControls.seek(range.from + (range.to - range.from) * progress / 100);
  }, [market.replay.range, market.replayControls]);

  const cycleReplaySpeed = useCallback(() => {
    const speeds = [0.5, 1, 2, 4];
    const index = speeds.indexOf(market.replay.speed);
    market.replayControls.setSpeed(speeds[(index + 1) % speeds.length]);
  }, [market.replay.speed, market.replayControls]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    void chartPanelRef.current?.requestFullscreen();
  }, []);

  const connectionClass = dataQuality.tone === 'negative'
    ? 'offline'
    : dataQuality.tone === 'warning'
      ? 'connecting'
      : '';
  const confidencePercent = (validatedMarketTrend?.confidence ?? 0) * 100;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="LiquidMap">
          <span className="brand-mark"><Icon name="activity" size={18} /></span>
          <span className="brand-copy">
            <strong>LiquidMap</strong>
            <span>ORDER FLOW TERMINAL</span>
          </span>
        </div>

        <span className="top-divider" aria-hidden="true" />

        <button className="market-selector" title="Pilih market" type="button" onClick={() => setToast('BTCUSDT perpetual adalah market pertama pada MVP ini.')}>
          <span className="asset-logo" style={{ background: symbolMeta.accent }}>{symbolMeta.mark}</span>
          <span className="market-copy">
            <strong>{symbolMeta.short} / {symbolMeta.quote}</strong>
            <span>Binance · Perpetual</span>
          </span>
          <Icon name="chevron" size={13} />
        </button>

        <div className="price-block" aria-live="polite">
          <strong>{formatPrice(currentPrice, { tickSize: 0.1 })}</strong>
          <span className="price-meta">
            <span className={priceChange >= 0 ? 'positive' : 'negative'}>
              {priceChange >= 0 ? '+' : ''}{(priceChange * 100).toFixed(2)}%
            </span>
            <span>Spread {formatPrice(market.metrics?.spread, { tickSize: 0.1 })}</span>
          </span>
        </div>

        <div className="topbar-spacer" />

        <div className="mode-switch" aria-label="Sumber data">
          {(['live', 'demo', 'replay'] as UiMode[]).map((mode) => (
            <button
              className={uiMode === mode ? 'active' : ''}
              key={mode}
              onClick={() => selectMode(mode)}
              type="button"
            >
              {mode.toUpperCase()}
            </button>
          ))}
        </div>

        <div
          className={`connection-pill ${connectionClass}`}
          title={[dataQuality.reason, dataQuality.detail].filter(Boolean).join(' ')}
        >
          <i aria-hidden="true" />
          <Icon name="wifi" size={13} />
          <span>{dataQuality.label}</span>
          <span>· {formatLatency(market.metrics?.latencyMs ?? market.status.latencyMs)}</span>
        </div>

        <button className="icon-button" type="button" onClick={() => setToast('Alert tren siap. Integrasi notifikasi eksternal berada pada fase berikutnya.')} aria-label="Buka alert">
          <Icon name="bell" size={16} />
        </button>
        <button className="icon-button" type="button" onClick={() => setSettingsOpen(true)} aria-label="Buka pengaturan">
          <Icon name="settings" size={16} />
        </button>
      </header>

      <DashboardErrorBoundary
        onRecover={recoverDashboard}
        resetKeys={[market.selection.symbol, uiMode]}
      >
      <main className="workspace">
        <div className="chart-column">
          <section className="panel chart-panel" ref={chartPanelRef} aria-label="Chart order flow">
            <div className="chart-toolbar">
              <span className="toolbar-label">BUCKET</span>
              <div className="toolbar-group">
                {TIME_BUCKETS.map((bucket) => (
                  <button
                    className={`tool-button ${timeBucketMs === bucket.value ? 'active' : ''}`}
                    key={bucket.value}
                    onClick={() => setTimeBucketMs(bucket.value)}
                    type="button"
                  >
                    {bucket.label}
                  </button>
                ))}
              </div>
              <span className="toolbar-separator" />
              <button className={`tool-button ${showBubbles ? 'active' : ''}`} onClick={() => setShowBubbles((value) => !value)} type="button">
                Bubbles
              </button>
              <button className="select-button" onClick={() => setSettingsOpen(true)} type="button">
                Depth {visualSettings.depth} <Icon name="chevron" size={10} />
              </button>
              <div className="toolbar-spacer" />
              <div className="heat-legend" aria-label="Intensitas likuiditas rendah hingga tinggi">
                <span>LOW</span><i className="heat-gradient" /><span>HIGH</span>
              </div>
              <span className="toolbar-separator" />
              <button className="icon-button" type="button" onClick={() => setToast('Arahkan pointer ke chart; drag untuk pan dan scroll untuk zoom.')} aria-label="Petunjuk crosshair">
                <Icon name="crosshair" size={14} />
              </button>
              <button className="icon-button" type="button" onClick={toggleFullscreen} aria-label="Layar penuh">
                <Icon name="expand" size={14} />
              </button>
            </div>

            <div className="chart-badge-row" aria-hidden="true">
              <span className="chart-badge">{market.selection.symbol} · {uiMode.toUpperCase()}</span>
              <span className="chart-badge buy">BUY {formatCompactNumber(buyVolume, { maximumFractionDigits: 2 })}</span>
              <span className="chart-badge sell">SELL {formatCompactNumber(sellVolume, { maximumFractionDigits: 2 })}</span>
            </div>

            <div className="chart-stage">
              {!dataQuality.valid && (
                <div
                  className={`data-quality-notice quality-${dataQuality.tone}`}
                  role="status"
                  aria-live="polite"
                >
                  <span className="quality-state"><i aria-hidden="true" /> {dataQuality.label}</span>
                  <span className="quality-message">
                    <strong>{dataQuality.reason}</strong>
                    {dataQuality.detail && <small>{dataQuality.detail}</small>}
                  </span>
                  <span className="quality-meta">Update {lastUpdateLabel} · {market.status.resyncCount} resync</span>
                  {dataQuality.action && (
                    <button type="button" onClick={recoverData}>
                      {dataQuality.action === 'reconnect' ? 'Coba reconnect' : 'Minta snapshot'}
                    </button>
                  )}
                </div>
              )}
              <MarketHeatmap
                ariaLabel={`Heatmap likuiditas real-time ${market.selection.symbol}`}
                bubbleScale={showBubbles ? visualSettings.bubbleScale : 0}
                depthFrames={rendererBenchmarkData?.depthFrames ?? market.depthFrames}
                heatmapThreshold={visualSettings.heatmapThreshold}
                height="100%"
                isStale={!dataQuality.valid}
                maxBubbleRadius={30}
                priceDecimals={market.selection.symbol === 'BTCUSDT' ? 1 : 2}
                now={RENDERER_BENCHMARK ? rendererBenchmarkNow : undefined}
                priceSeries={rendererBenchmarkData?.priceSeries ?? market.priceSeries}
                staleSince={lastMarketUpdateAt ?? undefined}
                status={RENDERER_BENCHMARK ? 'replay' : chartStatus(uiMode, market.status.state, market.isStale)}
                symbol={`${symbolMeta.short}-${symbolMeta.quote}-PERP`}
                tickSize={market.selection.symbol === 'BTCUSDT' ? 0.1 : 0.01}
                timeBucketMs={timeBucketMs}
                timeWindowMs={visualSettings.timeWindowMs}
                trades={heatmapTrades}
                trend={displayedTrend}
              />
            </div>
          </section>

          {replayActive && (
            <ReplayBar
              label={formatTimestamp(market.replay.cursorTimestamp)}
              onProgress={seekReplay}
              onReset={() => market.replay.range && market.replayControls.seek(market.replay.range.from)}
              onSpeed={cycleReplaySpeed}
              onToggle={() => market.replay.status === 'playing' ? market.replayControls.pause() : market.replayControls.play()}
              playing={market.replay.status === 'playing'}
              progress={market.replay.progress * 100}
              speed={market.replay.speed}
            />
          )}

          <div className="bottom-stat-grid">
            <div className="stat-card">
              <span className="stat-icon green"><Icon name="layers" size={16} /></span>
              <span className="stat-copy">
                <span>Bid liquidity · 20 level</span>
                <strong className="positive">{formatCompactNumber(bidLiquidity, { maximumFractionDigits: 2 })} BTC</strong>
                <small>Resting buy orders</small>
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-icon red"><Icon name="layers" size={16} /></span>
              <span className="stat-copy">
                <span>Ask liquidity · 20 level</span>
                <strong className="negative">{formatCompactNumber(askLiquidity, { maximumFractionDigits: 2 })} BTC</strong>
                <small>Resting sell orders</small>
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-icon amber"><Icon name="zap" size={16} /></span>
              <span className="stat-copy">
                <span>Trade velocity</span>
                <strong>{formatCompactNumber(market.metrics?.tradeRate, { maximumFractionDigits: 1 })} trades/s</strong>
                <small>{(market.metrics?.volumeRatio ?? 0).toFixed(2)}× baseline</small>
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-icon"><Icon name="activity" size={16} /></span>
              <span className="stat-copy">
                <span>Data quality</span>
                <strong className={dataQuality.tone === 'positive' ? 'positive' : dataQuality.tone === 'negative' ? 'negative' : 'warning'}>
                  {dataQuality.label}
                </strong>
                <small className="quality-reason">{dataQuality.reason}</small>
                <small>{lastUpdateLabel} · {market.status.resyncCount} resync · book {latestDepth?.lastUpdateId ?? 0}</small>
              </span>
            </div>
          </div>
        </div>

        <aside className="analytics-sidebar">
          <TrendPanel
            confidence={confidencePercent}
            direction={validatedMarketTrend?.direction ?? 'neutral'}
            paused={!dataQuality.valid}
            pausedReason={dataQuality.reason}
            reasons={validatedMarketTrend?.reasons ?? []}
            regime={trendRegime(validatedMarketTrend?.strength)}
            score={validatedMarketTrend?.score ?? 0}
          />
          <OrderFlowPanel buyRatio={buyRatio} metrics={flowMetrics} />
          <RecentTrades trades={tape} />
        </aside>
      </main>
      </DashboardErrorBoundary>

      <footer className="app-footer">
        <span>Data publik exchange · Alat bantu analisis, bukan nasihat keuangan.</span>
        <span>{market.status.source.toUpperCase()} · LAST {lastUpdateLabel} · {market.status.resyncCount} RESYNC</span>
      </footer>

      <SettingsPanel
        onChange={updateVisualSettings}
        onClose={closeSettings}
        onSnapshot={() => {
          market.requestSnapshot();
          setToast('Snapshot order book baru diminta.');
        }}
        open={settingsOpen}
        settings={visualSettings}
      />

      {toast && (
        <div className="toast" role="status">
          <Icon name="bell" size={16} />
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}

export default App;
