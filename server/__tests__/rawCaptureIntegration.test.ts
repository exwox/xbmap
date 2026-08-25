import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { MarketGateway } from "../marketGateway.js";
import { RawCaptureRecorder } from "../recording/rawCapture.js";

describe("MarketGateway raw capture integration", () => {
  it("records the feed seam and flushes it before shutdown resolves", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liquidmap-gateway-capture-"));
    try {
      const recorder = new RawCaptureRecorder({
        directory,
        symbol: "BTCUSDT",
        id: "gateway",
      });
      const gateway = new MarketGateway({ rawCapture: recorder });
      const feed = (gateway as unknown as { binance: EventEmitter }).binance;

      feed.emit("raw", {
        receivedTimestamp: 1_700_000_000_000,
        stream: "snapshot",
        connectionId: "binance-7",
        payload: '{"lastUpdateId":10,"bids":[],"asks":[]}',
      });
      feed.emit("raw", {
        receivedTimestamp: 1_700_000_000_001,
        stream: "depth",
        connectionId: "binance-7",
        payload: '{"e":"depthUpdate","U":10,"u":11}',
      });

      expect(gateway.captureStatus).toMatchObject({
        enabled: true,
        acceptedRecords: 2,
      });
      expect(gateway.captureStatus).not.toHaveProperty("dataPath");
      expect(gateway.captureStatus).not.toHaveProperty("manifestPath");

      const firstShutdown = gateway.shutdown();
      expect(gateway.shutdown()).toBe(firstShutdown);
      await firstShutdown;

      const stats = recorder.stats;
      expect(gateway.captureStatus).toMatchObject({
        closedAt: expect.any(Number),
        acceptedRecords: 2,
        writtenRecords: 2,
        droppedRecords: 0,
        failed: false,
      });
      const records = (await gunzipText(stats.dataPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.map((record) => record.stream)).toEqual(["snapshot", "depth"]);
      expect(records.every((record) => record.connectionId === "binance-7")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps recording disabled without explicit configuration", () => {
    const gateway = new MarketGateway({ rawCapture: null });
    expect(gateway.captureStatus).toEqual({ enabled: false });
    gateway.stop();
  });
});

async function gunzipText(path: string): Promise<string> {
  let output = "";
  await pipeline(
    createReadStream(path),
    createGunzip(),
    new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
  );
  return output;
}
