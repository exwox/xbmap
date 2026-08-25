import type { ConnectionState, TrendDirection, TrendStrength } from '../types/market';

export interface NumberFormatOptions {
  locale?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

function fallbackDash(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

export function inferPriceDecimals(tickSize?: number): number {
  if (tickSize === undefined || !Number.isFinite(tickSize) || tickSize <= 0) return 2;
  const scientific = tickSize.toExponential();
  const [coefficient, exponentText] = scientific.split('e');
  const exponent = Number(exponentText);
  const coefficientDecimals = (coefficient.split('.')[1] ?? '').replace(/0+$/, '').length;
  return Math.max(0, Math.min(12, coefficientDecimals - exponent));
}

export function formatPrice(
  value: number | null | undefined,
  options: NumberFormatOptions & { tickSize?: number } = {},
): string {
  if (fallbackDash(value)) return '—';
  const decimals = options.tickSize ? inferPriceDecimals(options.tickSize) : undefined;
  return new Intl.NumberFormat(options.locale ?? 'en-US', {
    minimumFractionDigits: options.minimumFractionDigits ?? decimals ?? 2,
    maximumFractionDigits: options.maximumFractionDigits ?? decimals ?? 8,
  }).format(value);
}

export function formatCompactNumber(
  value: number | null | undefined,
  options: NumberFormatOptions = {},
): string {
  if (fallbackDash(value)) return '—';
  return new Intl.NumberFormat(options.locale ?? 'en-US', {
    notation: 'compact',
    compactDisplay: 'short',
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  }).format(value);
}

export function formatVolume(
  value: number | null | undefined,
  options: NumberFormatOptions & { unit?: string } = {},
): string {
  const formatted = formatCompactNumber(value, options);
  return options.unit && formatted !== '—' ? `${formatted} ${options.unit}` : formatted;
}

export function formatSignedNumber(
  value: number | null | undefined,
  options: NumberFormatOptions = {},
): string {
  if (fallbackDash(value)) return '—';
  return new Intl.NumberFormat(options.locale ?? 'en-US', {
    signDisplay: 'always',
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  }).format(value);
}

/** Expects a ratio where 1 means 100%. */
export function formatPercent(
  value: number | null | undefined,
  options: NumberFormatOptions = {},
): string {
  if (fallbackDash(value)) return '—';
  return new Intl.NumberFormat(options.locale ?? 'en-US', {
    style: 'percent',
    signDisplay: 'exceptZero',
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 1,
  }).format(value);
}

export function formatLatency(value: number | null | undefined): string {
  if (fallbackDash(value)) return '—';
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

export interface TimestampFormatOptions {
  locale?: string;
  timeZone?: string;
  includeDate?: boolean;
  includeMilliseconds?: boolean;
}

export function formatTimestamp(
  timestamp: number | null | undefined,
  options: TimestampFormatOptions = {},
): string {
  if (fallbackDash(timestamp) || timestamp <= 0) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat(options.locale ?? 'en-GB', {
    ...(options.includeDate
      ? { year: 'numeric', month: 'short', day: '2-digit' }
      : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: options.includeMilliseconds ? 3 : undefined,
    hour12: false,
    timeZone: options.timeZone,
  }).format(date);
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—';
  const totalSeconds = Math.floor(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  syncing: 'Syncing book',
  live: 'Live',
  reconnecting: 'Reconnecting',
  demo: 'Demo data',
  stale: 'Data stale',
  error: 'Connection error',
  closed: 'Disconnected',
};

export function formatConnectionState(state: ConnectionState): string {
  return CONNECTION_LABELS[state];
}

const TREND_LABELS: Record<TrendDirection, string> = {
  up: 'Uptrend',
  down: 'Downtrend',
  neutral: 'Neutral',
};

const STRENGTH_LABELS: Record<TrendStrength, string> = {
  neutral: 'Neutral',
  forming: 'Forming',
  strong: 'Strong',
  very_strong: 'Very strong',
};

export function formatTrend(direction: TrendDirection, strength?: TrendStrength): string {
  if (!strength || strength === 'neutral') return TREND_LABELS[direction];
  return `${TREND_LABELS[direction]} · ${STRENGTH_LABELS[strength]}`;
}
