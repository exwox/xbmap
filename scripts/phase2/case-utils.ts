import { performance } from "node:perf_hooks";
import type {
  Phase2Assertion,
  Phase2ValidationCase,
} from "./types.js";

export async function measureCase(
  id: string,
  run: () => Promise<{
    assertions: Phase2Assertion[];
    observations?: Phase2ValidationCase["observations"];
    notes?: string[];
  }>,
): Promise<Phase2ValidationCase> {
  const started = performance.now();
  try {
    const result = await run();
    const assertions = result.assertions;
    return {
      id,
      passed: assertions.length > 0 && assertions.every((assertion) => assertion.passed),
      durationMs: round(performance.now() - started),
      assertions,
      observations: result.observations ?? {},
      notes: result.notes ?? [],
    };
  } catch (error) {
    return {
      id,
      passed: false,
      durationMs: round(performance.now() - started),
      assertions: [
        {
          name: "case completed without an unexpected error",
          passed: false,
          expected: true,
          actual: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
      ],
      observations: {},
      notes: [],
    };
  }
}

export function assertion(
  name: string,
  actual: string | number | boolean,
  expected: string | number | boolean,
): Phase2Assertion {
  return { name, passed: Object.is(actual, expected), expected, actual };
}

export function assertionBelow(
  name: string,
  actual: number,
  exclusiveLimit: number,
): Phase2Assertion {
  return {
    name,
    passed: actual < exclusiveLimit,
    expected: `< ${exclusiveLimit}`,
    actual: round(actual),
  };
}

export function assertionAtLeast(
  name: string,
  actual: number,
  inclusiveMinimum: number,
): Phase2Assertion {
  return {
    name,
    passed: actual >= inclusiveMinimum,
    expected: `>= ${inclusiveMinimum}`,
    actual: round(actual),
  };
}

export function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
