import { describe, expect, it } from "vitest";
import {
  CONTROL_MAX_CLOCK_JUMP_MS,
  CONTROL_MAX_SAMPLE_MS,
  CONTROL_MAX_SKEW_MS,
  validateControlClockSample,
  type ControlClockSampleReason,
} from "../../src/server/security/control-clock";

const databaseTime = "2026-01-01T00:00:00.000Z";
const databaseMs = Date.parse(databaseTime);
const sample = {
  nodeBeforeMs: databaseMs,
  nodeAfterMs: databaseMs + 100,
  monotonicElapsedMs: 100,
  databaseTime,
};

function check(input: unknown, reason: ControlClockSampleReason) {
  expect(validateControlClockSample(input)).toEqual({
    valid: reason === "valid",
    reason,
  });
}

describe("pure control clock sample quality, never proof authority", () => {
  it("exports fixed candidate limits", () => {
    expect(CONTROL_MAX_SKEW_MS).toBe(5000);
    expect(CONTROL_MAX_SAMPLE_MS).toBe(250);
    expect(CONTROL_MAX_CLOCK_JUMP_MS).toBe(25);
  });

  it("accepts a bounded bracket without reading or replacing any clock", () => {
    check(sample, "valid");
  });

  it("returns only frozen static decisions without echoed inputs", () => {
    const decision = validateControlClockSample(sample);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.keys(decision).sort()).toEqual(["reason", "valid"]);
  });

  const boundaries: [
    string,
    number,
    number,
    number,
    ControlClockSampleReason,
  ][] = [
    ["zero interval", 0, 0, 0, "valid"],
    ["positive skew inclusive", 5000, 5000, 0, "valid"],
    ["negative skew inclusive", -5000, -5000, 0, "valid"],
    ["positive skew exceeded", 5001, 5001, 0, "skew"],
    ["negative skew exceeded", -5001, -5001, 0, "skew"],
    ["whole positive bracket fits", 4750, 5000, 250, "valid"],
    ["whole negative bracket fits", -5000, -4750, 250, "valid"],
    ["midpoint fits but upper endpoint fails", 4900, 5100, 200, "skew"],
    ["midpoint fits but lower endpoint fails", -5100, -4900, 200, "skew"],
    ["RTT maximum inclusive", 0, 250, 250, "valid"],
    ["RTT width exceeded", 0, 251, 250, "uncertain"],
    ["monotonic maximum exceeded", 0, 250, 250.001, "uncertain"],
    ["forward jump tolerance inclusive", 0, 100, 75, "valid"],
    ["slow wall tolerance inclusive", 0, 100, 125, "valid"],
    ["forward jump beyond tolerance", 0, 100, 74.999, "clock-jump"],
    ["slow wall beyond tolerance", 0, 100, 125.001, "clock-jump"],
    ["fractional monotonic measurement", 0, 100, 100.125, "valid"],
    ["backward wall despite small discrepancy", 1, 0, 0, "clock-jump"],
    ["stopped wall cannot hide elapsed time", 0, 0, 26, "clock-jump"],
    ["wall advances while monotonic does not", 0, 26, 0, "clock-jump"],
  ];
  it.each(boundaries)("%s", (_label, before, after, elapsed, reason) => {
    check(
      {
        nodeBeforeMs: databaseMs + before,
        nodeAfterMs: databaseMs + after,
        monotonicElapsedMs: elapsed,
        databaseTime,
      },
      reason,
    );
  });

  const malformedValues: unknown[] = [
    undefined,
    null,
    "100",
    true,
    {},
    [],
    NaN,
    Infinity,
    -Infinity,
    -1,
  ];
  for (const field of ["nodeBeforeMs", "nodeAfterMs"] as const) {
    it.each(malformedValues.map((value, index) => [index, value] as const))(
      `rejects malformed ${field} case %s`,
      (_index, value) => check({ ...sample, [field]: value }, "malformed"),
    );
    it(`rejects fractional or out-of-range ${field}`, () => {
      check({ ...sample, [field]: databaseMs + 0.5 }, "malformed");
      check({ ...sample, [field]: Number.MAX_SAFE_INTEGER + 1 }, "malformed");
      check({ ...sample, [field]: 8640000000000001 }, "malformed");
    });
  }
  it.each(malformedValues.map((value, index) => [index, value] as const))(
    "rejects malformed monotonic case %s",
    (_index, value) =>
      check({ ...sample, monotonicElapsedMs: value }, "malformed"),
  );

  const malformedDatabaseTimes: unknown[] = [
    undefined,
    null,
    databaseMs,
    new Date(databaseTime),
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.000+00:00",
    "2026-01-01T00:00:00.000z",
    "2026-01-01T00:00:00.0000Z",
    "2026-02-30T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z",
    "2026-01-01T24:00:00.000Z",
    "2026-01-01T00:00:60.000Z",
    "1969-12-31T23:59:59.999Z",
    " 2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z\n",
    "+010000-01-01T00:00:00.000Z",
  ];
  it.each(
    malformedDatabaseTimes.map((value, index) => [index, value] as const),
  )("rejects malformed database timestamp case %s", (_index, value) =>
    check({ ...sample, databaseTime: value }, "malformed"),
  );

  it.each([undefined, null, true, 1, "sample", [], () => sample])(
    "rejects non-record input %#",
    (input) => check(input, "malformed"),
  );

  it("requires exactly the declared own fields", () => {
    const missing = { ...sample } as Partial<typeof sample>;
    delete missing.databaseTime;
    check(missing, "malformed");
    check({ ...sample, maxSkewMs: 999999 }, "malformed");
    check({ ...sample, [Symbol("extra")]: true }, "malformed");
    const hidden = { ...sample };
    Object.defineProperty(hidden, "extra", { value: true });
    check(hidden, "malformed");
  });

  it("accepts a null-prototype record with exact data properties", () => {
    check(Object.assign(Object.create(null), sample), "valid");
  });

  it("rejects inherited fields and custom prototypes", () => {
    check(Object.create(sample), "malformed");
    check(
      Object.assign(Object.create({ inherited: true }), sample),
      "malformed",
    );
  });

  it("does not invoke getters or coercion methods", () => {
    let calls = 0;
    const accessor = { ...sample };
    Object.defineProperty(accessor, "databaseTime", {
      enumerable: true,
      get() {
        calls++;
        throw new Error("must not execute");
      },
    });
    check(accessor, "malformed");
    const coercible = {
      valueOf() {
        calls++;
        return databaseMs;
      },
      toString() {
        calls++;
        return databaseTime;
      },
    };
    check({ ...sample, nodeBeforeMs: coercible }, "malformed");
    check({ ...sample, databaseTime: coercible }, "malformed");
    expect(calls).toBe(0);
  });

  it("rejects hostile prototype, key and descriptor proxy traps without leaking", () => {
    const proxies = [
      new Proxy(sample, {
        getPrototypeOf() {
          throw new Error("private detail");
        },
      }),
      new Proxy(sample, {
        ownKeys() {
          throw new Error("private detail");
        },
      }),
      new Proxy(sample, {
        getOwnPropertyDescriptor() {
          throw new Error("private detail");
        },
      }),
    ];
    for (const proxy of proxies) check(proxy, "malformed");
    const revoked = Proxy.revocable(sample, {});
    revoked.revoke();
    check(revoked.proxy, "malformed");
  });
});
