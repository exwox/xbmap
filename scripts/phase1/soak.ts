import {
  customSoakConfiguration,
  fullEightHourSoakConfiguration,
  quickSoakConfiguration,
  runWallClockSoak,
} from "./soak-core.js";
import type { SoakConfiguration } from "./types.js";

interface ParsedArguments {
  configuration: SoakConfiguration;
  help: boolean;
}

async function main(): Promise<void> {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(helpText());
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const report = await runWallClockSoak(parsed.configuration, controller.signal);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.status !== "passed") process.exitCode = report.status === "aborted" ? 130 : 1;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      validationSchemaVersion: 1,
      kind: "phase-1-wall-clock-soak",
      status: "failed",
      fatal: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

export function parseArguments(arguments_: string[]): ParsedArguments {
  let mode: "quick" | "full" | "custom" | undefined;
  let durationMs: number | undefined;
  let sampleIntervalMs: number | undefined;
  let warmupMs: number | undefined;
  let eventRate: number | undefined;
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--quick") {
      selectMode("quick");
    } else if (argument === "--full") {
      selectMode("full");
    } else if (argument === "--duration") {
      selectMode("custom");
      durationMs = parseDuration(requiredValue(arguments_, ++index, argument));
    } else if (argument === "--sample-interval") {
      sampleIntervalMs = parseDuration(requiredValue(arguments_, ++index, argument));
    } else if (argument === "--warmup") {
      warmupMs = parseDuration(requiredValue(arguments_, ++index, argument));
    } else if (argument === "--event-rate") {
      eventRate = Number(requiredValue(arguments_, ++index, argument));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  let configuration = mode === "full"
    ? fullEightHourSoakConfiguration()
    : mode === "custom"
      ? customSoakConfiguration(durationMs!)
      : quickSoakConfiguration();
  configuration = {
    ...configuration,
    ...(sampleIntervalMs === undefined ? {} : { sampleIntervalMs }),
    ...(warmupMs === undefined ? {} : { warmupMs }),
    ...(eventRate === undefined ? {} : { marketEventsPerSecond: eventRate }),
  };
  return { configuration, help };

  function selectMode(next: "quick" | "full" | "custom"): void {
    if (mode && mode !== next) throw new Error("Choose exactly one of --quick, --full, or --duration");
    mode = next;
  }
}

export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim().toLowerCase());
  if (!match) throw new Error(`Invalid duration '${value}'; use ms, s, m, or h`);
  const amount = Number(match[1]);
  const unit = match[2]!;
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(amount * multiplier);
}

function requiredValue(arguments_: string[], index: number, flag: string): string {
  const value = arguments_[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function helpText(): string {
  return [
    "LiquidMap Phase 1 wall-clock soak harness",
    "",
    "  node --expose-gc --import tsx scripts/phase1/soak.ts --quick",
    "  node --expose-gc --import tsx scripts/phase1/soak.ts --full",
    "  node --expose-gc --import tsx scripts/phase1/soak.ts --duration 30m",
    "",
    "--quick is a five-second smoke test. --full is the explicit eight-hour exit gate.",
    "A custom --duration 8h remains a custom diagnostic and is not mislabeled as the full gate.",
    "All test modes use actual wall time and print one machine-readable JSON document.",
    "",
  ].join("\n");
}

void main();
