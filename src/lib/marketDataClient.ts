import {
  DEFAULT_MARKET_SELECTION,
  MARKET_SCHEMA_VERSION,
  type ClientWebSocketMessage,
  type ConnectionState,
  type DataSourceMode,
  type MarketDataEvent,
  type MarketSelection,
  type StatusFrame,
} from '../types/market';
import { normalizeMarketEvent, readWireEnvelopeMetadata } from './marketNormalization';

export type MarketEventListener = (event: MarketDataEvent) => void;

export interface MarketDataSource {
  readonly mode: DataSourceMode;
  readonly selection: MarketSelection;
  readonly connected: boolean;
  connect(selection?: MarketSelection): void;
  disconnect(): void;
  setSelection(selection: MarketSelection): void;
  requestSnapshot(): void;
  subscribe(listener: MarketEventListener): () => void;
}

export interface WebSocketMarketDataClientOptions {
  selection?: MarketSelection;
  url?: string | (() => string);
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitter?: number;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  closeAfterStaleMs?: number;
  createSocket?: (url: string) => WebSocket;
  now?: () => number;
  random?: () => number;
}

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

function normalizeSelection(selection: MarketSelection): MarketSelection {
  return {
    exchange: selection.exchange.trim().toLowerCase() || DEFAULT_MARKET_SELECTION.exchange,
    symbol: selection.symbol.trim().toUpperCase() || DEFAULT_MARKET_SELECTION.symbol,
    market: selection.market,
    depth: Math.max(10, Math.min(200, Math.round(selection.depth))),
  };
}

export function resolveWebSocketUrl(path = '/ws'): string {
  if (typeof window === 'undefined') return `ws://localhost:8787${path}`;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

/** WebSocket transport with bounded reconnect, heartbeat, and stale-data detection. */
export class WebSocketMarketDataClient implements MarketDataSource {
  readonly mode = 'live' as const;

  private currentSelection: MarketSelection;
  private readonly listeners = new Set<MarketEventListener>();
  private readonly options: Required<
    Pick<
      WebSocketMarketDataClientOptions,
      | 'reconnectInitialDelayMs'
      | 'reconnectMaxDelayMs'
      | 'reconnectJitter'
      | 'heartbeatIntervalMs'
      | 'staleAfterMs'
      | 'closeAfterStaleMs'
      | 'now'
      | 'random'
    >
  > &
    Pick<WebSocketMarketDataClientOptions, 'url' | 'createSocket'>;

  private socket: WebSocket | null = null;
  private shouldRun = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private staleTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private lastReceivedAt = 0;
  private lastMarketEventAt = 0;
  private localSequence = 0;
  private stale = true;
  private deliveryStreamId: string | null = null;
  private lastDeliverySequence = 0;
  private resyncCount = 0;
  private lastSnapshotRequestAt = 0;
  private awaitingReconciliation = true;
  private reconciliationSnapshotReceived = false;

  constructor(options: WebSocketMarketDataClientOptions = {}) {
    this.currentSelection = normalizeSelection(options.selection ?? DEFAULT_MARKET_SELECTION);
    this.options = {
      url: options.url,
      reconnectInitialDelayMs: options.reconnectInitialDelayMs ?? 500,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 30_000,
      reconnectJitter: options.reconnectJitter ?? 0.2,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
      staleAfterMs: options.staleAfterMs ?? 5_000,
      closeAfterStaleMs: options.closeAfterStaleMs ?? 20_000,
      createSocket: options.createSocket,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
    };
  }

  get selection(): MarketSelection {
    return this.currentSelection;
  }

  get connected(): boolean {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  get isStale(): boolean {
    return this.stale;
  }

  connect(selection?: MarketSelection): void {
    if (selection) this.currentSelection = normalizeSelection(selection);
    this.shouldRun = true;
    this.clearReconnectTimer();
    if (
      this.socket?.readyState === SOCKET_OPEN ||
      this.socket?.readyState === SOCKET_CONNECTING
    ) {
      return;
    }
    this.openSocket();
  }

  disconnect(): void {
    this.shouldRun = false;
    this.clearTimers();
    if (this.socket?.readyState === SOCKET_OPEN) {
      this.send({
        type: 'unsubscribe',
        schemaVersion: MARKET_SCHEMA_VERSION,
        exchange: this.currentSelection.exchange,
        symbol: this.currentSelection.symbol,
      });
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'Client disconnected');
    this.emitStatus('closed', 'Disconnected', true);
  }

  setSelection(selection: MarketSelection): void {
    const next = normalizeSelection(selection);
    const previous = this.currentSelection;
    const changed =
      previous.exchange !== next.exchange ||
      previous.symbol !== next.symbol ||
      previous.market !== next.market ||
      previous.depth !== next.depth;
    if (!changed) return;

    if (this.connected) {
      this.send({
        type: 'unsubscribe',
        schemaVersion: MARKET_SCHEMA_VERSION,
        exchange: previous.exchange,
        symbol: previous.symbol,
      });
    }
    this.currentSelection = next;
    this.stale = true;
    this.resyncCount = 0;
    this.lastMarketEventAt = 0;
    this.awaitingReconciliation = true;
    this.reconciliationSnapshotReceived = false;
    if (this.connected) {
      this.sendSubscribe();
      this.emitStatus('syncing', `Syncing ${next.symbol}`, true);
    } else if (this.shouldRun) {
      this.connect();
    }
  }

  requestSnapshot(): void {
    this.awaitingReconciliation = true;
    this.reconciliationSnapshotReceived = false;
    this.stale = true;
    this.sendSnapshotRequest();
  }

  private sendSnapshotRequest(): void {
    this.lastSnapshotRequestAt = this.options.now();
    this.send({
      type: 'request_snapshot',
      schemaVersion: MARKET_SCHEMA_VERSION,
      exchange: this.currentSelection.exchange,
      symbol: this.currentSelection.symbol,
    });
  }

  subscribe(listener: MarketEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private openSocket(): void {
    const rawUrl = typeof this.options.url === 'function' ? this.options.url() : this.options.url;
    const url = rawUrl ?? resolveWebSocketUrl();
    this.emitStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting', `Connecting to ${url}`, true);

    try {
      const createSocket = this.options.createSocket ?? ((target: string) => new WebSocket(target));
      const socket = createSocket(url);
      this.socket = socket;
      socket.addEventListener('open', () => this.handleOpen(socket));
      socket.addEventListener('message', (event) => this.handleMessage(event.data));
      socket.addEventListener('error', () => this.handleError(socket));
      socket.addEventListener('close', () => this.handleClose(socket));
    } catch (error) {
      this.emitStatus('error', error instanceof Error ? error.message : 'Unable to open WebSocket', true);
      this.scheduleReconnect();
    }
  }

  private handleOpen(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.reconnectAttempt = 0;
    this.lastReceivedAt = this.options.now();
    this.stale = true;
    this.deliveryStreamId = null;
    this.lastDeliverySequence = 0;
    this.awaitingReconciliation = true;
    this.reconciliationSnapshotReceived = false;
    this.sendSubscribe();
    this.emitStatus('syncing', `Connected; syncing ${this.currentSelection.symbol}`, true);
    this.startHealthChecks();
  }

  private handleMessage(rawData: unknown): void {
    this.lastReceivedAt = this.options.now();
    if (typeof Blob !== 'undefined' && rawData instanceof Blob) {
      void rawData.text().then((value) => this.ingest(value));
      return;
    }
    if (rawData instanceof ArrayBuffer) {
      this.ingest(new TextDecoder().decode(rawData));
      return;
    }
    this.ingest(rawData);
  }

  private ingest(rawData: unknown): void {
    const metadata = readWireEnvelopeMetadata(rawData);
    if (
      metadata.streamId !== null &&
      metadata.deliverySequence !== null &&
      Number.isSafeInteger(metadata.deliverySequence) &&
      metadata.deliverySequence > 0
    ) {
      const sameStream = metadata.streamId === this.deliveryStreamId;
      if (sameStream && metadata.deliverySequence <= this.lastDeliverySequence) {
        // A WebSocket stream is ordered. Duplicate or regressing delivery
        // positions are never safe to apply twice.
        return;
      }
      const gap = sameStream &&
        this.lastDeliverySequence > 0 &&
        metadata.deliverySequence > this.lastDeliverySequence + 1;

      if (!sameStream) {
        this.deliveryStreamId = metadata.streamId;
        this.lastDeliverySequence = metadata.deliverySequence;
      } else {
        this.lastDeliverySequence = Math.max(
          this.lastDeliverySequence,
          metadata.deliverySequence,
        );
      }

      if (gap) {
        this.resyncCount += 1;
        this.awaitingReconciliation = true;
        this.reconciliationSnapshotReceived = false;
        this.stale = true;
        this.emitStatus(
          'syncing',
          'Client delivery gap detected; requesting a reconciled snapshot',
          true,
        );
        if (this.options.now() - this.lastSnapshotRequestAt >= 1_000) {
          this.sendSnapshotRequest();
        }
        // The triggering envelope arrived after unknown missing state. It must
        // not be allowed to clear the freeze or mutate UI projections.
        return;
      }
    }
    if (metadata.type === 'market_reset') {
      this.awaitingReconciliation = true;
      this.reconciliationSnapshotReceived = false;
      this.stale = true;
    } else if (metadata.type === 'snapshot') {
      this.reconciliationSnapshotReceived = true;
    }
    let event = normalizeMarketEvent(rawData, this.options.now());
    if (!event || event.type === 'heartbeat') return;
    if (event.type === 'status') {
      this.resyncCount = Math.max(this.resyncCount, event.resyncCount);
      event = { ...event, resyncCount: this.resyncCount };
      const reconciled =
        !event.stale &&
        event.validity === 'valid' &&
        event.transportAlive === true &&
        event.marketActive === true &&
        event.synchronized === true &&
        event.frozen === false &&
        (event.state === 'live' || event.state === 'demo');
      if (this.awaitingReconciliation && reconciled && !this.reconciliationSnapshotReceived) {
        // A nominal status cannot recover a client-side delivery gap by itself.
        // Wait for a snapshot from the same ordered delivery stream.
        this.stale = true;
        if (this.options.now() - this.lastSnapshotRequestAt >= 1_000) {
          this.sendSnapshotRequest();
        }
        return;
      }
      if (
        !reconciled &&
        !event.stale &&
        (event.state === 'live' || event.state === 'demo') &&
        this.options.now() - this.lastSnapshotRequestAt >= 1_000
      ) {
        this.sendSnapshotRequest();
      }
      this.stale = !reconciled;
      this.awaitingReconciliation = !reconciled;
      if (event.lastEventTimestamp !== null) this.lastMarketEventAt = event.lastEventTimestamp;
    } else {
      if (
        this.awaitingReconciliation &&
        event.type !== 'depth_frame' &&
        event.type !== 'market_reset'
      ) {
        return;
      }
      if (this.awaitingReconciliation && event.type === 'depth_frame' && metadata.type !== 'snapshot') {
        return;
      }
      const isFreshMarketDatum =
        event.type === 'trade_bucket' ||
        event.type === 'price' ||
        (event.type === 'depth_frame' && !event.stale);
      if (isFreshMarketDatum) {
        this.lastMarketEventAt = this.options.now();
        if (this.stale && !this.awaitingReconciliation) {
          this.stale = false;
          this.emitStatus('live', 'Live data resumed', false);
        }
      }
      if (
        (event.type === 'depth_frame' || event.type === 'metric') &&
        event.stale
      ) {
        this.stale = true;
      }
    }
    this.emit(event);
  }

  private handleError(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.emitStatus('error', 'WebSocket transport error', true);
  }

  private handleClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearHealthTimers();
    this.stale = true;
    if (this.shouldRun) {
      this.emitStatus('reconnecting', 'Connection lost; retrying', true);
      this.scheduleReconnect();
    }
  }

  private sendSubscribe(): void {
    this.send({
      type: 'subscribe',
      schemaVersion: MARKET_SCHEMA_VERSION,
      exchange: this.currentSelection.exchange,
      symbol: this.currentSelection.symbol,
      market: this.currentSelection.market,
      depth: this.currentSelection.depth,
    });
  }

  private send(message: ClientWebSocketMessage): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private startHealthChecks(): void {
    this.clearHealthTimers();
    this.heartbeatTimer = globalThis.setInterval(() => {
      this.send({
        type: 'ping',
        schemaVersion: MARKET_SCHEMA_VERSION,
        timestamp: this.options.now(),
      });
    }, this.options.heartbeatIntervalMs);

    const stalePollInterval = Math.max(250, Math.min(1_000, this.options.staleAfterMs / 2));
    this.staleTimer = globalThis.setInterval(() => {
      const now = this.options.now();
      const marketSilentFor = now - this.lastMarketEventAt;
      const transportSilentFor = now - this.lastReceivedAt;
      if (marketSilentFor >= this.options.staleAfterMs && !this.stale) {
        this.stale = true;
        this.emitStatus('stale', `No market data for ${Math.round(marketSilentFor)} ms`, true);
      }
      if (
        transportSilentFor >= this.options.closeAfterStaleMs &&
        this.socket?.readyState === SOCKET_OPEN
      ) {
        this.socket.close(4000, 'Heartbeat timeout');
      }
    }, stalePollInterval);
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun || this.reconnectTimer !== null) return;
    const exponential = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectInitialDelayMs * 2 ** this.reconnectAttempt,
    );
    const jitter = 1 + (this.options.random() * 2 - 1) * this.options.reconnectJitter;
    const delay = Math.max(0, Math.round(exponential * jitter));
    this.reconnectAttempt += 1;
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldRun) this.openSocket();
    }, delay);
  }

  private emit(event: MarketDataEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitStatus(state: ConnectionState, message: string, stale: boolean): void {
    const timestamp = this.options.now();
    const status: StatusFrame = {
      type: 'status',
      schemaVersion: MARKET_SCHEMA_VERSION,
      exchange: this.currentSelection.exchange,
      symbol: this.currentSelection.symbol,
      exchangeTimestamp: timestamp,
      serverTimestamp: timestamp,
      sequence: ++this.localSequence,
      timestamp,
      state,
      source: 'client',
      message,
      stale,
      resyncCount: this.resyncCount,
      lastEventTimestamp: this.lastMarketEventAt || null,
      latencyMs: null,
      ...(state === 'live'
        ? {
            validity: 'valid' as const,
            transportAlive: true,
            marketActive: true,
            synchronized: true,
            frozen: false,
          }
        : state === 'closed'
          ? {
              validity: 'closed' as const,
              transportAlive: false,
              marketActive: false,
              synchronized: false,
              frozen: true,
            }
          : {
              validity: 'syncing' as const,
              transportAlive: state !== 'reconnecting' && state !== 'error',
              marketActive: false,
              synchronized: false,
              frozen: true,
            }),
    };
    this.emit(status);
  }

  private clearHealthTimers(): void {
    if (this.heartbeatTimer !== null) globalThis.clearInterval(this.heartbeatTimer);
    if (this.staleTimer !== null) globalThis.clearInterval(this.staleTimer);
    this.heartbeatTimer = null;
    this.staleTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearTimers(): void {
    this.clearHealthTimers();
    this.clearReconnectTimer();
  }
}
