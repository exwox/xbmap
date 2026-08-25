import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "./canonical.js";
import {
  buildFixtureSuite,
  DEFAULT_FIXTURE_DIRECTORY,
  validateScenario,
  verifyFixtureSuite,
} from "./generate.js";
import { createFixtureScenarios } from "./scenarios.js";
import type { FixtureEvent, FixtureManifest } from "./schema.js";

describe("Phase 0 deterministic market fixtures", () => {
  it("generates byte-identical files on repeated runs", () => {
    const first = buildFixtureSuite();
    const second = buildFixtureSuite();

    expect([...first.files]).toEqual([...second.files]);
    expect(canonicalJson(first.index)).toBe(canonicalJson(second.index));
    expect(first.manifests.map((manifest) => manifest.data.sha256)).toEqual(
      second.manifests.map((manifest) => manifest.data.sha256),
    );
  });

  it("keeps every committed artifact synchronized with its generator", async () => {
    await expect(verifyFixtureSuite()).resolves.toEqual([]);
  });

  it("pins data and manifest integrity in the suite index", async () => {
    const suite = buildFixtureSuite();
    for (const entry of suite.index.scenarios) {
      const data = await readFile(path.join(DEFAULT_FIXTURE_DIRECTORY, entry.data), "utf8");
      const manifestText = await readFile(
        path.join(DEFAULT_FIXTURE_DIRECTORY, entry.manifest),
        "utf8",
      );
      const manifest = JSON.parse(manifestText) as FixtureManifest;
      const events = data
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as FixtureEvent);

      expect(sha256(data)).toBe(entry.dataSha256);
      expect(sha256(manifestText)).toBe(entry.manifestSha256);
      expect(Buffer.byteLength(data)).toBe(manifest.data.bytes);
      expect(events).toHaveLength(manifest.data.lines);
      expect(events.map((event) => event.ordinal)).toEqual(
        Array.from({ length: events.length }, (_value, index) => index + 1),
      );
    }
  });

  it("captures the four required regimes with objective golden outcomes", () => {
    const manifests = new Map(
      buildFixtureSuite().manifests.map((manifest) => [manifest.id, manifest]),
    );
    const calm = required(manifests, "calm");
    const uptrend = required(manifests, "strong-uptrend");
    const volatile = required(manifests, "high-volatility");
    const reconnect = required(manifests, "reconnect-sequence-gap");

    expect(calm.expected.trend).toMatchObject({
      finalDirection: "neutral",
      finalActive: false,
      activatedDirections: [],
    });
    expect(calm.expected.trend.finalScore).toBeLessThan(40);

    expect(uptrend.expected.trend).toMatchObject({
      finalDirection: "up",
      finalActive: true,
      activatedDirections: ["up"],
    });
    expect(uptrend.expected.trend.finalScore).toBeGreaterThanOrEqual(65);

    expect(volatile.expected.trades.realizedVolatilityBps).toBeGreaterThan(
      calm.expected.trades.realizedVolatilityBps * 100,
    );
    expect(volatile.expected.trend.directionTransitions).toBeGreaterThanOrEqual(4);
    expect(volatile.expected.checkpoints.every((checkpoint) => !checkpoint.trend.active)).toBe(true);

    expect(reconnect.expected.sequence).toMatchObject({
      depthApplied: 2,
      depthIgnored: 1,
      depthGaps: 1,
      resyncs: 1,
      finalLastUpdateId: 406,
    });
    expect(reconnect.expected.connection).toMatchObject({
      gapDetected: true,
      recoveredAfterGap: true,
    });
    expect(
      reconnect.expected.checkpoints.find(
        (checkpoint) => checkpoint.name === "signal-invalid-during-gap",
      ),
    ).toMatchObject({
      bookValid: false,
      trend: { direction: "neutral", score: 0, active: false },
    });
  });

  it("rejects malformed ordering before generating fixture bytes", () => {
    const malformed = structuredClone(createFixtureScenarios()[0]);
    if (!malformed) throw new Error("Expected calm fixture scenario");
    const event = malformed.events[2];
    if (!event) throw new Error("Expected fixture event");
    event.ordinal = 99;
    expect(() => validateScenario(malformed)).toThrow(/ordinal must be 3/);
  });
});

function required(
  manifests: Map<string, FixtureManifest>,
  id: string,
): FixtureManifest {
  const manifest = manifests.get(id);
  if (!manifest) throw new Error(`Missing fixture manifest ${id}`);
  return manifest;
}
