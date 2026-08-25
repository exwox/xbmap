import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Phase 6 persistent store for users, per-user workspaces, and feature flags.
 *
 * Zero-dependency JSON file with debounced writes, mirroring the alert-rules
 * persistence pattern. A production database can replace the backend later
 * without touching call sites: every consumer goes through this class.
 */

export const USERS_STORE_SCHEMA_VERSION = 1 as const;

export type UserRole = "admin" | "viewer";

export interface StoredUser {
  username: string;
  role: UserRole;
  saltHex: string;
  hashHex: string;
  disabled: boolean;
  createdAtMs: number;
}

export interface PublicUser {
  username: string;
  role: UserRole;
  disabled: boolean;
  createdAtMs: number;
}

export interface UserStoreOptions {
  /** Required for persistence; missing/corrupt file starts an empty store. */
  filePath?: string;
  now?: () => number;
  writeDelayMs?: number;
}

interface StoreFile {
  schemaVersion: typeof USERS_STORE_SCHEMA_VERSION;
  users: StoredUser[];
  workspaces: Record<string, unknown>;
  featureFlags: Record<string, boolean>;
}

function emptyStore(): StoreFile {
  return {
    schemaVersion: USERS_STORE_SCHEMA_VERSION,
    users: [],
    workspaces: {},
    featureFlags: {},
  };
}

function hashPassword(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, "hex"), 32).toString("hex");
}

export class UserStore {
  private data: StoreFile = emptyStore();
  private readonly filePath: string | undefined;
  private readonly now: () => number;
  private readonly writeDelayMs: number;
  private saveTimer: NodeJS.Timeout | null = null;

  private constructor(options: UserStoreOptions) {
    this.filePath = options.filePath?.trim() || undefined;
    this.now = options.now ?? Date.now;
    this.writeDelayMs = Math.max(0, options.writeDelayMs ?? 400);
  }

  /** Loads the JSON file when configured; corrupt content starts empty. */
  static async open(options: UserStoreOptions): Promise<UserStore> {
    const store = new UserStore(options);
    if (!store.filePath) return store;
    try {
      const raw = await readFile(store.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      if (Array.isArray(parsed.users)) {
        store.data = {
          schemaVersion: USERS_STORE_SCHEMA_VERSION,
          users: parsed.users.filter((user) =>
            Boolean(user) &&
            typeof user.username === "string" &&
            typeof user.saltHex === "string" &&
            typeof user.hashHex === "string"),
          workspaces:
            parsed.workspaces && typeof parsed.workspaces === "object"
              ? parsed.workspaces
              : {},
          featureFlags:
            parsed.featureFlags && typeof parsed.featureFlags === "object"
              ? parsed.featureFlags
              : {},
        };
      }
    } catch {
      // Missing or unreadable file → start from an empty store.
    }
    return store;
  }

  // USERS_METHODS_MARKER

  /** Creates a user; rejects duplicates and invalid shapes. */
  createUser(input: {
    username: string;
    password: string;
    role?: UserRole;
    disabled?: boolean;
  }): PublicUser {
    const username = input.username.trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      throw new TypeError("Username must be 3-32 chars: letters, digits, . _ -");
    }
    if (typeof input.password !== "string" || input.password.length < 8) {
      throw new TypeError("Password must be at least 8 characters");
    }
    if (this.find(username)) {
      throw new TypeError(`User already exists: ${username}`);
    }
    const role: UserRole = input.role === "admin" ? "admin" : "viewer";
    const saltHex = randomBytes(16).toString("hex");
    const user: StoredUser = {
      username,
      role,
      saltHex,
      hashHex: hashPassword(input.password, saltHex),
      disabled: input.disabled === true,
      createdAtMs: this.now(),
    };
    this.data.users.push(user);
    this.scheduleSave();
    return toPublic(user);
  }

  /** Seeds the bootstrap admin only when no active admin exists yet. */
  ensureBootstrapAdmin(username: string, password: string): boolean {
    if (this.data.users.some((user) => user.role === "admin" && !user.disabled)) {
      return false;
    }
    try {
      this.createUser({ username, password, role: "admin" });
      return true;
    } catch {
      // Username collision with an existing account: promote it instead.
      const existing = this.find(username);
      if (!existing) return false;
      existing.role = "admin";
      existing.disabled = false;
      this.setPassword(username, password);
      return true;
    }
  }

  verifyCredentials(username: string, password: string): boolean {
    const user = this.find(username);
    if (!user || user.disabled) return false;
    const candidate = Buffer.from(hashPassword(password ?? "", user.saltHex), "hex");
    const expected = Buffer.from(user.hashHex, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  listUsers(): PublicUser[] {
    return this.data.users.map(toPublic);
  }

  roleOf(username: string): UserRole | null {
    return this.find(username)?.role ?? null;
  }

  private find(username: string): StoredUser | undefined {
    return this.data.users.find((user) => user.username === username.trim());
  }

  setPassword(username: string, newPassword: string): boolean {
    const user = this.find(username);
    if (!user || newPassword.length < 8) return false;
    user.saltHex = randomBytes(16).toString("hex");
    user.hashHex = hashPassword(newPassword, user.saltHex);
    this.scheduleSave();
    return true;
  }

  setDisabled(username: string, disabled: boolean): boolean {
    const user = this.find(username);
    if (!user) return false;
    user.disabled = disabled;
    this.scheduleSave();
    return true;
  }

  deleteUser(username: string): boolean {
    const trimmed = username.trim();
    const before = this.data.users.length;
    this.data.users = this.data.users.filter((user) => user.username !== trimmed);
    const changed = this.data.users.length !== before;
    if (changed) {
      delete this.data.workspaces[trimmed];
      this.scheduleSave();
    }
    return changed;
  }

  // ── Workspace & feature flags ────────────────────────────────────────────

  getWorkspace(username: string): unknown | null {
    const value = this.data.workspaces[username.trim()];
    return value === undefined ? null : value;
  }

  setWorkspace(username: string, workspace: unknown): void {
    if (!this.find(username)) {
      throw new TypeError(`Unknown user: ${username}`);
    }
    if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) {
      throw new TypeError("Workspace must be a JSON object");
    }
    this.data.workspaces[username.trim()] = workspace;
    this.scheduleSave();
  }

  getFlags(): Record<string, boolean> {
    return { ...this.data.featureFlags };
  }

  setFlag(name: string, value: boolean): void {
    if (!/^[a-zA-Z0-9_]{1,40}$/.test(name)) {
      throw new TypeError("Flag name must be 1-40 chars: letters, digits, _");
    }
    this.data.featureFlags[name] = value;
    this.scheduleSave();
  }

  /** Immediate write; used by graceful shutdown and tests. */
  async flush(): Promise<void> {
    await this.writeNow();
  }

  private scheduleSave(): void {
    if (!this.filePath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.writeNow().catch(() => {});
    }, this.writeDelayMs);
    this.saveTimer.unref?.();
  }

  private async writeNow(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(this.data, null, 2)}\n`,
      "utf8",
    );
  }
}

function toPublic(user: StoredUser): PublicUser {
  return {
    username: user.username,
    role: user.role,
    disabled: user.disabled,
    createdAtMs: user.createdAtMs,
  };
}
