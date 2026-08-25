import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ReplaySessionRepository, ReplaySessionSnapshot } from "./sessionManager.js";

const MAX_REPOSITORY_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 1_000;

interface RepositoryDocument {
  version: 1;
  sessions: ReplaySessionSnapshot[];
}

/** Small atomic checkpoint repository; historical frames remain in the source store. */
export class FileReplaySessionRepository implements ReplaySessionRepository {
  readonly path: string;
  private cache: Map<string, ReplaySessionSnapshot> | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    if (!path.trim() || path.includes("\0")) {
      throw new TypeError("Replay session repository path must be non-empty");
    }
    this.path = resolve(path);
  }

  load(): Promise<ReplaySessionSnapshot[]> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      return [...this.cache!.values()].map((session) => structuredClone(session));
    });
  }

  save(session: ReplaySessionSnapshot): Promise<void> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      if (!this.cache!.has(session.id) && this.cache!.size >= MAX_SESSIONS) {
        throw new Error(`Replay session repository exceeded ${MAX_SESSIONS} sessions`);
      }
      this.cache!.set(session.id, structuredClone(session));
      await this.flush();
    });
  }

  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      if (!this.cache!.delete(id)) return;
      await this.flush();
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.cache) return;
    this.cache = new Map();
    try {
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Replay session repository must be a regular file");
      }
      if (metadata.size > MAX_REPOSITORY_BYTES) {
        throw new Error("Replay session repository exceeds the 4 MiB limit");
      }
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error("Malformed replay session repository");
      }
      if (parsed.sessions.length > MAX_SESSIONS) {
        throw new Error(`Replay session repository exceeded ${MAX_SESSIONS} sessions`);
      }
      for (const value of parsed.sessions) {
        if (!isObject(value) || typeof value.id !== "string" || !value.id) {
          throw new Error("Malformed replay session entry");
        }
        this.cache.set(value.id, structuredClone(value) as unknown as ReplaySessionSnapshot);
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        this.cache = null;
        throw error;
      }
    }
  }

  private async flush(): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentMetadata = await lstat(parent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw new Error("Replay session repository parent must be a real directory");
    }
    try {
      const targetMetadata = await lstat(this.path);
      if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
        throw new Error("Replay session repository must be a regular file");
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }

    const document: RepositoryDocument = {
      version: 1,
      sessions: [...this.cache!.values()].sort((left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    };
    const payload = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(payload) > MAX_REPOSITORY_BYTES) {
      throw new Error("Replay session repository exceeds the 4 MiB limit");
    }
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      // Confirm an unexpected filesystem adapter did not publish a special file.
      const metadata = await stat(this.path);
      if (!metadata.isFile()) throw new Error("Replay session checkpoint was not a regular file");
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private serialize<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
