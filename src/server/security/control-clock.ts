/** Fixed B2b sample-quality candidates, not approved operational policy. */
export const CONTROL_MAX_SKEW_MS = 5000;
export const CONTROL_MAX_SAMPLE_MS = 250;
export const CONTROL_MAX_CLOCK_JUMP_MS = 25;

export type ControlClockSampleReason =
  "valid" | "malformed" | "clock-jump" | "uncertain" | "skew";

export type ControlClockSampleAssessment = Readonly<{
  valid: boolean;
  reason: ControlClockSampleReason;
}>;

const keys = [
  "nodeBeforeMs",
  "nodeAfterMs",
  "monotonicElapsedMs",
  "databaseTime",
] as const;

function result(
  reason: ControlClockSampleReason,
): ControlClockSampleAssessment {
  return Object.freeze({ valid: reason === "valid", reason });
}

function wallTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8640000000000000
  );
}

/**
 * Pure, non-authorizing validation of caller-supplied sample metadata ONLY.
 * The private caller must bracket its actual PG clock probe with Date.now()
 * and a monotonic elapsed measurement. The complete possible offset interval,
 * not its midpoint, must fit within the skew bound. Canonical millisecond UTC
 * strings only: Date instances and implicitly coerced values are rejected.
 *
 * This does not authenticate the samples, prove a continuously bounded OS
 * clock during SDK work, or provide a physical monotonic database clock.
 * Trusted clock behavior THROUGHOUT verification remains a separate assumption.
 * Durable DB high-watermarks/deadlines and positive proof authority are elsewhere;
 * no clock reader, injectable time source, mutable policy or authority lives here.
 */
export function validateControlClockSample(
  input: unknown,
): ControlClockSampleAssessment {
  try {
    if (input === null || typeof input !== "object") return result("malformed");
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
      return result("malformed");
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some(
        (key) =>
          typeof key !== "string" || !keys.some((known) => known === key),
      )
    )
      return result("malformed");
    const values: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor)) return result("malformed");
      values[key] = descriptor.value;
    }
    const before = values.nodeBeforeMs;
    const after = values.nodeAfterMs;
    const elapsed = values.monotonicElapsedMs;
    const databaseTime = values.databaseTime;
    if (
      !wallTime(before) ||
      !wallTime(after) ||
      typeof elapsed !== "number" ||
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      typeof databaseTime !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(databaseTime)
    )
      return result("malformed");
    const databaseMs = Date.parse(databaseTime);
    if (
      !wallTime(databaseMs) ||
      new Date(databaseMs).toISOString() !== databaseTime
    )
      return result("malformed");
    if (after < before) return result("clock-jump");
    const width = after - before;
    if (width > CONTROL_MAX_SAMPLE_MS || elapsed > CONTROL_MAX_SAMPLE_MS)
      return result("uncertain");
    if (Math.abs(width - elapsed) > CONTROL_MAX_CLOCK_JUMP_MS)
      return result("clock-jump");
    if (
      before - databaseMs < -CONTROL_MAX_SKEW_MS ||
      after - databaseMs > CONTROL_MAX_SKEW_MS
    )
      return result("skew");
    return result("valid");
  } catch {
    // Hostile proxy/descriptor traps must not expose values or exception text.
    return result("malformed");
  }
}
