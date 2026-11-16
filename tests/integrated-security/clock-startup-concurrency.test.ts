import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdmissionAuthority } from "../../src/server/security/admission-authority";
import {
  CONTROL_MAX_CLOCK_JUMP_MS,
  CONTROL_MAX_SAMPLE_MS,
  CONTROL_MAX_SKEW_MS,
} from "../../src/server/security/control-clock";
import { ControlFixtures, secretSafe } from "../admission-controls/fixtures";

// F: one diagnostic batch, not positive authentication or an availability gate.
// No injected clocks, private-client hooks, intentional locks, load or retries.
const fx = new ControlFixtures();
const prefix = "BookStore clock quality diagnostic ";
const priorFlag = process.env.BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS;
const samples: Record<string, string | number | boolean>[] = [];
const outstanding = new Set<
  Awaited<ReturnType<typeof createAdmissionAuthority>>
>();
let spy: ReturnType<typeof vi.spyOn> | undefined;
let invalidDiagnostic = false;
let writeInfo: typeof console.info;

const durationKeys = [
  "rawWallSpanMs",
  "adjustedWallSpanMs",
  "precisionPadMs",
  "monoElapsedMs",
  "queryAwaitMs",
  "acquireAwaitMs",
  "metadataAwaitMs",
  "relativeInitMs",
  "relativeProbeMs",
  "eventLoopActiveMs",
  "eventLoopIdleMs",
] as const;
const countKeys = [
  "poolTotalBefore",
  "poolIdleBefore",
  "poolWaitingBefore",
] as const;
const flagKeys = ["wallExceeded", "monoExceeded", "overlap"] as const;

function collect(value: unknown): void {
  if (typeof value !== "string" || !value.startsWith(prefix)) return;
  try {
    const parsed: unknown = JSON.parse(value.slice(prefix.length));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    const input = parsed as Record<string, unknown>;
    if (
      !["staff", "verifier"].includes(String(input.role)) ||
      !["initialization", "operation", "catch"].includes(String(input.phase)) ||
      !["valid", "malformed", "clock-jump", "uncertain", "skew"].includes(
        String(input.reason),
      ) ||
      !Number.isSafeInteger(input.group) ||
      (input.group as number) <= 0
    )
      throw new Error();
    // Reconstruct an allowlist, never forward the raw parsed object or stdout.
    const output: Record<string, string | number | boolean> = {
      role: String(input.role),
      phase: String(input.phase),
      reason: String(input.reason),
      group: input.group as number, // process-local diagnostic group, NOT a PID
    };
    for (const key of durationKeys) {
      const number = input[key];
      if (
        typeof number !== "number" ||
        !Number.isFinite(number) ||
        Math.abs(number) > 60000 ||
        (!["rawWallSpanMs", "adjustedWallSpanMs"].includes(key) && number < 0)
      )
        throw new Error();
      output[key] = number;
    }
    for (const key of countKeys) {
      const number = input[key];
      if (
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 0 ||
        number > 512
      )
        throw new Error();
      output[key] = number;
    }
    for (const key of flagKeys) {
      if (typeof input[key] !== "boolean") throw new Error();
      output[key] = input[key];
    }
    for (const name of ["capped", "invalid"] as const) {
      const flags = input[name];
      if (!flags || typeof flags !== "object" || Array.isArray(flags))
        throw new Error();
      const values = Object.values(flags);
      if (values.length !== durationKeys.length + countKeys.length)
        throw new Error();
      if (!values.every((flag) => typeof flag === "boolean")) throw new Error();
      output[`${name}Observed`] = values.some((flag) => flag === true);
    }
    if (samples.length >= 32) throw new Error();
    samples.push(output);
  } catch {
    invalidDiagnostic = true; // Never include raw data in assertion failures.
  }
}

beforeAll(() =>
  secretSafe(async () => {
    expect(process.env.NODE_ENV === "test").toBe(true);
    process.env.BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS = "1";
    writeInfo = console.info;
    spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      for (const value of args) collect(value);
    });
    await fx.start();
  }),
);

afterAll(() =>
  secretSafe(async () => {
    try {
      const cleanup = await Promise.allSettled(
        [...outstanding].map(async (authority) => {
          await authority.close();
          outstanding.delete(authority);
        }),
      );
      await fx.stop();
      expect(cleanup.every((result) => result.status === "fulfilled")).toBe(
        true,
      );
    } finally {
      spy?.mockRestore();
      if (priorFlag === undefined)
        delete process.env.BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS;
      else process.env.BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS = priorFlag;
    }
  }),
);

type Outcome = Readonly<{
  initialized: boolean;
  closed: boolean;
  unavailable: boolean;
  unclassified: boolean;
}>;
async function attempt(): Promise<Outcome> {
  let authority:
    Awaited<ReturnType<typeof createAdmissionAuthority>> | undefined;
  try {
    authority = await createAdmissionAuthority({
      verifierUrl: fx.owned.verifierUrl,
      staffUrl: fx.owned.staffUrl,
    });
    outstanding.add(authority);
    await authority.close();
    outstanding.delete(authority);
    return {
      initialized: true,
      closed: true,
      unavailable: false,
      unclassified: false,
    };
  } catch (error: unknown) {
    const unavailable =
      authority === undefined &&
      error instanceof Error &&
      error.message === "metadataUnavailable";
    return {
      initialized: authority !== undefined,
      closed: false,
      unavailable,
      unclassified: !unavailable,
    };
  }
}

describe("B2e F actual concurrent startup diagnostic, unchanged policy", () => {
  it("accounts for one fixed simultaneous batch of two actual constructors", () =>
    secretSafe(async () => {
      expect(CONTROL_MAX_SAMPLE_MS).toBe(250);
      expect(CONTROL_MAX_CLOCK_JUMP_MS).toBe(25);
      expect(CONTROL_MAX_SKEW_MS).toBe(5000);
      const start = samples.length; // Exclude fixture startup's own authority.
      const settled = await Promise.allSettled([attempt(), attempt()]);
      const outcomes: Outcome[] = settled.map((result) =>
        result.status === "fulfilled"
          ? result.value
          : {
              initialized: false,
              closed: false,
              unavailable: false,
              unclassified: true,
            },
      );
      const observed = samples.slice(start);
      const count = (key: keyof Outcome) =>
        outcomes.filter((outcome) => outcome[key]).length;
      // Every unavailable is explicit. A completed diagnostic is NOT availability PASS.
      writeInfo(
        JSON.stringify({
          diagnostic: "clock-quality-concurrent-startup-batch",
          planned: 2,
          outcomes: outcomes.length,
          initialized: count("initialized"),
          closed: count("closed"),
          unavailable: count("unavailable"),
          unclassified: count("unclassified"),
          initializationSamples: observed.filter(
            (sample) => sample.phase === "initialization",
          ).length,
          verifierSamples: observed.filter(
            (sample) => sample.role === "verifier",
          ).length,
          staffSamples: observed.filter((sample) => sample.role === "staff")
            .length,
          uncertainSamples: observed.filter(
            (sample) => sample.reason === "uncertain",
          ).length,
          invalidDiagnostic,
        }),
      );
      for (const sample of observed)
        writeInfo(
          JSON.stringify({
            diagnostic: "clock-quality-concurrent-startup-sample",
            sample,
          }),
        );
      expect(outcomes.length).toBe(2);
      expect(count("unclassified")).toBe(0);
      expect(count("initialized") + count("unavailable")).toBe(2);
      expect(count("closed")).toBe(count("initialized"));
      expect(outstanding.size).toBe(0);
      expect(invalidDiagnostic).toBe(false);
      expect(observed.length <= 4).toBe(true);
      expect(observed.length >= 2 * count("initialized")).toBe(true);
      expect(new Set(observed.map((sample) => sample.group)).size <= 2).toBe(
        true,
      );
      expect(
        observed.every((sample) => sample.phase === "initialization"),
      ).toBe(true);
      expect(
        observed.filter((sample) => sample.role === "verifier").length <= 2,
      ).toBe(true);
      expect(
        observed.filter((sample) => sample.role === "staff").length <= 2,
      ).toBe(true);
      expect(
        observed.every(
          (sample) =>
            sample.invalidObserved === false && sample.cappedObserved === false,
        ),
      ).toBe(true);
    }));
});
