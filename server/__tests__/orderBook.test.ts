import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { OrderBook } from "../core/orderBook.js";
import type { DepthUpdate } from "../types.js";

function update(overrides: Partial<DepthUpdate> = {}): DepthUpdate {
  return {
    exchangeTimestamp: 1_000,
    receivedTimestamp: 1_001,
    sequenceStart: 11,
    sequenceEnd: 11,
    previousSequence: 10,
    bids: [],
    asks: [],
    ...overrides,
  };
}

describe("OrderBook", () => {
  it("loads a snapshot, bridges it and applies updates/deletes", () => {
    const book = new OrderBook(0.1);
    book.loadSnapshot({
      lastUpdateId: 10,
      bids: [["100.0", "1.0"], ["99.9", "3.0"]],
      asks: [["100.1", "2.0"], ["100.2", "4.0"]],
    });

    const result = book.applyUpdate(update({
      bids: [["100.0", "2.5"], ["99.9", "0"], ["99.8", "1.25"]],
      asks: [["100.1", "1.5"]],
    }));

    assert.equal(result.status, "applied");
    assert.equal(book.lastUpdateId, 11);
    assert.deepEqual(book.getBestBid(), [100, 2.5]);
    assert.deepEqual(book.getBestAsk(), [100.1, 1.5]);
    assert.deepEqual(book.getLevels(5).bids, [[100, 2.5], [99.8, 1.25]]);
  });

  it("ignores duplicates and detects previous-update gaps", () => {
    const book = syncedBook();
    assert.equal(book.applyUpdate(update()).status, "applied");
    assert.equal(book.applyUpdate(update()).status, "ignored");
    const gap = book.applyUpdate(update({
      sequenceStart: 13,
      sequenceEnd: 13,
      previousSequence: 12,
    }));
    assert.equal(gap.status, "gap");
    assert.equal(book.lastUpdateId, 11);
  });

  it("accepts a first event that overlaps and advances the snapshot", () => {
    const book = syncedBook();
    const result = book.applyUpdate(update({
      sequenceStart: 9,
      sequenceEnd: 12,
      previousSequence: 8,
    }));
    assert.equal(result.status, "applied");
    assert.equal(book.lastUpdateId, 12);
  });

  it("rejects a crossed update transactionally", () => {
    const book = syncedBook();
    const before = book.checkpoint();
    const result = book.applyUpdate(update({ bids: [["100.2", "5"]] }));
    assert.equal(result.status, "invalid");
    assert.equal(result.code, "crossed");
    assert.deepEqual(book.getBestBid(), [100, 1]);
    assert.equal(book.lastUpdateId, 10);
    assert.deepEqual(book.checkpoint(), before);
  });

  it("fingerprints canonical state independent of input ordering", () => {
    const left = new OrderBook(0.1);
    const right = new OrderBook(0.1);
    left.loadSnapshot({
      lastUpdateId: 10,
      bids: [[100, 1], [99.9, 2]],
      asks: [[100.2, 4], [100.1, 3]],
    });
    right.loadSnapshot({
      lastUpdateId: 10,
      bids: [[99.9, 2], [100, 1]],
      asks: [[100.1, 3], [100.2, 4]],
    });

    assert.equal(left.fingerprint(), right.fingerprint());
    assert.match(left.fingerprint(), /^[a-f0-9]{64}$/);
    assert.deepEqual(left.checkpoint(), right.checkpoint());
  });

  it("keeps a valid book when a replacement snapshot is malformed or crossed", () => {
    const book = syncedBook();
    const before = book.checkpoint();
    assert.throws(() => book.loadSnapshot({
      lastUpdateId: 20,
      bids: [[100.2, 1]],
      asks: [[100.1, 1]],
    }), /crossed/);
    assert.deepEqual(book.checkpoint(), before);
    assert.deepEqual(book.getLevels(5), { bids: [[100, 1]], asks: [[100.1, 1]] });
  });

  it("classifies duplicates, old updates, sequence gaps and malformed levels", () => {
    const book = syncedBook();
    assert.equal(book.applyUpdate(update()).status, "applied");
    assert.equal(book.applyUpdate(update()).code, "duplicate");
    assert.equal(book.applyUpdate(update({
      sequenceStart: 9,
      sequenceEnd: 10,
      previousSequence: 8,
    })).code, "out_of_order");
    assert.equal(book.applyUpdate(update({
      sequenceStart: 13,
      sequenceEnd: 13,
      previousSequence: 12,
    })).code, "sequence_gap");
    assert.equal(book.applyUpdate(update({
      sequenceStart: 12,
      sequenceEnd: 12,
      previousSequence: 11,
      bids: [[100.05, 1]],
    })).code, "malformed");
  });

  it("exports every level even though UI reads remain bounded", () => {
    const book = new OrderBook(1);
    const bids = Array.from({ length: 1_101 }, (_, index): [number, number] =>
      [index + 1, index + 0.5]);
    const asks = Array.from({ length: 1_101 }, (_, index): [number, number] =>
      [2_000 + index, index + 0.75]);
    book.loadSnapshot({ lastUpdateId: 7, bids, asks });

    assert.equal(book.getLevels(2_000).bids.length, 1_000);
    assert.equal(book.exportSnapshot().bids.length, 1_101);
    assert.equal(book.exportSnapshot().asks.length, 1_101);
    assert.equal(book.checkpoint().bidLevelCount, 1_101);
  });

  it("computes bounded near-mid liquidity imbalance", () => {
    const book = new OrderBook(0.1);
    book.loadSnapshot({
      lastUpdateId: 2,
      bids: [[100, 6], [99.9, 4]],
      asks: [[100.1, 2], [100.2, 3]],
    });
    assert.equal(book.imbalance(2), 1 / 3);
  });
});

function syncedBook(): OrderBook {
  const book = new OrderBook(0.1);
  book.loadSnapshot({
    lastUpdateId: 10,
    bids: [[100, 1]],
    asks: [[100.1, 1]],
  });
  return book;
}
