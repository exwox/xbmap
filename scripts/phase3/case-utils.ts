import { performance } from "node:perf_hooks";
import type { Phase3Assertion, Phase3ValidationCase } from "./types.js";

export async function measureCase(
  id: string,
  run: () => Promise<{
    assertions: Phase3Assertion[];
    observations?: Phase3ValidationCase["observations"];
    notes?: string[];
  }>,
): Promise<Phase3ValidationCase> {
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
): Phase3Assertion {
  return { name, passed: Object.is(actual, expected), expected, actual };
}

export function assertionBelow(
  name: string,
  actual: number,
  exclusiveLimit: number,
): Phase3Assertion {
  return {
    name,
    passed: actual < exclusiveLimit,
    expected: `< ${exclusiveLimit}`,
    actual: round(actual),
  };
}

export function assertionContains(
  name: string,
  haystack: string,
  needle: string,
): Phase3Assertion {
  return {
    name,
    passed: haystack.includes(needle),
    expected: `includes "${needle}"`,
    actual: haystack.length > 200 ? haystack.slice(0, 200) + "..." : haystack,
  };
}

export function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}