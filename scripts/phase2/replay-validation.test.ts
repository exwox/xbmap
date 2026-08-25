import { describe, expect, it } from "vitest";
import {
  validateDeterministicReplayChecksums,
  validateOneHourReplayStartup,
  validateReplaySessionRestart,
} from "./replay-validation.js";

describe("Phase 2 replay acceptance", () => {
  it("starts a one-market-hour synthetic replay in under three seconds", async () => {
    await expect(validateOneHourReplayStartup()).resolves.toMatchObject({
      id: "one-hour-replay-startup",
      passed: true,
    });
  });

  it("keeps full and seeked checksums invariant from 0.25x through 20x", async () => {
    await expect(validateDeterministicReplayChecksums()).resolves.toMatchObject({
      id: "speed-and-seek-invariant-replay-checksum",
      passed: true,
    });
  });

  it("restores a durable checkpoint and supports pause, seek, speed, and resume", async () => {
    await expect(validateReplaySessionRestart()).resolves.toMatchObject({
      id: "replay-session-checkpoint-restart",
      passed: true,
    });
  });
});

