import { performance } from 'node:perf_hooks';
import WebSocket, { type RawData } from 'ws';

interface Options {
  durationSeconds: number;
  symbol: string;
  handshakeTimeoutMs: number;
}

interface StreamStats {
  name: 'depth' | 'trade';
  url: string;
  opened: boolean;
  messages: number;
  bytes: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  latencyMs: number[];
  perSecond: Map<number, number>;
  errors: string[];
  closeCode: number | null;
}

function parseOptions(argv: string[]): Options {
  const read = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const duration = Number(read('--duration') ?? 60);
  const handshakeTimeout = Number(read('--handshake-timeout') ?? 10_000);
  return {
    durationSeconds: Number.isFinite(duration) ? Math.max(5, Math.min(3_600, duration)) : 60,
    symbol: (read('--symbol') ?? 'BTCUSDT').trim().toUpperCase(),
    handshakeTimeoutMs: Number.isFinite(handshakeTimeout)
      ? Math.max(1_000, Math.min(60_000, handshakeTimeout))
      : 10_000,
  };
}

function percentile(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? null;
}

function rounded(value: number | null, digits = 3): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarize(stats: StreamStats, elapsedSeconds: number) {
  const latencies = stats.latencyMs.slice().sort((left, right) => left - right);
  const rates = [...stats.perSecond.values()];
  const sum = (items: number[]) => items.reduce((total, value) => total + value, 0);
  return {
    stream: stats.name,
    url: stats.url,
    opened: stats.opened,
    messages: stats.messages,
    bytes: stats.bytes,
    messagesPerSecond: rounded(stats.messages / Math.max(0.001, elapsedSeconds)),
    bytesPerSecond: rounded(stats.bytes / Math.max(0.001, elapsedSeconds)),
    observedSecondRate: {
      min: rates.length ? Math.min(...rates) : null,
      mean: rates.length ? rounded(sum(rates) / rates.length) : null,
      max: rates.length ? Math.max(...rates) : null,
    },
    exchangeToCollectorLatencyMs: {
      samples: latencies.length,
      p50: rounded(percentile(latencies, 0.5)),
      p95: rounded(percentile(latencies, 0.95)),
      p99: rounded(percentile(latencies, 0.99)),
      max: rounded(latencies.at(-1) ?? null),
    },
    firstMessageAt: stats.firstMessageAt,
    lastMessageAt: stats.lastMessageAt,
    closeCode: stats.closeCode,
    errors: stats.errors,
  };
}

function payloadTimestamp(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : record;
  const value = data.E ?? data.T;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function connect(name: StreamStats['name'], url: string, options: Options): {
  socket: WebSocket;
  stats: StreamStats;
} {
  const stats: StreamStats = {
    name,
    url,
    opened: false,
    messages: 0,
    bytes: 0,
    firstMessageAt: null,
    lastMessageAt: null,
    latencyMs: [],
    perSecond: new Map(),
    errors: [],
    closeCode: null,
  };
  const socket = new WebSocket(url, {
    handshakeTimeout: options.handshakeTimeoutMs,
    perMessageDeflate: false,
    maxPayload: 4 * 1024 * 1024,
  });
  socket.on('open', () => { stats.opened = true; });
  socket.on('error', (error) => { stats.errors.push(error.message); });
  socket.on('close', (code, reason) => {
    stats.closeCode = code;
    if (reason.length > 0) stats.errors.push(`close reason: ${reason.toString()}`);
  });
  socket.on('message', (raw: RawData) => {
    const receivedAt = Date.now();
    const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
    stats.messages += 1;
    stats.bytes += bytes;
    stats.firstMessageAt ??= receivedAt;
    stats.lastMessageAt = receivedAt;
    stats.perSecond.set(Math.floor(receivedAt / 1_000), (stats.perSecond.get(Math.floor(receivedAt / 1_000)) ?? 0) + 1);
    try {
      const payload = JSON.parse(raw.toString()) as unknown;
      const exchangeTimestamp = payloadTimestamp(payload);
      if (exchangeTimestamp !== null) stats.latencyMs.push(Math.max(0, receivedAt - exchangeTimestamp));
    } catch {
      stats.errors.push('invalid JSON payload');
    }
  });
  return { socket, stats };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const streamSymbol = options.symbol.toLowerCase();
  const endpoints = {
    depth: `wss://fstream.binance.com/public/ws/${streamSymbol}@depth@100ms`,
    trade: `wss://fstream.binance.com/market/ws/${streamSymbol}@aggTrade`,
  };
  const startedAt = Date.now();
  const started = performance.now();
  const streams = [
    connect('depth', endpoints.depth, options),
    connect('trade', endpoints.trade, options),
  ];

  await new Promise<void>((resolve) => setTimeout(resolve, options.durationSeconds * 1_000));
  for (const stream of streams) {
    if (stream.socket.readyState === WebSocket.OPEN) stream.socket.close(1000, 'measurement complete');
    else if (stream.socket.readyState !== WebSocket.CLOSED) stream.socket.terminate();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  const elapsedSeconds = (performance.now() - started) / 1_000;
  const result = {
    kind: 'live-exchange-measurement',
    source: 'Binance USD-M Futures',
    measuredAt: new Date(startedAt).toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    options,
    elapsedSeconds: rounded(elapsedSeconds),
    streams: streams.map((stream) => summarize(stream.stats, elapsedSeconds)),
  };
  console.log(JSON.stringify(result, null, 2));

  if (streams.some((stream) => stream.stats.messages === 0)) process.exitCode = 2;
}

await main();
