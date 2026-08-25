import { describe, expect, it } from "vitest";
import { AuthService } from "../auth/authService.js";

function makeEngine(options: {
  maxFailedAttempts?: number;
  lockoutMs?: number;
  ttlMs?: number;
} = {}) {
  let now = 1_000_000;
  let tokenCounter = 0;
  const service = new AuthService(
    {
      sessionTtlMs: options.ttlMs ?? 60_000,
      maxFailedAttempts: options.maxFailedAttempts ?? 3,
      lockoutMs: options.lockoutMs ?? 120_000,
      now: () => now,
      randomToken: () => `tok-${(tokenCounter += 1)}`,
    },
    { username: "admin", password: "s3cret-pass" },
  );
  return {
    service,
    setNow: (value: number) => {
      now = value;
    },
    getNow: () => now,
  };
}

describe("phase 6 auth service", () => {
  it("accepts the bootstrap credential and rejects wrong passwords", () => {
    const harness = makeEngine();
    expect(harness.service.authenticate("admin", "s3cret-pass")).toEqual({
      ok: true,
      username: "admin",
    });
    const wrong = harness.service.authenticate("admin", "nope");
    expect(wrong).toMatchObject({ ok: false, reason: "invalid_credentials" });
    const wrongUser = harness.service.authenticate("root", "s3cret-pass");
    expect(wrongUser).toMatchObject({ ok: false, reason: "invalid_credentials" });
  });

  it("locks the account after the maximum failed attempts and reports retry time", () => {
    const harness = makeEngine({ maxFailedAttempts: 3, lockoutMs: 120_000 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      harness.setNow(harness.getNow() + 1_000);
      const failed = harness.service.authenticate("admin", "bad");
      expect(failed.ok).toBe(false);
      if (!failed.ok && failed.reason === "invalid_credentials") {
        // expected branch
      } else {
        throw new Error(`expected invalid_credentials, got ${JSON.stringify(failed)}`);
      }
    }
    harness.setNow(harness.getNow() + 1_000);
    const locked = harness.service.authenticate("admin", "bad");
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.reason).toBe("account_locked");
    if (!locked.ok && locked.reason === "account_locked") {
      expect(locked.retryInSeconds).toBe(120);
    }

    // Even the correct password stays locked until the window passes.
    harness.setNow(harness.getNow() + 60_000);
    const stillLocked = harness.service.authenticate("admin", "s3cret-pass");
    expect(stillLocked.ok).toBe(false);
    if (!stillLocked.ok) expect(stillLocked.reason).toBe("account_locked");

    harness.setNow(harness.getNow() + 61_000);
    expect(harness.service.authenticate("admin", "s3cret-pass")).toEqual({
      ok: true,
      username: "admin",
    });
  });

  it("issues sliding sessions that expire without activity and revokes instantly", () => {
    const harness = makeEngine({ ttlMs: 30_000 });
    const session = harness.service.createSession("admin");
    expect(session.token).toBe("tok-1");

    // Activity at +20s refreshes expiry to +50s.
    harness.setNow(20_000);
    expect(harness.service.validateSession(session.token)?.username).toBe("admin");
    expect(harness.service.validateSession(session.token)?.expiresAtMs).toBe(20_000 + 30_000);

    // No activity: expires 30s after the last touch.
    harness.setNow(51_000);
    expect(harness.service.validateSession(session.token)).toBeNull();

    // Revocation removes an active session immediately.
    const fresh = harness.service.createSession("admin");
    expect(harness.service.validateSession(fresh.token)).not.toBeNull();
    expect(harness.service.revokeSession(fresh.token)).toBe(true);
    expect(harness.service.validateSession(fresh.token)).toBeNull();
    expect(harness.service.sessionCount()).toBe(0);
  });
});