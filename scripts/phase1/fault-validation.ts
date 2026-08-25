import { OrderBook, type BookApplyResult } from "../../server/core/orderBook.js";
import { DataQualityMonitor } from "../../server/core/dataQuality.js";
import type { DepthSnapshot, DepthUpdate } from "../../server/types.js";
import { fingerprintBook } from "./book-state.js";
import { loadFixture } from "./fixture-loader.js";
import type { ValidationCaseId, ValidationCaseResult } from "./types.js";

interface BaseChain {
  tickSize: number;
  snapshot: DepthSnapshot;
  first: DepthUpdate;
}

export async function validateCoreFaults(): Promise<ValidationCaseResult[]> {
  const fixture = await loadFixture("reconnect-sequence-gap");
  const snapshotEvent = fixture.scenario.events.find((event) => event.kind === "snapshot");
  const firstDepthEvent = fixture.scenario.events.find(
    (event) => event.kind === "depth" && event.expectedBookResult === "applied",
  );
  if (!snapshotEvent || snapshotEvent.kind !== "snapshot") {
    throw new Error("Reconnect fixture has no initial snapshot");
  }
  if (!firstDepthEvent || firstDepthEvent.kind !== "depth") {
    throw new Error("Reconnect fixture has no initial depth update");
  }
  const base: BaseChain = {
    tickSize: fixture.scenario.market.tickSize,
    snapshot: structuredClone(snapshotEvent.data),
    first: structuredClone(firstDepthEvent.data),
  };

  return [
    validateLostEvent(base),
    validateDuplicate(base),
    validateLateOutOfOrder(base),
    validateMalformed(base),
    validateCrossed(base),
  ];
}

function validateLostEvent(base: BaseChain): ValidationCaseResult {
  return execute(
    "lost-event",
    "Omitting a sequence is explicitly rejected as a gap before any later delta mutates the book.",
    () => {
      const book = initializedBook(base);
      const before = fingerprintBook(book);
      const result = book.applyUpdate(updateFor(402, 401, [[63_999.8, 2.5]], []));
      const quality = new DataQualityMonitor();
      quality.recordApplyResult(result);
      const after = fingerprintBook(book);
      assert(result.status === "gap", `expected gap, received ${result.status}`);
      assert(before.value === after.value, "lost-event candidate mutated book state");
      assert(quality.counters.sequenceGaps === 1, "sequence-gap counter was not incremented");
      return [
        { key: "result", value: result.status },
        { key: "lastUpdateId", value: result.lastUpdateId },
        { key: "stateUnchanged", value: before.value === after.value },
        { key: "fingerprintSource", value: after.source },
        { key: "sequenceGapCounter", value: quality.counters.sequenceGaps },
      ];
    },
  );
}

function validateDuplicate(base: BaseChain): ValidationCaseResult {
  return execute(
    "duplicate-event",
    "A duplicate sequence is ignored idempotently and leaves the accepted state fingerprint unchanged.",
    () => {
      const book = initializedBook(base);
      const first = book.applyUpdate(structuredClone(base.first));
      const accepted = fingerprintBook(book);
      const duplicate = book.applyUpdate(structuredClone(base.first));
      const quality = new DataQualityMonitor();
      quality.recordApplyResult(duplicate);
      const after = fingerprintBook(book);
      assert(first.status === "applied", `control update was ${first.status}`);
      assert(duplicate.status === "ignored", `duplicate was ${duplicate.status}`);
      assert(accepted.value === after.value, "duplicate changed book state");
      assert(quality.counters.duplicates === 1, "duplicate counter was not incremented");
      return [
        ...traceObservations(first, duplicate, accepted.value === after.value),
        { key: "duplicateCounter", value: quality.counters.duplicates },
      ];
    },
  );
}

function validateLateOutOfOrder(base: BaseChain): ValidationCaseResult {
  return execute(
    "late-out-of-order-event",
    "An update received ahead of its predecessor is never silently applied; a later predecessor cannot advance beyond the missing chain.",
    () => {
      const book = initializedBook(base);
      const first = book.applyUpdate(structuredClone(base.first));
      const beforeAhead = fingerprintBook(book);
      const ahead = book.applyUpdate(updateFor(403, 402, [[63_999.7, 4]], []));
      const afterAhead = fingerprintBook(book);
      const late = book.applyUpdate(updateFor(402, 401, [[63_999.8, 3]], []));
      const old = book.applyUpdate(updateFor(401, 400, [[63_999.9, 9]], []));
      const quality = new DataQualityMonitor();
      quality.recordApplyResult(ahead);
      quality.recordApplyResult(old);
      assert(first.status === "applied", `control update was ${first.status}`);
      assert(
        ahead.status === "gap" || ahead.status === "unsynced",
        `ahead update was silently ${ahead.status}`,
      );
      assert(beforeAhead.value === afterAhead.value, "ahead update mutated book state");
      assert(
        late.status === "applied" || late.status === "unsynced",
        `late predecessor had unexpected status ${late.status}`,
      );
      assert(book.lastUpdateId <= 402, "book advanced through the rejected sequence 403");
      assert(old.status === "ignored" && old.code === "out_of_order", "late old update was not classified out-of-order");
      assert(quality.counters.sequenceGaps === 1, "ahead gap counter was not incremented");
      assert(quality.counters.outOfOrder === 1, "out-of-order counter was not incremented");
      return [
        { key: "aheadResult", value: ahead.status },
        { key: "latePredecessorResult", value: late.status },
        { key: "rejectedStateUnchanged", value: beforeAhead.value === afterAhead.value },
        { key: "finalLastUpdateId", value: book.lastUpdateId },
        { key: "oldLateResult", value: old.status },
        { key: "oldLateCode", value: old.code ?? null },
        { key: "sequenceGapCounter", value: quality.counters.sequenceGaps },
        { key: "outOfOrderCounter", value: quality.counters.outOfOrder },
      ];
    },
  );
}

function validateMalformed(base: BaseChain): ValidationCaseResult {
  return execute(
    "malformed-event",
    "Malformed sequence metadata and non-finite price levels are rejected without mutating state.",
    () => {
      const book = initializedBook(base);
      const before = fingerprintBook(book);
      const invalidSequence = book.applyUpdate({
        ...updateFor(401, 400, [], []),
        sequenceStart: -1,
      });
      const invalidLevel = book.applyUpdate(
        updateFor(401, 400, [["not-a-price", "not-a-quantity"]], []),
      );
      const quality = new DataQualityMonitor();
      quality.recordApplyResult(invalidSequence);
      quality.recordApplyResult(invalidLevel);
      const after = fingerprintBook(book);
      assert(invalidSequence.status === "invalid", `bad sequence was ${invalidSequence.status}`);
      assert(invalidLevel.status === "invalid", `bad level was ${invalidLevel.status}`);
      assert(before.value === after.value, "malformed input mutated book state");
      assert(quality.counters.malformedEvents === 2, "malformed counter did not record both events");
      return [
        { key: "invalidSequenceResult", value: invalidSequence.status },
        { key: "invalidLevelResult", value: invalidLevel.status },
        { key: "stateUnchanged", value: before.value === after.value },
        { key: "malformedCounter", value: quality.counters.malformedEvents },
      ];
    },
  );
}

function validateCrossed(base: BaseChain): ValidationCaseResult {
  return execute(
    "crossed-update",
    "A delta that would cross best bid and ask is rolled back atomically and classified invalid.",
    () => {
      const book = initializedBook(base);
      const before = fingerprintBook(book);
      const bestAsk = book.getBestAsk()?.[0];
      if (bestAsk === undefined) throw new Error("fixture snapshot has no ask");
      const crossed = book.applyUpdate(updateFor(401, 400, [[bestAsk, 10]], []));
      const quality = new DataQualityMonitor();
      quality.recordApplyResult(crossed);
      const after = fingerprintBook(book);
      assert(crossed.status === "invalid", `crossed update was ${crossed.status}`);
      assert(before.value === after.value, "crossed update rollback was not atomic");
      assert(quality.counters.crossedBooks === 1, "crossed-book counter was not incremented");
      return [
        { key: "result", value: crossed.status },
        { key: "stateUnchanged", value: before.value === after.value },
        { key: "bestBidAfter", value: book.getBestBid()?.[0] ?? null },
        { key: "bestAskAfter", value: book.getBestAsk()?.[0] ?? null },
        { key: "crossedBookCounter", value: quality.counters.crossedBooks },
      ];
    },
  );
}

function initializedBook(base: BaseChain): OrderBook {
  const book = new OrderBook(base.tickSize);
  book.loadSnapshot(structuredClone(base.snapshot));
  return book;
}

function updateFor(
  sequence: number,
  previousSequence: number,
  bids: DepthUpdate["bids"],
  asks: DepthUpdate["asks"],
): DepthUpdate {
  const timestamp = 1_735_700_000_000 + sequence;
  return {
    exchangeTimestamp: timestamp,
    receivedTimestamp: timestamp + 2,
    sequenceStart: sequence,
    sequenceEnd: sequence,
    previousSequence,
    bids,
    asks,
  };
}

function execute(
  id: Exclude<ValidationCaseId, "disconnect-during-reconciliation" | "burst-three-times-baseline" | "replay-repeatability">,
  invariant: string,
  operation: () => ValidationCaseResult["observations"],
): ValidationCaseResult {
  try {
    return { id, passed: true, invariant, observations: operation() };
  } catch (error) {
    return {
      id,
      passed: false,
      invariant,
      observations: [],
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

function traceObservations(
  first: BookApplyResult,
  second: BookApplyResult,
  stateUnchanged: boolean,
): ValidationCaseResult["observations"] {
  return [
    { key: "firstResult", value: first.status },
    { key: "duplicateResult", value: second.status },
    { key: "lastUpdateId", value: second.lastUpdateId },
    { key: "stateUnchanged", value: stateUnchanged },
  ];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
