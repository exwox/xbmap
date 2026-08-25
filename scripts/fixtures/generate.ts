import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION } from "../../server/types.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { evaluateScenario } from "./evaluate.js";
import { createFixtureScenarios } from "./scenarios.js";
import {
  FIXTURE_GENERATOR_VERSION,
  FIXTURE_SCHEMA_VERSION,
  type FixtureEvent,
  type FixtureIndex,
  type FixtureIndexEntry,
  type FixtureManifest,
  type FixtureScenario,
} from "./schema.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DEFAULT_FIXTURE_DIRECTORY = path.join(PROJECT_ROOT, "fixtures", "market");

export interface BuiltFixtureSuite {
  files: Map<string, string>;
  manifests: FixtureManifest[];
  index: FixtureIndex;
}

export function buildFixtureSuite(): BuiltFixtureSuite {
  const files = new Map<string, string>();
  const manifests: FixtureManifest[] = [];
  const indexEntries: FixtureIndexEntry[] = [];

  for (const scenario of createFixtureScenarios()) {
    validateScenario(scenario);
    const eventsName = `${scenario.id}.events.jsonl`;
    const manifestName = `${scenario.id}.manifest.json`;
    const eventsContent = `${scenario.events.map((event) => canonicalJson(event)).join("\n")}\n`;
    const eventCounts = countEvents(scenario.events);
    const from = scenario.events[0]?.at ?? 0;
    const to = scenario.events.at(-1)?.at ?? from;
    const manifest: FixtureManifest = {
      fixtureSchemaVersion: FIXTURE_SCHEMA_VERSION,
      eventSchemaVersion: SCHEMA_VERSION,
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      tags: scenario.tags,
      generator: {
        name: "liquidmap-phase0-fixture-generator",
        version: FIXTURE_GENERATOR_VERSION,
        seed: scenario.seed,
      },
      provenance: {
        source: "synthetic",
        containsExchangeCapture: false,
        redistribution: "project-owned-generated-data",
      },
      market: scenario.market,
      capture: {
        from,
        to,
        durationMs: Math.max(0, to - from),
        eventCount: scenario.events.length,
        eventCounts,
      },
      data: {
        path: eventsName,
        format: "ndjson",
        encoding: "utf-8",
        bytes: Buffer.byteLength(eventsContent),
        lines: scenario.events.length,
        sha256: sha256(eventsContent),
      },
      expected: evaluateScenario(scenario),
    };
    const manifestContent = `${canonicalJson(manifest, 2)}\n`;
    files.set(eventsName, eventsContent);
    files.set(manifestName, manifestContent);
    manifests.push(manifest);
    indexEntries.push({
      id: scenario.id,
      tags: scenario.tags,
      manifest: manifestName,
      data: eventsName,
      eventCount: scenario.events.length,
      dataSha256: manifest.data.sha256,
      manifestSha256: sha256(manifestContent),
    });
  }

  const index: FixtureIndex = {
    fixtureSchemaVersion: FIXTURE_SCHEMA_VERSION,
    fixtureSet: "phase-0-market-regression",
    generatorVersion: FIXTURE_GENERATOR_VERSION,
    deterministic: true,
    scenarios: indexEntries,
  };
  files.set("index.json", `${canonicalJson(index, 2)}\n`);
  return { files, manifests, index };
}

export async function writeFixtureSuite(
  directory = DEFAULT_FIXTURE_DIRECTORY,
): Promise<BuiltFixtureSuite> {
  const suite = buildFixtureSuite();
  await mkdir(directory, { recursive: true });
  await Promise.all(
    [...suite.files].map(([name, content]) =>
      writeFile(path.join(directory, name), content, "utf8"),
    ),
  );
  return suite;
}

export async function verifyFixtureSuite(
  directory = DEFAULT_FIXTURE_DIRECTORY,
): Promise<string[]> {
  const expected = buildFixtureSuite();
  const differences: string[] = [];
  for (const [name, expectedContent] of expected.files) {
    const absolutePath = path.join(directory, name);
    try {
      await access(absolutePath);
      const actualContent = await readFile(absolutePath, "utf8");
      if (actualContent !== expectedContent) {
        differences.push(
          `${name}: expected sha256 ${sha256(expectedContent)}, received ${sha256(actualContent)}`,
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      differences.push(code === "ENOENT" ? `${name}: missing` : `${name}: ${String(error)}`);
    }
  }
  return differences;
}

export function validateScenario(scenario: FixtureScenario): void {
  const failures: string[] = [];
  if (scenario.events.length === 0) failures.push("must contain events");
  if (scenario.events[0]?.kind !== "snapshot") failures.push("first event must be a snapshot");
  if (!Number.isFinite(scenario.market.tickSize) || scenario.market.tickSize <= 0) {
    failures.push("market.tickSize must be positive and finite");
  }

  const tradeIds = new Set<string>();
  const checkpointNames = new Set<string>();
  let previousAt = -Infinity;
  let previousResyncCount = 0;
  for (const [index, event] of scenario.events.entries()) {
    const expectedOrdinal = index + 1;
    if (event.ordinal !== expectedOrdinal) {
      failures.push(`event ${index}: ordinal must be ${expectedOrdinal}`);
    }
    if (!Number.isSafeInteger(event.at) || event.at < previousAt) {
      failures.push(`event ${event.ordinal}: replay clock must be a non-decreasing safe integer`);
    }
    previousAt = event.at;
    assertFiniteNumbers(event, `event ${event.ordinal}`, failures);

    if (event.kind === "snapshot" && event.data.exchangeTimestamp !== event.at) {
      failures.push(`event ${event.ordinal}: snapshot timestamp differs from replay clock`);
    }
    if (event.kind === "depth" || event.kind === "trade") {
      if (event.data.exchangeTimestamp !== event.at) {
        failures.push(`event ${event.ordinal}: exchange timestamp differs from replay clock`);
      }
      if (event.data.receivedTimestamp < event.data.exchangeTimestamp) {
        failures.push(`event ${event.ordinal}: received timestamp precedes exchange timestamp`);
      }
    }
    if (event.kind === "trade") {
      if (tradeIds.has(event.data.id)) failures.push(`event ${event.ordinal}: duplicate trade id`);
      tradeIds.add(event.data.id);
      if (event.data.price <= 0 || event.data.quantity <= 0) {
        failures.push(`event ${event.ordinal}: trade price and quantity must be positive`);
      }
    }
    if (event.kind === "status") {
      if (event.data.resyncCount < previousResyncCount) {
        failures.push(`event ${event.ordinal}: resyncCount decreased`);
      }
      previousResyncCount = event.data.resyncCount;
    }
    if (event.kind === "checkpoint") {
      if (checkpointNames.has(event.data.name)) {
        failures.push(`event ${event.ordinal}: duplicate checkpoint name`);
      }
      checkpointNames.add(event.data.name);
    }
  }

  if (checkpointNames.size === 0) failures.push("must contain at least one checkpoint");
  if (failures.length > 0) {
    throw new Error(`Invalid fixture scenario ${scenario.id}:\n- ${failures.join("\n- ")}`);
  }
}

function countEvents(events: FixtureEvent[]): Record<FixtureEvent["kind"], number> {
  const result: Record<FixtureEvent["kind"], number> = {
    snapshot: 0,
    depth: 0,
    trade: 0,
    status: 0,
    checkpoint: 0,
  };
  for (const event of events) result[event.kind] += 1;
  return result;
}

function assertFiniteNumbers(value: unknown, location: string, failures: string[]): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) failures.push(`${location}: contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertFiniteNumbers(item, location, failures));
    return;
  }
  if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) =>
      assertFiniteNumbers(item, location, failures),
    );
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "--check";
  if (mode === "--write") {
    const suite = await writeFixtureSuite();
    process.stdout.write(
      `Wrote ${suite.manifests.length} deterministic market fixtures to ${DEFAULT_FIXTURE_DIRECTORY}\n`,
    );
    return;
  }
  if (mode === "--check") {
    const differences = await verifyFixtureSuite();
    if (differences.length > 0) {
      process.stderr.write(`Fixture verification failed:\n- ${differences.join("\n- ")}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("All committed market fixtures are deterministic and current.\n");
    return;
  }
  throw new Error(`Unknown mode ${mode}; use --write or --check`);
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
