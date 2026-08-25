import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Phase 6 auth foundation: single-bootstrap admin credential with scrypt
 * hashing, opaque bearer sessions (httpOnly cookie), sliding expiry, and
 * simple failed-attempt lockout. Deliberately minimal — full multi-user
 * management arrives later in Phase 6.
 */

export const SESSION_COOKIE_NAME = "xbmap_session";

export interface AuthServiceOptions {
  /** Sliding window; each successful validation extends the session. */
  sessionTtlMs?: number;
  maxFailedAttempts?: number;
  lockoutMs?: number;
  now?: () => number;
  randomToken?: () => string;
  /**
   * Phase 6 multi-user: external credential check (e.g. UserStore). When
   * provided it replaces the single built-in bootstrap credential, while
   * lockout/session behaviour stays identical.
   */
  verify?: (username: string, password: string) => boolean;
}

export interface AdminCredential {
  username: string;
  password: string;
}

export type AuthenticateResult =
  | { ok: true; username: string }
  | { ok: false; reason: "invalid_credentials" }
  | { ok: false; reason: "account_locked"; retryInSeconds: number };

export interface ActiveSession {
  token: string;
  username: string;
  createdAtMs: number;
  expiresAtMs: number;
}

interface StoredCredential {
  username: string;
  saltHex: string;
  hashHex: string;
}

function hashPassword(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, "hex"), 32).toString("hex");
}

function safeEqualHex(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AuthService {
  private readonly credential: StoredCredential | null;
  private readonly verifyFn: ((username: string, password: string) => boolean) | null;
  private readonly ttlMs: number;
  private readonly maxFailedAttempts: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly sessions = new Map<string, ActiveSession>();
  private failedAttempts = 0;
  private lockedUntilMs = 0;

  constructor(
    options: AuthServiceOptions = {},
    credential?: AdminCredential,
  ) {
    this.ttlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60_000;
    this.maxFailedAttempts = Math.max(1, options.maxFailedAttempts ?? 5);
    this.lockoutMs = Math.max(0, options.lockoutMs ?? 300_000);
    this.now = options.now ?? Date.now;
    this.randomToken =
      options.randomToken ?? (() => randomBytes(32).toString("hex"));
    this.verifyFn = options.verify ?? null;
    if (this.verifyFn) {
      // Multi-user mode: credential verification is delegated to the store.
      this.credential = null;
      return;
    }
    if (!credential?.username || !credential.password) {
      throw new TypeError("AuthService requires a verify function or an admin username/password");
    }
    const saltHex = randomBytes(16).toString("hex");
    this.credential = {
      username: credential.username,
      saltHex,
      hashHex: hashPassword(credential.password, saltHex),
    };
  }

  authenticate(username: string, password: string): AuthenticateResult {
    const now = this.now();
    if (this.lockedUntilMs > now) {
      return {
        ok: false,
        reason: "account_locked",
        retryInSeconds: Math.ceil((this.lockedUntilMs - now) / 1_000),
      };
    }
    let userMatches = false;
    if (this.verifyFn) {
      userMatches = this.verifyFn(username, password ?? "");
    } else {
      const cred = this.credential;
      userMatches =
        cred !== null &&
        timingSafeEqual(
          createHash("sha256").update(username).digest(),
          createHash("sha256").update(cred.username).digest(),
        ) &&
        safeEqualHex(
          hashPassword(password ?? "", cred.saltHex),
          cred.hashHex,
        );
    }
    if (!userMatches) {
      this.failedAttempts += 1;
      if (this.failedAttempts >= this.maxFailedAttempts) {
        this.lockedUntilMs = now + this.lockoutMs;
        this.failedAttempts = 0;
      }
      if (this.lockedUntilMs > now) {
        return {
          ok: false,
          reason: "account_locked",
          retryInSeconds: Math.ceil((this.lockedUntilMs - now) / 1_000),
        };
      }
      return { ok: false, reason: "invalid_credentials" };
    }

    this.failedAttempts = 0;
    this.lockedUntilMs = 0;
    return {
      ok: true,
      username: this.verifyFn ? username : this.credential!.username,
    };
  }

  /** Opaque bearer token bound to the username; sliding expiry on validation. */
  createSession(username: string): ActiveSession {
    const now = this.now();
    const session: ActiveSession = {
      token: this.randomToken(),
      username,
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  /** Returns the (refreshed) session, or null when unknown/expired/revoked. */
  validateSession(token: string): ActiveSession | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    const now = this.now();
    if (session.expiresAtMs <= now) {
      this.sessions.delete(token);
      return null;
    }
    session.expiresAtMs = now + this.ttlMs; // sliding window
    return session;
  }

  revokeSession(token: string): boolean {
    return this.sessions.delete(token);
  }

  sessionCount(): number {
    return this.sessions.size;
  }
}