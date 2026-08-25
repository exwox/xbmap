import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_MARKET_SELECTION,
  EMPTY_STATUS,
  MARKET_SCHEMA_VERSION,
  type DataSourceMode,
  type DepthFrame,
  type MarketDataEvent,
  type MarketSelection,
  type MetricFrame,
  type NormalizedMarketEvent,
  type PriceTick,
  type StatusFrame,
  type TradeBucket,
  type TrendSignal,
} from '../types/market';
import {
  INITIAL_REPLAY_STATE,
  type ReplayLoadOptions,
  type ReplaySessionRequest,
  type ReplayState,
} from '../types/replay';
import { DemoMarketDataClient } from './demoMarketData';
import {
  WebSocketMarketDataClient,
  type MarketDataSource,
  type WebSocketMarketDataClientOptions,
} from './marketDataClient';
import { ReplayController } from './replayController';
import { fetchReplayCapture, type ReplayApiOptions } from './replayApi';
import { RingBuffer } from './ringBuffer';

export interface MarketBufferCapacities {
  depthFrames: number;
  trades: number;
  priceSeries: number;
}

export interface UseMarketDataOptions {
  selection?: Partial<MarketSelection>;
  mode?: DataSourceMode;
  autoConnect?: boolean;
  wsUrl?: string;
  capacities?: Partial<MarketBufferCapacities>;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  demoIntervalMs?: number;
  /** Test/embedded transport seam; normal browsers use the global WebSocket. */
  createSocket?: (url: string) => WebSocket;
}

export interface MarketDataState {
  mode: DataSourceMode;
  selection: MarketSelection;
  depthFrames: DepthFrame[];
  trades: TradeBucket[];
  priceSeries: PriceTick[];
  metrics: MetricFrame | null;
  trend: TrendSignal | null;
  status: StatusFrame;
  connected: boolean;
  isStale: boolean;
  lastEventAt: number | null;
}

export interface MarketReplayControls {
  load(events: readonly NormalizedMarketEvent[], options?: ReplayLoadOptions): void;
  loadRemote(request?: ReplaySessionRequest, options?: ReplayApiOptions & { autoplay?: boolean }): Promise<void>;
  play(): void;
  pause(): void;
  seek(timestamp: number): void;
  setSpeed(speed: number): void;
  step(count?: number): void;
  stop(): void;
  goLive(): void;
}

export interface UseMarketDataResult extends MarketDataState {
  replay: ReplayState;
  replayControls: MarketReplayControls;
  connect(): void;
  disconnect(): void;
  setMode(mode: DataSourceMode): void;
  setSelection(selection: MarketSelection | Partial<MarketSelection>): void;
  requestSnapshot(): void;
  clear(): void;
}

const DEFAULT_CAPACITIES: MarketBufferCapacities = {
  depthFrames: 900,
  trades: 2_500,
  priceSeries: 4_000,
};

function positiveCapacity(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.round(value));
}

function mergeSelection(selection: Partial<MarketSelection> = {}): MarketSelection {
  return {
    ...DEFAULT_MARKET_SELECTION,
    ...selection,
    exchange: selection.exchange?.trim().toLowerCase() || DEFAULT_MARKET_SELECTION.exchange,
    symbol: selection.symbol?.trim().toUpperCase() || DEFAULT_MARKET_SELECTION.symbol,
    depth: Math.max(10, Math.min(200, Math.round(selection.depth ?? DEFAULT_MARKET_SELECTION.depth))),
  };
}

function selectionEquals(left: MarketSelection, right: MarketSelection): boolean {
  return (
    left.exchange === right.exchange &&
    left.symbol === right.symbol &&
    left.market === right.market &&
    left.depth === right.depth
  );
}

function statusFor(
  selection: MarketSelection,
  patch: Partial<StatusFrame> = {},
): StatusFrame {
  return {
    ...EMPTY_STATUS,
    exchange: selection.exchange,
    symbol: selection.symbol,
    ...patch,
  };
}

function statusHasValidBook(status: StatusFrame): boolean {
  return (
    !status.stale &&
    status.validity === 'valid' &&
    status.transportAlive === true &&
    status.marketActive === true &&
    status.synchronized === true &&
    status.frozen === false &&
    (status.state === 'live' || status.state === 'demo')
  );
}

/**
 * Owns the live/demo transport, bounded chart buffers, latest analytics, and
 * deterministic replay. Components never need to parse a gateway payload.
 */
export function useMarketData(options: UseMarketDataOptions = {}): UseMarketDataResult {
  const initialSelectionRef = useRef<MarketSelection | null>(null);
  if (initialSelectionRef.current === null) {
    initialSelectionRef.current = mergeSelection(options.selection);
  }
  const initialSelection = initialSelectionRef.current;

  const [mode, updateMode] = useState<DataSourceMode>(options.mode ?? 'live');
  const [selection, updateSelection] = useState<MarketSelection>(initialSelection);
  const [shouldConnect, setShouldConnect] = useState(options.autoConnect ?? true);
  const [replay, setReplay] = useState<ReplayState>({ ...INITIAL_REPLAY_STATE });
  const [data, setData] = useState<Omit<MarketDataState, 'mode' | 'selection'>>({
    depthFrames: [],
    trades: [],
    priceSeries: [],
    metrics: null,
    trend: null,
    status: statusFor(initialSelection),
    connected: false,
    isStale: true,
    lastEventAt: null,
  });

  const capacities = useMemo<MarketBufferCapacities>(
    () => ({
      depthFrames: positiveCapacity(options.capacities?.depthFrames, DEFAULT_CAPACITIES.depthFrames),
      trades: positiveCapacity(options.capacities?.trades, DEFAULT_CAPACITIES.trades),
      priceSeries: positiveCapacity(options.capacities?.priceSeries, DEFAULT_CAPACITIES.priceSeries),
    }),
    [
      options.capacities?.depthFrames,
      options.capacities?.priceSeries,
      options.capacities?.trades,
    ],
  );
  const buffers = useMemo(
    () => ({
      depthFrames: new RingBuffer<DepthFrame>(capacities.depthFrames),
      trades: new RingBuffer<TradeBucket>(capacities.trades),
      priceSeries: new RingBuffer<PriceTick>(capacities.priceSeries),
    }),
    [capacities.depthFrames, capacities.priceSeries, capacities.trades],
  );

  const sourceRef = useRef<MarketDataSource | null>(null);
  const replayRef = useRef<ReplayController | null>(null);
  const replayActiveRef = useRef(false);
  const shouldConnectRef = useRef(shouldConnect);
  shouldConnectRef.current = shouldConnect;

  const clear = useCallback(() => {
    buffers.depthFrames.clear();
    buffers.trades.clear();
    buffers.priceSeries.clear();
    setData((current) => ({
      ...current,
      depthFrames: [],
      trades: [],
      priceSeries: [],
      metrics: null,
      trend: null,
      lastEventAt: null,
    }));
  }, [buffers]);

  const ingest = useCallback(
    (event: NormalizedMarketEvent) => {
      if (event.type === 'heartbeat') return;
      const marketEvent: MarketDataEvent = event;
      setData((current) => {
        const common = { lastEventAt: marketEvent.timestamp };
        switch (marketEvent.type) {
          case 'depth_frame': {
            buffers.depthFrames.push(marketEvent);
            const invalid = marketEvent.stale || (
              !replayActiveRef.current &&
              (current.isStale || !statusHasValidBook(current.status))
            );
            return {
              ...current,
              ...common,
              depthFrames: buffers.depthFrames.toArray(),
              isStale: invalid,
              trend: invalid ? null : current.trend,
            };
          }
          case 'trade_bucket':
            buffers.trades.push(marketEvent);
            return { ...current, ...common, trades: buffers.trades.toArray() };
          case 'price':
            buffers.priceSeries.push(marketEvent);
            return { ...current, ...common, priceSeries: buffers.priceSeries.toArray() };
          case 'metric': {
            const invalid = marketEvent.stale || (
              !replayActiveRef.current &&
              (current.isStale || !statusHasValidBook(current.status))
            );
            return {
              ...current,
              ...common,
              metrics: marketEvent,
              isStale: invalid,
              trend: invalid ? null : current.trend,
            };
          }
          case 'trend_signal': {
            const signalAllowed = replayActiveRef.current
              ? !current.isStale && current.depthFrames.length > 0
              : !current.isStale && statusHasValidBook(current.status);
            return {
              ...current,
              ...common,
              trend: signalAllowed ? marketEvent : null,
            };
          }
          case 'status': {
            const valid = replayActiveRef.current
              ? !marketEvent.stale
              : statusHasValidBook(marketEvent);
            return {
              ...current,
              ...common,
              status: marketEvent,
              connected: ['syncing', 'live', 'demo'].includes(marketEvent.state),
              isStale: !valid,
              trend: valid ? current.trend : null,
            };
          }
          case 'market_reset':
            buffers.depthFrames.clear();
            buffers.trades.clear();
            buffers.priceSeries.clear();
            return {
              ...current,
              ...common,
              depthFrames: [],
              trades: [],
              priceSeries: [],
              metrics: null,
              trend: null,
              isStale: true,
              status: {
                ...current.status,
                state: 'syncing',
                message: marketEvent.reason,
                stale: true,
                validity: 'syncing',
                synchronized: false,
                frozen: true,
                sessionId: marketEvent.sessionId,
              },
            };
        }
      });
    },
    [buffers],
  );

  useEffect(() => {
    const controller = new ReplayController();
    replayRef.current = controller;
    const unsubscribeState = controller.subscribeState(setReplay);
    const unsubscribeEvents = controller.subscribeEvents(ingest);
    return () => {
      unsubscribeEvents();
      unsubscribeState();
      controller.destroy();
      replayRef.current = null;
    };
  }, [ingest]);

  useEffect(() => {
    const liveOptions: WebSocketMarketDataClientOptions = {
      selection,
      url: options.wsUrl,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      staleAfterMs: options.staleAfterMs,
      reconnectInitialDelayMs: options.reconnectInitialDelayMs,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs,
      createSocket: options.createSocket,
    };
    const source: MarketDataSource =
      mode === 'demo'
        ? new DemoMarketDataClient({ selection, intervalMs: options.demoIntervalMs })
        : new WebSocketMarketDataClient(liveOptions);
    sourceRef.current = source;
    const unsubscribe = source.subscribe((event) => {
      if (!replayActiveRef.current) ingest(event);
    });
    if (shouldConnectRef.current && !replayActiveRef.current) source.connect();

    return () => {
      unsubscribe();
      source.disconnect();
      if (sourceRef.current === source) sourceRef.current = null;
    };
  }, [
    ingest,
    mode,
    options.demoIntervalMs,
    options.createSocket,
    options.heartbeatIntervalMs,
    options.reconnectInitialDelayMs,
    options.reconnectMaxDelayMs,
    options.staleAfterMs,
    options.wsUrl,
  ]);

  useEffect(() => {
    sourceRef.current?.setSelection(selection);
    setData((current) => ({
      ...current,
      status: {
        ...current.status,
        exchange: selection.exchange,
        symbol: selection.symbol,
      },
    }));
  }, [selection]);

  useEffect(() => {
    if (replayActiveRef.current) return;
    if (shouldConnect) sourceRef.current?.connect(selection);
    else sourceRef.current?.disconnect();
  }, [selection, shouldConnect]);

  const goLive = useCallback(() => {
    replayActiveRef.current = false;
    replayRef.current?.stop();
    clear();
    if (shouldConnectRef.current) sourceRef.current?.connect(selection);
  }, [clear, selection]);

  const replayControls = useMemo<MarketReplayControls>(
    () => ({
      load(events, loadOptions) {
        replayActiveRef.current = true;
        sourceRef.current?.disconnect();
        clear();
        const timestamp = Date.now();
        setData((current) => ({
          ...current,
          connected: false,
          isStale: false,
          status: statusFor(selection, {
            schemaVersion: MARKET_SCHEMA_VERSION,
            timestamp,
            exchangeTimestamp: timestamp,
            serverTimestamp: timestamp,
            state: 'syncing',
            source: 'replay',
            message: 'Replay ready',
            stale: false,
          }),
        }));
        replayRef.current?.load(events, loadOptions);
      },
      async loadRemote(request = {}, apiOptions = {}) {
        replayActiveRef.current = true;
        sourceRef.current?.disconnect();
        clear();
        replayRef.current?.markLoading();
        try {
          const capture = await fetchReplayCapture(request, {
            ...apiOptions,
            exchange: apiOptions.exchange ?? selection.exchange,
          });
          replayRef.current?.setSpeed(capture.session.speed);
          replayRef.current?.load(capture.events, {
            sessionId: capture.session.id,
            autoplay: apiOptions.autoplay,
          });
        } catch (error) {
          replayRef.current?.markError(error);
        }
      },
      play() {
        replayRef.current?.play();
      },
      pause() {
        replayRef.current?.pause();
      },
      seek(timestamp) {
        const currentCursor = replayRef.current?.state.cursorTimestamp;
        if (currentCursor !== null && currentCursor !== undefined && timestamp < currentCursor) clear();
        replayRef.current?.seek(timestamp);
      },
      setSpeed(speed) {
        replayRef.current?.setSpeed(speed);
      },
      step(count) {
        replayRef.current?.step(count);
      },
      stop() {
        replayActiveRef.current = false;
        replayRef.current?.stop();
      },
      goLive,
    }),
    [clear, goLive, selection],
  );

  const connect = useCallback(() => {
    if (replayActiveRef.current) {
      goLive();
      return;
    }
    setShouldConnect(true);
    sourceRef.current?.connect(selection);
  }, [goLive, selection]);

  const disconnect = useCallback(() => {
    setShouldConnect(false);
    sourceRef.current?.disconnect();
  }, []);

  const setMode = useCallback(
    (nextMode: DataSourceMode) => {
      if (nextMode === mode) return;
      replayActiveRef.current = false;
      replayRef.current?.stop();
      clear();
      updateMode(nextMode);
    },
    [clear, mode],
  );

  const setSelection = useCallback((next: MarketSelection | Partial<MarketSelection>) => {
    updateSelection((current) => {
      const merged = mergeSelection({ ...current, ...next });
      return selectionEquals(current, merged) ? current : merged;
    });
  }, []);

  const requestSnapshot = useCallback(() => {
    sourceRef.current?.requestSnapshot();
  }, []);

  return {
    mode,
    selection,
    ...data,
    replay,
    replayControls,
    connect,
    disconnect,
    setMode,
    setSelection,
    requestSnapshot,
    clear,
  };
}

/** Naming alias for components that prefer stream terminology. */
export const useMarketStream = useMarketData;
