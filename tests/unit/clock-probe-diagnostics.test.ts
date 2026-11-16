import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { ClockProbeDiagnostic } from "../../src/server/security/clock-probe-diagnostics";
const prefix = "BookStore clock quality diagnostic ";
const input: ClockProbeDiagnostic = {
  group: 1,
  role: "staff",
  phase: "initialization",
  reason: "valid",
  rawWallSpanMs: 10,
  adjustedWallSpanMs: 12,
  precisionPadMs: 1,
  monoElapsedMs: 10,
  queryAwaitMs: 10,
  acquireAwaitMs: 20,
  metadataAwaitMs: 30,
  relativeInitMs: 0,
  relativeProbeMs: 50,
  eventLoopActiveMs: 2,
  eventLoopIdleMs: 8,
  wallExceeded: false,
  monoExceeded: false,
  overlap: false,
  poolTotalBefore: 0,
  poolIdleBefore: 0,
  poolWaitingBefore: 0,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});
async function enabled() {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS", "1");
  return import("../../src/server/security/clock-probe-diagnostics");
}
describe("non-authorizing bounded clock diagnostic projection", () => {
  it("is disabled without BOTH explicit isolated test conditions", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS", "1");
    const helper =
      await import("../../src/server/security/clock-probe-diagnostics");
    expect(helper.createClockDiagnosticGroup()).toBe(0);
    helper.logClockProbeDiagnostic(input);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS", "0");
    expect(helper.createClockDiagnosticGroup()).toBe(0);
    helper.logClockProbeDiagnostic(input);
    expect(info).not.toHaveBeenCalled();
  });
  it("drops foreign secret/identity/time fields and returns no decision", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const helper = await enabled();
    const extra = {
      ...input,
      token: "synthetic-secret-sentinel",
      userId: "synthetic-identity-sentinel",
      databaseTime: "2026-01-01T00:00:00.000Z",
    };
    expect(helper.logClockProbeDiagnostic(extra)).toBeUndefined();
    const line = String(info.mock.calls[0]?.[0]);
    expect(line.startsWith(prefix)).toBe(true);
    expect(!line.includes("synthetic-") && !line.includes("2026-")).toBe(true);
    const record = JSON.parse(line.slice(prefix.length)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(record).sort()).toEqual(
      [...Object.keys(input), "capped", "invalid"].sort(),
    );
    expect(
      !Object.keys(record).some((key) =>
        /token|userId|databaseTime|nodeBefore|nodeAfter/.test(key),
      ),
    ).toBe(true);
  });
  it("caps and flags malformed durations without obscuring exact exceeded booleans", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const helper = await enabled();
    helper.logClockProbeDiagnostic({
      ...input,
      rawWallSpanMs: -70000,
      adjustedWallSpanMs: 70000,
      monoElapsedMs: 250.0001,
      queryAwaitMs: Infinity,
      acquireAwaitMs: NaN,
      poolTotalBefore: 10000,
      wallExceeded: true,
      monoExceeded: true,
    });
    const r = JSON.parse(String(info.mock.calls[0]?.[0]).slice(prefix.length));
    expect(r.rawWallSpanMs).toBe(-60000);
    expect(r.adjustedWallSpanMs).toBe(60000);
    expect(
      r.capped.rawWallSpanMs &&
        r.capped.adjustedWallSpanMs &&
        r.capped.poolTotalBefore,
    ).toBe(true);
    expect(r.invalid.queryAwaitMs && r.invalid.acquireAwaitMs).toBe(true);
    expect(
      r.queryAwaitMs === 0 &&
        r.acquireAwaitMs === 0 &&
        r.poolTotalBefore === 512,
    ).toBe(true);
    expect(r.monoElapsedMs).toBe(250);
    expect(r.wallExceeded && r.monoExceeded).toBe(true);
  });
  it("hard bounds total records and contains logger failures", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const helper = await enabled();
    for (let i = 0; i < 520; i++) helper.logClockProbeDiagnostic(input);
    expect(info.mock.calls.length).toBe(512);
    expect(helper.createClockDiagnosticGroup()).toBe(0);
    vi.resetModules();
    const fresh =
      await import("../../src/server/security/clock-probe-diagnostics");
    info.mockImplementation(() => {
      throw new Error("synthetic-log-failure");
    });
    expect(() => fresh.logClockProbeDiagnostic(input)).not.toThrow();
  });
});
