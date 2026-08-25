import { describe, expect, it } from "vitest";
import {
  PostgresReplaySessionMetadataStore,
} from "./postgresReplaySessions.js";
import type { ReplaySessionMetadata } from "./types.js";

const BASE = 1_700_000_000_000;

function metadata(overrides: Partial<ReplaySessionMetadata> = {}): ReplaySessionMetadata {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    datasetId: "22222222-2222-4222-8222-222222222222",
    exchange: "binance",
    symbol: "BTCUSDT",
    from: BASE,
    to: BASE + 3_600_000,
    cursor: null,
    speed: 1,
    state: "paused",
    expectedChecksum: "e".repeat(64),
    actualChecksum: null,
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides,
  };
}

function fakePool(rows: Record<string, unknown>[] = []) {
  const statements: Array<{ text: string; values: readonly unknown[] }> = [];
  const pool = {
    query: async (text: string, values?: readonly unknown[]) => {
      statements.push({ text, values: values ?? [] });
      return { rows };
    },
  };
  return { pool, statements };
}

describe("PostgreSQL replay session metadata store", () => {
  it("upserts a placeholder dataset then inserts the session with a null cursor", async () => {
    const { pool, statements } = fakePool();
    const store = new PostgresReplaySessionMetadataStore(pool);
    await store.createSession(metadata());
    expect(statements).toHaveLength(2);
    expect(statements[0]!.text).toContain("INSERT INTO replay_datasets");
    expect(statements[0]!.text).toContain("ON CONFLICT (id) DO NOTHING");
    expect(statements[1]!.text).toContain("INSERT INTO replay_sessions");
    const values = statements[1]!.values;
    expect(values[0]).toBe("11111111-1111-4111-8111-111111111111");
    expect(values[6]).toBeNull(); // cursor_timestamp
    expect(values[7]).toBeNull(); // cursor_capture_sequence
    // created_at and updated_at share the final $16 placeholder.
    expect((values[15] as Date).getTime()).toBe(BASE);
  });

  it("persists a non-null cursor tuple", async () => {
    const { pool, statements } = fakePool();
    const store = new PostgresReplaySessionMetadataStore(pool);
    await store.createSession(metadata({
      cursor: {
        timestamp: BASE + 500, captureSequence: 42,
        kind: "trade", captureId: "cap-9", recordKey: "cap-9:42",
      },
    }));
    const values = statements[1]!.values;
    expect((values[6] as Date).getTime()).toBe(BASE + 500);
    expect(values[7]).toBe(42);
    expect(values[8]).toBe("trade");
    expect(values[10]).toBe("cap-9:42");
  });

  it("maps a selected row back into typed metadata", async () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      dataset_id: "22222222-2222-4222-8222-222222222222",
      exchange: "binance", symbol: "BTCUSDT",
      range_from: new Date(BASE), range_to: new Date(BASE + 3_600_000),
      cursor_timestamp: new Date(BASE + 500),
      cursor_capture_sequence: 42, cursor_kind: "trade",
      cursor_capture_id: "cap-9", cursor_record_key: "cap-9:42",
      speed: "2.00", state: "playing",
      expected_checksum: "e".repeat(64), actual_checksum: "a".repeat(64),
      created_at: new Date(BASE), updated_at: new Date(BASE + 10),
    };
    const { pool } = fakePool([row]);
    const store = new PostgresReplaySessionMetadataStore(pool);
    const session = await store.getSession("11111111-1111-4111-8111-111111111111");
    expect(session).toMatchObject({
      symbol: "BTCUSDT", from: BASE, to: BASE + 3_600_000, speed: 2,
      state: "playing", actualChecksum: "a".repeat(64),
    });
    expect(session?.cursor).toMatchObject({
      timestamp: BASE + 500, captureSequence: 42, captureId: "cap-9",
    });
  });

  it("builds a whitelisted dynamic update and always bumps updated_at", async () => {
    const { pool, statements } = fakePool();
    const store = new PostgresReplaySessionMetadataStore(pool);
    await store.updateSession("sid", {
      state: "complete",
      actualChecksum: "a".repeat(64),
      cursor: { timestamp: BASE + 900, captureSequence: 90, kind: "depth_delta", captureId: "c", recordKey: "c:90" },
    });
    const statement = statements[0]!.text;
    // Cursor fields occupy $2..$6, then state/actual_checksum follow.
    expect(statement).toContain("state = $7");
    expect(statement).toContain("actual_checksum = $8");
    expect(statement).toContain("cursor_timestamp = $2");
    expect(statement).toContain("updated_at = now()");
    expect(statement).not.toContain("dataset_id");
    expect(statement).not.toContain("symbol =");
  });

  it("skips the query entirely for an empty patch", async () => {
    const { pool, statements } = fakePool();
    const store = new PostgresReplaySessionMetadataStore(pool);
    await store.updateSession("sid", {});
    expect(statements).toHaveLength(0);
  });
});
