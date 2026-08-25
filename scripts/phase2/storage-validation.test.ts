import { describe, expect, it } from "vitest";
import {
  validateBackupRestore,
  validateBoundedQueries,
  validatePersistenceAfterRestart,
  validateRetentionDuringIngestion,
} from "./storage-validation.js";

describe("Phase 2 durable history acceptance", () => {
  it("keeps ordered history available after a fresh store instance opens", async () => {
    await expect(validatePersistenceAfterRestart()).resolves.toMatchObject({
      id: "history-persists-after-restart",
      passed: true,
    });
  });

  it("enforces range, row, truncation, and cursor query bounds", async () => {
    await expect(validateBoundedQueries()).resolves.toMatchObject({
      id: "bounded-history-query",
      passed: true,
    });
  });

  it("backs up and restores checksummed immutable history segments", async () => {
    await expect(validateBackupRestore()).resolves.toMatchObject({
      id: "history-backup-restore",
      passed: true,
    });
  });

  it("retains a concurrent live ingestion batch while expiring old data", async () => {
    await expect(validateRetentionDuringIngestion()).resolves.toMatchObject({
      id: "retention-concurrent-with-ingestion",
      passed: true,
    });
  });
});

