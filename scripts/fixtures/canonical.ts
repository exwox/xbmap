import { createHash } from "node:crypto";

/** Stable key ordering keeps fixture bytes identical across runs and Node versions. */
export function canonicalJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, candidate: unknown) => {
      if (
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
      ) {
        const record = candidate as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(record)
            .sort()
            .filter((key) => record[key] !== undefined)
            .map((key) => [key, record[key]]),
        );
      }
      return candidate;
    },
    space,
  );
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
