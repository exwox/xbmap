import type { NormalizedMarketEvent } from './market';

export type ReplayStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

export interface ReplayRange {
  from: number;
  to: number;
}

export interface ReplayState {
  status: ReplayStatus;
  sessionId: string | null;
  cursorTimestamp: number | null;
  range: ReplayRange | null;
  speed: number;
  progress: number;
  eventIndex: number;
  eventCount: number;
  error: string | null;
}

export interface ReplayLoadOptions {
  sessionId?: string;
  startAt?: number;
  autoplay?: boolean;
}

export interface ReplaySessionRequest {
  from?: number;
  to?: number;
  speed?: number;
  resolution?: '1s' | '5s' | '15s' | '1m' | '5m' | number;
}

export interface ReplayHistoryPoint {
  timestamp: number;
  price: number | null;
  volume: number;
  delta: number;
  cvd: number;
  imbalance: number;
  trendScore: number;
  trendDirection: 'up' | 'down' | 'neutral';
}

export interface ReplaySession {
  id: string;
  symbol: string;
  from: number;
  to: number;
  speed: number;
  expiresAt: number;
  frames: ReplayHistoryPoint[];
}

export interface ReplayControls {
  load(events: readonly NormalizedMarketEvent[], options?: ReplayLoadOptions): void;
  play(): void;
  pause(): void;
  seek(timestamp: number): void;
  setSpeed(speed: number): void;
  step(count?: number): void;
  stop(): void;
}

export const INITIAL_REPLAY_STATE: ReplayState = {
  status: 'idle',
  sessionId: null,
  cursorTimestamp: null,
  range: null,
  speed: 1,
  progress: 0,
  eventIndex: 0,
  eventCount: 0,
  error: null,
};
