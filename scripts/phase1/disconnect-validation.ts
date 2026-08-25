import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  BinanceFeed,
  type BinanceReconciliation,
  type BinanceSocketFactory,
} from "../../server/feeds/binanceFeed.js";
import type { DepthSnapshot, StatusFrame } from "../../server/types.js";
import type { ValidationCaseResult } from "./types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface FakeSocketSet {
  depth?: FakeSocket;
  trade?: FakeSocket;
}

export async function validateDisconnectDuringReconciliation(): Promise<ValidationCaseResult> {
  const invariant =
    "A disconnect while the snapshot is pending invalidates that generation; successful reconciliation publishes one final checkpointed state with buffered deltas already folded in.";
  try {
    const disconnected = await runDisconnectedGeneration();
    const successful = await runSuccessfulAtomicReconciliation();
    assert(disconnected.snapshots === 0, "stale reconciliation snapshot was published");
    assert(disconnected.reconciliations === 0, "stale reconciliation handoff was published");
    assert(disconnected.depth === 0, "buffered delta from disconnected generation was published");
    assert(disconnected.states.includes("syncing"), "feed never entered syncing state");
    assert(disconnected.states.includes("reconnecting"), "disconnect was not reported as reconnecting");
    assert(successful.reconciliations.length === 1, "expected one atomic reconciliation handoff");
    assert(successful.snapshots.length === 1, "expected one compatibility snapshot publication");
    assert(successful.depth === 0, "buffered delta escaped separately from atomic handoff");
    const reconciliation = successful.reconciliations[0]!;
    assert(reconciliation.appliedUpdateCount === 1, "buffered update count was not recorded");
    assert(reconciliation.snapshot.lastUpdateId === 101, "final snapshot did not include buffered delta");
    assert(reconciliation.checkpoint.lastUpdateId === 101, "checkpoint sequence differs from snapshot");
    assert(
      reconciliation.checkpoint.fingerprint.length === 64,
      "reconciliation did not expose a SHA-256 book fingerprint",
    );

    return {
      id: "disconnect-during-reconciliation",
      passed: true,
      invariant,
      observations: [
        { key: "disconnectedGeneration.publishedSnapshots", value: disconnected.snapshots },
        { key: "disconnectedGeneration.publishedReconciliations", value: disconnected.reconciliations },
        { key: "disconnectedGeneration.publishedDepthUpdates", value: disconnected.depth },
        { key: "disconnectedGeneration.enteredReconnecting", value: true },
        { key: "successfulGeneration.reconciliations", value: successful.reconciliations.length },
        { key: "successfulGeneration.compatibilitySnapshots", value: successful.snapshots.length },
        { key: "successfulGeneration.separateBufferedDepth", value: successful.depth },
        { key: "successfulGeneration.appliedBufferedUpdates", value: reconciliation.appliedUpdateCount },
        { key: "successfulGeneration.finalLastUpdateId", value: reconciliation.snapshot.lastUpdateId },
        { key: "successfulGeneration.fingerprint", value: reconciliation.checkpoint.fingerprint },
      ],
    };
  } catch (error) {
    return {
      id: "disconnect-during-reconciliation",
      passed: false,
      invariant,
      observations: [],
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runDisconnectedGeneration(): Promise<{
  snapshots: number;
  reconciliations: number;
  depth: number;
  states: StatusFrame["state"][];
}> {
  const snapshot = deferred<DepthSnapshot>();
  const sockets: FakeSocketSet = {};
  const feed = new BinanceFeed({
    symbol: "BTCUSDT",
    tickSize: 0.1,
    snapshotFetcher: () => snapshot.promise,
    socketFactory: fakeSocketFactory(sockets),
  });
  const result = { snapshots: 0, reconciliations: 0, depth: 0, states: [] as StatusFrame["state"][] };
  feed.on("snapshot", () => { result.snapshots += 1; });
  feed.on("reconciled", () => { result.reconciliations += 1; });
  feed.on("depth", () => { result.depth += 1; });
  feed.on("status", (status: StatusFrame) => result.states.push(status.state));
  try {
    feed.start();
    const depth = requiredSocket(sockets.depth, "depth");
    const trade = requiredSocket(sockets.trade, "trade");
    depth.open();
    trade.open();
    depth.message(depthPayload(101, 100));
    depth.disconnect(1012, "fault injection");
    snapshot.resolve(baseSnapshot());
    await settleAsyncWork();
    return result;
  } finally {
    feed.stop();
  }
}

async function runSuccessfulAtomicReconciliation(): Promise<{
  snapshots: DepthSnapshot[];
  reconciliations: BinanceReconciliation[];
  depth: number;
}> {
  const snapshot = deferred<DepthSnapshot>();
  const sockets: FakeSocketSet = {};
  const feed = new BinanceFeed({
    symbol: "BTCUSDT",
    tickSize: 0.1,
    snapshotFetcher: () => snapshot.promise,
    socketFactory: fakeSocketFactory(sockets),
  });
  const result = {
    snapshots: [] as DepthSnapshot[],
    reconciliations: [] as BinanceReconciliation[],
    depth: 0,
  };
  feed.on("snapshot", (value: DepthSnapshot) => result.snapshots.push(value));
  feed.on("reconciled", (value: BinanceReconciliation) => result.reconciliations.push(value));
  feed.on("depth", () => { result.depth += 1; });
  try {
    feed.start();
    const depth = requiredSocket(sockets.depth, "depth");
    const trade = requiredSocket(sockets.trade, "trade");
    depth.open();
    trade.open();
    depth.message(depthPayload(101, 100));
    snapshot.resolve(baseSnapshot());
    await settleAsyncWork();
    return result;
  } finally {
    feed.stop();
  }
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  message(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }

  disconnect(code: number, reason: string): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }

  ping(): void {
    // Health-check no-op; no timer elapses in deterministic validation.
  }
}

function fakeSocketFactory(sockets: FakeSocketSet): BinanceSocketFactory {
  return (url) => {
    const socket = new FakeSocket();
    if (url.includes("/public/ws/")) sockets.depth = socket;
    else if (url.includes("/market/ws/")) sockets.trade = socket;
    else throw new Error(`Unexpected Binance stream route: ${url}`);
    return socket as unknown as WebSocket;
  };
}

function depthPayload(sequence: number, previousSequence: number): unknown {
  return {
    e: "depthUpdate",
    E: 1_735_700_000_010,
    T: 1_735_700_000_010,
    s: "BTCUSDT",
    U: sequence,
    u: sequence,
    pu: previousSequence,
    b: [["63999.9", "2.5"]],
    a: [],
  };
}

function baseSnapshot(): DepthSnapshot {
  return {
    lastUpdateId: 100,
    exchangeTimestamp: 1_735_700_000_000,
    bids: [["63999.9", "2"]],
    asks: [["64000.1", "2"]],
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

function requiredSocket(socket: FakeSocket | undefined, name: string): FakeSocket {
  if (!socket) throw new Error(`Feed did not construct ${name} socket`);
  return socket;
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
