import { canonicalJson, sha256 } from "../fixtures/canonical.js";
import { evaluateScenario } from "../fixtures/evaluate.js";
import { OrderBook } from "../../server/core/orderBook.js";
import { fingerprintBook } from "./book-state.js";
import { loadAllFixtures } from "./fixture-loader.js";
import type { ValidationCaseResult, ValidationObservation } from "./types.js";

export async function validateReplayRepeatability(): Promise<ValidationCaseResult> {
  const invariant =
    "The same checksum-verified capture produces byte-identical outcomes, final book state, and signal checkpoints on every replay.";
  try {
    const fixtures = await loadAllFixtures();
    const observations: ValidationObservation[] = [];

    for (const fixture of fixtures) {
      const first = evaluateScenario(structuredClone(fixture.scenario));
      const second = evaluateScenario(structuredClone(fixture.scenario));
      const firstBytes = canonicalJson(first);
      const secondBytes = canonicalJson(second);
      assert(firstBytes === secondBytes, `${fixture.scenario.id}: replay outcomes differ`);
      assert(
        firstBytes === canonicalJson(fixture.manifest.expected),
        `${fixture.scenario.id}: replay differs from committed golden outcome`,
      );

      const book = replayBook(fixture.scenario.market.tickSize, fixture.scenario.events);
      const fingerprint = fingerprintBook(book, fixture.scenario.market.visibleDepth);
      const checkpoint = book.checkpoint();
      const secondBook = replayBook(
        fixture.scenario.market.tickSize,
        structuredClone(fixture.scenario.events),
      );
      assert(
        fingerprint.value === fingerprintBook(secondBook, fixture.scenario.market.visibleDepth).value,
        `${fixture.scenario.id}: production book fingerprint is not repeatable`,
      );
      assert(
        checkpoint.fingerprint === fingerprint.value,
        `${fixture.scenario.id}: production checkpoint and fingerprint disagree`,
      );
      assert(
        checkpoint.lastUpdateId === first.sequence.finalLastUpdateId,
        `${fixture.scenario.id}: checkpoint sequence disagrees with replay outcome`,
      );

      observations.push(
        { key: `${fixture.scenario.id}.outcomeSha256`, value: sha256(firstBytes) },
        { key: `${fixture.scenario.id}.bookFingerprint`, value: fingerprint.value },
        { key: `${fixture.scenario.id}.fingerprintSource`, value: fingerprint.source },
        { key: `${fixture.scenario.id}.checkpointLastUpdateId`, value: checkpoint.lastUpdateId },
        { key: `${fixture.scenario.id}.events`, value: fixture.scenario.events.length },
      );
    }

    return {
      id: "replay-repeatability",
      passed: true,
      invariant,
      observations,
    };
  } catch (error) {
    return failure("replay-repeatability", invariant, error);
  }
}

function replayBook(
  tickSize: number,
  events: Awaited<ReturnType<typeof loadAllFixtures>>[number]["scenario"]["events"],
): OrderBook {
  const book = new OrderBook(tickSize);
  for (const event of events) {
    if (event.kind === "snapshot") {
      book.loadSnapshot(event.data);
      continue;
    }
    if (event.kind === "depth") book.applyUpdate(event.data);
  }
  return book;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function failure(
  id: "replay-repeatability",
  invariant: string,
  error: unknown,
): ValidationCaseResult {
  return {
    id,
    passed: false,
    invariant,
    observations: [],
    failure: error instanceof Error ? error.message : String(error),
  };
}
