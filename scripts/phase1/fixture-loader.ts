import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../fixtures/canonical.js";
import type {
  FixtureEvent,
  FixtureIndex,
  FixtureManifest,
  FixtureScenario,
  FixtureScenarioId,
} from "../fixtures/schema.js";

export const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const FIXTURE_ROOT = path.join(REPOSITORY_ROOT, "fixtures/market");

export interface LoadedFixture {
  scenario: FixtureScenario;
  manifest: FixtureManifest;
  eventBytes: string;
}

export async function loadFixture(id: FixtureScenarioId): Promise<LoadedFixture> {
  const indexText = await readFile(path.join(FIXTURE_ROOT, "index.json"), "utf8");
  const index = JSON.parse(indexText) as FixtureIndex;
  const entry = index.scenarios.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Fixture ${id} is absent from fixtures/market/index.json`);

  const [manifestText, eventBytes] = await Promise.all([
    readFile(path.join(FIXTURE_ROOT, entry.manifest), "utf8"),
    readFile(path.join(FIXTURE_ROOT, entry.data), "utf8"),
  ]);
  if (sha256(manifestText) !== entry.manifestSha256) {
    throw new Error(`Fixture ${id} manifest checksum mismatch`);
  }
  if (sha256(eventBytes) !== entry.dataSha256) {
    throw new Error(`Fixture ${id} event checksum mismatch`);
  }

  const manifest = JSON.parse(manifestText) as FixtureManifest;
  const events = eventBytes
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureEvent);
  if (events.length !== manifest.capture.eventCount) {
    throw new Error(
      `Fixture ${id} has ${events.length} events, expected ${manifest.capture.eventCount}`,
    );
  }

  return {
    manifest,
    eventBytes,
    scenario: {
      id: manifest.id,
      title: manifest.title,
      description: manifest.description,
      tags: [...manifest.tags],
      seed: manifest.generator.seed,
      market: { ...manifest.market },
      events,
    },
  };
}

export async function loadAllFixtures(): Promise<LoadedFixture[]> {
  const ids: FixtureScenarioId[] = [
    "calm",
    "strong-uptrend",
    "high-volatility",
    "reconnect-sequence-gap",
  ];
  return Promise.all(ids.map(loadFixture));
}
