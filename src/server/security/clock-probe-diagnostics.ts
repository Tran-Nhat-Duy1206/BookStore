import "server-only";

// Non-authorizing, isolated-test logging only. No value from this module may
// select clocks, SQL, thresholds, admission decisions or application behavior.
const MAX_RECORDS = 512;
const MAX_DURATION_MS = 60000;
let groups = 0;
let records = 0;

export type ClockProbeDiagnostic = Readonly<{
  group: number;
  role: "verifier" | "staff";
  phase: "initialization" | "operation" | "catch";
  reason: "valid" | "malformed" | "clock-jump" | "uncertain" | "skew";
  rawWallSpanMs: number;
  adjustedWallSpanMs: number;
  precisionPadMs: number;
  monoElapsedMs: number;
  queryAwaitMs: number;
  acquireAwaitMs: number;
  metadataAwaitMs: number;
  relativeInitMs: number;
  relativeProbeMs: number;
  eventLoopActiveMs: number;
  eventLoopIdleMs: number;
  wallExceeded: boolean;
  monoExceeded: boolean;
  overlap: boolean;
  poolTotalBefore: number;
  poolIdleBefore: number;
  poolWaitingBefore: number;
}>;

function enabled() {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS === "1"
  );
}

/** Process-local diagnostic grouping only; zero means logging is disabled. */
export function createClockDiagnosticGroup(): number {
  if (!enabled() || records >= MAX_RECORDS || groups >= Number.MAX_SAFE_INTEGER)
    return 0;
  return ++groups;
}

/** Explicit scalar allowlist; never spread caller objects into the log. */
export function logClockProbeDiagnostic(input: ClockProbeDiagnostic): void {
  try {
    if (
      !enabled() ||
      records >= MAX_RECORDS ||
      !Number.isSafeInteger(input.group) ||
      input.group <= 0 ||
      !["verifier", "staff"].includes(input.role) ||
      !["initialization", "operation", "catch"].includes(input.phase) ||
      !["valid", "malformed", "clock-jump", "uncertain", "skew"].includes(
        input.reason,
      )
    )
      return;
    const capped: Record<string, boolean> = {};
    const invalid: Record<string, boolean> = {};
    function duration(name: string, value: number, signed = false): number {
      const bad =
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (!signed && value < 0);
      invalid[name] = bad;
      capped[name] = !bad && Math.abs(value) > MAX_DURATION_MS;
      if (bad) return 0;
      const bounded = Math.max(
        signed ? -MAX_DURATION_MS : 0,
        Math.min(MAX_DURATION_MS, value),
      );
      return Math.round(bounded * 1000) / 1000;
    }
    function count(name: string, value: number): number {
      invalid[name] = !Number.isSafeInteger(value) || value < 0;
      capped[name] = !invalid[name] && value > MAX_RECORDS;
      return invalid[name] ? 0 : Math.min(MAX_RECORDS, value);
    }
    const output = {
      group: input.group,
      role: input.role,
      phase: input.phase,
      reason: input.reason,
      rawWallSpanMs: duration("rawWallSpanMs", input.rawWallSpanMs, true),
      adjustedWallSpanMs: duration(
        "adjustedWallSpanMs",
        input.adjustedWallSpanMs,
        true,
      ),
      precisionPadMs: duration("precisionPadMs", input.precisionPadMs),
      monoElapsedMs: duration("monoElapsedMs", input.monoElapsedMs),
      // Full client.query await bracket, NOT server SQL execution time.
      queryAwaitMs: duration("queryAwaitMs", input.queryAwaitMs),
      acquireAwaitMs: duration("acquireAwaitMs", input.acquireAwaitMs),
      metadataAwaitMs: duration("metadataAwaitMs", input.metadataAwaitMs),
      relativeInitMs: duration("relativeInitMs", input.relativeInitMs),
      relativeProbeMs: duration("relativeProbeMs", input.relativeProbeMs),
      // Native event-loop utilization deltas are NOT CPU time or delay.
      eventLoopActiveMs: duration("eventLoopActiveMs", input.eventLoopActiveMs),
      eventLoopIdleMs: duration("eventLoopIdleMs", input.eventLoopIdleMs),
      wallExceeded: input.wallExceeded === true,
      monoExceeded: input.monoExceeded === true,
      overlap: input.overlap === true,
      poolTotalBefore: count("poolTotalBefore", input.poolTotalBefore),
      poolIdleBefore: count("poolIdleBefore", input.poolIdleBefore),
      poolWaitingBefore: count("poolWaitingBefore", input.poolWaitingBefore),
      capped,
      invalid,
    };
    records++;
    console.info(
      `BookStore clock quality diagnostic ${JSON.stringify(output)}`,
    );
  } catch {
    // Even logging failure cannot change the original admission result.
  }
}
