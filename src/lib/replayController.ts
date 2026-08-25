import type { NormalizedMarketEvent } from '../types/market';
import {
  INITIAL_REPLAY_STATE,
  type ReplayControls,
  type ReplayLoadOptions,
  type ReplayState,
} from '../types/replay';

export type ReplayStateListener = (state: ReplayState) => void;
export type ReplayEventListener = (event: NormalizedMarketEvent) => void;

export interface ReplayControllerOptions {
  tickIntervalMs?: number;
  now?: () => number;
}

function eventTimestamp(event: NormalizedMarketEvent): number {
  return event.timestamp;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function lowerBound(events: readonly NormalizedMarketEvent[], timestamp: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const event = events[middle];
    if (event && eventTimestamp(event) < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Deterministic event-clock replay used by the hook and by replay tests. */
export class ReplayController implements ReplayControls {
  private readonly tickIntervalMs: number;
  private readonly now: () => number;
  private readonly stateListeners = new Set<ReplayStateListener>();
  private readonly eventListeners = new Set<ReplayEventListener>();
  private events: NormalizedMarketEvent[] = [];
  private currentState: ReplayState = { ...INITIAL_REPLAY_STATE };
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private wallClockStartedAt = 0;
  private replayClockStartedAt = 0;

  constructor(options: ReplayControllerOptions = {}) {
    this.tickIntervalMs = Math.max(4, options.tickIntervalMs ?? 25);
    this.now = options.now ?? Date.now;
  }

  get state(): ReplayState {
    return this.currentState;
  }

  load(events: readonly NormalizedMarketEvent[], options: ReplayLoadOptions = {}): void {
    this.clearTimer();
    this.events = events
      .filter((event) => Number.isFinite(eventTimestamp(event)))
      .map((event, originalIndex) => ({ event, originalIndex }))
      .sort(
        (left, right) =>
          eventTimestamp(left.event) - eventTimestamp(right.event) ||
          left.originalIndex - right.originalIndex,
      )
      .map(({ event }) => event);

    if (this.events.length === 0) {
      this.setState({
        ...INITIAL_REPLAY_STATE,
        status: 'ready',
        sessionId: options.sessionId ?? null,
        speed: this.currentState.speed,
      });
      return;
    }

    const from = eventTimestamp(this.events[0] as NormalizedMarketEvent);
    const to = eventTimestamp(this.events[this.events.length - 1] as NormalizedMarketEvent);
    const cursor = clamp(options.startAt ?? from, from, to);
    const index = lowerBound(this.events, cursor);
    this.setState({
      status: 'ready',
      sessionId: options.sessionId ?? null,
      cursorTimestamp: cursor,
      range: { from, to },
      speed: this.currentState.speed,
      progress: to === from ? 0 : (cursor - from) / (to - from),
      eventIndex: index,
      eventCount: this.events.length,
      error: null,
    });
    if (options.autoplay) this.play();
  }

  play(): void {
    if (this.events.length === 0 || !this.currentState.range) return;
    if (this.currentState.status === 'playing') return;
    if (this.currentState.status === 'ended') {
      this.seek(this.currentState.range.from);
    }

    this.wallClockStartedAt = this.now();
    this.replayClockStartedAt = this.currentState.cursorTimestamp ?? this.currentState.range.from;
    this.setState({ ...this.currentState, status: 'playing', error: null });
    this.timer = globalThis.setInterval(() => this.advance(), this.tickIntervalMs);
    this.advance();
  }

  pause(): void {
    if (this.currentState.status !== 'playing') return;
    this.advance();
    this.clearTimer();
    if (this.currentState.eventIndex < this.events.length) {
      this.setState({ ...this.currentState, status: 'paused' });
    }
  }

  seek(timestamp: number): void {
    const range = this.currentState.range;
    if (!range) return;
    const wasPlaying = this.currentState.status === 'playing';
    const cursor = clamp(timestamp, range.from, range.to);
    const eventIndex = lowerBound(this.events, cursor);
    this.setState({
      ...this.currentState,
      status: wasPlaying ? 'playing' : 'paused',
      cursorTimestamp: cursor,
      eventIndex,
      progress: range.to === range.from ? 1 : (cursor - range.from) / (range.to - range.from),
    });
    if (wasPlaying) {
      this.wallClockStartedAt = this.now();
      this.replayClockStartedAt = cursor;
    }
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed)) return;
    const normalized = clamp(speed, 0.1, 20);
    if (this.currentState.status === 'playing') {
      this.advance();
      this.wallClockStartedAt = this.now();
      this.replayClockStartedAt = this.currentState.cursorTimestamp ?? this.replayClockStartedAt;
    }
    this.setState({ ...this.currentState, speed: normalized });
  }

  step(count = 1): void {
    if (this.events.length === 0 || !this.currentState.range) return;
    this.clearTimer();
    const amount = Math.max(1, Math.trunc(count));
    let index = this.currentState.eventIndex;
    const limit = Math.min(this.events.length, index + amount);
    while (index < limit) {
      const event = this.events[index];
      if (event) this.emitEvent(event);
      index += 1;
    }
    const last = this.events[Math.max(0, index - 1)];
    const cursor = last ? eventTimestamp(last) : this.currentState.cursorTimestamp;
    const ended = index >= this.events.length;
    this.setState({
      ...this.currentState,
      status: ended ? 'ended' : 'paused',
      cursorTimestamp: ended ? this.currentState.range.to : cursor,
      eventIndex: index,
      progress: this.progressFor(ended ? this.currentState.range.to : cursor),
    });
  }

  stop(): void {
    this.clearTimer();
    this.events = [];
    this.setState({
      ...INITIAL_REPLAY_STATE,
      speed: this.currentState.speed,
    });
  }

  markLoading(sessionId: string | null = null): void {
    this.clearTimer();
    this.setState({
      ...this.currentState,
      status: 'loading',
      sessionId,
      error: null,
    });
  }

  markError(error: unknown): void {
    this.clearTimer();
    this.setState({
      ...this.currentState,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  subscribeState(listener: ReplayStateListener, emitCurrent = true): () => void {
    this.stateListeners.add(listener);
    if (emitCurrent) listener(this.currentState);
    return () => this.stateListeners.delete(listener);
  }

  subscribeEvents(listener: ReplayEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  destroy(): void {
    this.clearTimer();
    this.stateListeners.clear();
    this.eventListeners.clear();
    this.events = [];
  }

  private advance(): void {
    if (this.currentState.status !== 'playing' || !this.currentState.range) return;
    const elapsed = Math.max(0, this.now() - this.wallClockStartedAt);
    const target = Math.min(
      this.currentState.range.to,
      this.replayClockStartedAt + elapsed * this.currentState.speed,
    );
    let index = this.currentState.eventIndex;
    while (index < this.events.length) {
      const event = this.events[index];
      if (!event || eventTimestamp(event) > target) break;
      this.emitEvent(event);
      index += 1;
    }
    const ended = target >= this.currentState.range.to && index >= this.events.length;
    this.setState({
      ...this.currentState,
      status: ended ? 'ended' : 'playing',
      cursorTimestamp: target,
      eventIndex: index,
      progress: this.progressFor(target),
    });
    if (ended) this.clearTimer();
  }

  private progressFor(timestamp: number | null): number {
    const range = this.currentState.range;
    if (!range || timestamp === null) return 0;
    if (range.to === range.from) return timestamp >= range.to ? 1 : 0;
    return clamp((timestamp - range.from) / (range.to - range.from), 0, 1);
  }

  private setState(state: ReplayState): void {
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private emitEvent(event: NormalizedMarketEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private clearTimer(): void {
    if (this.timer !== null) globalThis.clearInterval(this.timer);
    this.timer = null;
  }
}
