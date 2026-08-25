import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  createSnapshotRecoveryEvents,
  withClientDeliveryMetadata,
} from "../httpServer.js";
import { MarketGateway } from "../marketGateway.js";
import type { ServerEnvelope } from "../types.js";

describe("client delivery contract", () => {
  it("scopes delivery metadata to a client without mutating the source/REST envelope", () => {
    const gateway = new MarketGateway({ forceDemo: true });
    gateway.start();
    const source = gateway.getSnapshot(20);
    const first = withClientDeliveryMetadata(source, "client-a", 1);
    const second = withClientDeliveryMetadata(source, "client-b", 7);

    expect(first).toMatchObject({ streamId: "client-a", deliverySequence: 1 });
    expect(second).toMatchObject({ streamId: "client-b", deliverySequence: 7 });
    expect(source.streamId).toBeUndefined();
    expect(source.deliverySequence).toBeUndefined();
    gateway.stop();
  });

  it("returns snapshot followed by valid status so reconciliation completes without reload", () => {
    const gateway = new MarketGateway({ forceDemo: true });
    gateway.start();
    const demo = (gateway as unknown as { demo: EventEmitter }).demo;
    demo.emit("depth", {
      exchangeTimestamp: Date.now(),
      receivedTimestamp: Date.now(),
      sequenceStart: 2,
      sequenceEnd: 2,
      previousSequence: 1,
      bids: [[63_999.9, 2]],
      asks: [],
    });
    const events = createSnapshotRecoveryEvents(gateway, 20);

    expect(events.map((event) => event.type)).toEqual(["snapshot", "status"]);
    expect(events[0]!.data).toMatchObject({ valid: true, frozen: false });
    expect(events[1]!.data).toMatchObject({
      validity: "valid",
      synchronized: true,
      frozen: false,
    });
    const snapshotData = events[0]!.data as {
      sessionId: string;
      checkpoint: { fingerprint: string; lastUpdateId: number };
    };
    const statusData = events[1]!.data as {
      sessionId: string;
      checkpoint: { fingerprint: string; lastUpdateId: number };
    };
    expect(statusData.sessionId).toBe(snapshotData.sessionId);
    expect(statusData.checkpoint).toEqual(snapshotData.checkpoint);
    expect(events[1]!.sequence).toBe(events[0]!.sequence + 1);
    gateway.stop();
  });

  it("returns only a frozen status while no valid snapshot exists", () => {
    const gateway = new MarketGateway();
    const events: ServerEnvelope[] = createSnapshotRecoveryEvents(gateway, 20);
    expect(events.map((event) => event.type)).toEqual(["status"]);
    expect(events[0]!.data).toMatchObject({ stale: true });
  });
});
