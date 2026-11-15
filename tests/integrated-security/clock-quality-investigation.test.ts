import { spawn } from "node:child_process";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdmissionAuthority } from "../../src/server/security/admission-authority";
import { validateControlClockSample } from "../../src/server/security/control-clock";
import { ControlFixtures, secretSafe } from "../admission-controls/fixtures";

// Additional evidence only. Original179 cases and all guards stay unchanged.
const fx = new ControlFixtures();
const prefix = "BookStore clock quality diagnostic ";
const records: Record<string, unknown>[] = [];
let spy: ReturnType<typeof vi.spyOn>;
const priorFlag = process.env.BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS;
function collect(value: unknown) {
  if (typeof value !== "string" || !value.startsWith(prefix)) return;
  const parsed: unknown = JSON.parse(value.slice(prefix.length));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Clock diagnostic schema unavailable.");
  records.push(parsed as Record<string, unknown>);
}
beforeAll(() =>
  secretSafe(async () => {
    process.env.BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS = "1";
    const original = console.info;
    spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      for (const value of args) collect(value);
      original(...args);
    });
    await fx.start();
  }),
);
afterAll(() =>
  secretSafe(async () => {
    await fx.stop();
    spy?.mockRestore();
    if (priorFlag === undefined)
      delete process.env.BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS;
    else process.env.BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS = priorFlag;
  }),
);
const configuration = () => ({
  verifierUrl: fx.owned.verifierUrl,
  staffUrl: fx.owned.staffUrl,
});
const scenario = (name: string, run: () => Promise<void>) =>
  it(name, () => secretSafe(run));
async function bothWaiting(): Promise<boolean> {
  const roles = [
    new URL(fx.owned.verifierUrl).username,
    new URL(fx.owned.staffUrl).username,
  ];
  const result = await fx.migration.query<{ waiting: number }>(
    `SELECT count(DISTINCT a.usename)::integer waiting
    FROM pg_stat_activity a WHERE a.datname=current_database() AND a.usename=ANY($1::text[])
    AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)
    AND cardinality(pg_blocking_pids(a.pid))>0`,
    [roles],
  );
  return result.rows[0]?.waiting === 2;
}
async function observedBothWaiting() {
  const deadline = performance.now() + 5000;
  let next = performance.now();
  for (let queries = 0; queries < 2000 && performance.now() < deadline;) {
    if (performance.now() >= next) {
      queries++;
      if (await bothWaiting()) return true;
      next = performance.now() + 2;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return false;
}
async function slowProbe(
  mode: "database-hold" | "database-hold-plus-event-loop-load",
) {
  const blocker = await fx.client(fx.owned.migrationUrl);
  const beginRecords = records.length;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  let transaction = false;
  let pending:
    Promise<{ unavailable: boolean; initialized: boolean }> | undefined;
  try {
    await blocker.query("BEGIN");
    transaction = true;
    await blocker.query(
      "SELECT singleton FROM staff.governance WHERE singleton=true FOR UPDATE",
    );
    histogram.enable();
    pending = createAdmissionAuthority(configuration()).then(
      async (authority) => {
        await authority.close();
        return { initialized: true, unavailable: false };
      },
      (error: unknown) => ({
        initialized: false,
        unavailable:
          error instanceof Error && error.message === "metadataUnavailable",
      }),
    );
    expect(await observedBothWaiting()).toBe(true);
    const heldAt = performance.now();
    if (mode === "database-hold") {
      // Deliberate single bounded fixture hold, NOT an auth retry or timeout increase.
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
    } else {
      // Combined DB+Node load arm: do NOT call this a pure SQL or pure CPU isolate.
      while (performance.now() - heldAt < 350) {
        /* bounded resource load */
      }
    }
    await blocker.query("ROLLBACK");
    transaction = false;
    const outcome = await pending;
    expect(outcome).toEqual({ initialized: false, unavailable: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const samples = records
      .slice(beginRecords)
      .filter((r) => r.phase === "initialization");
    expect(samples.length).toBe(2);
    expect(
      samples.every(
        (r) =>
          r.reason === "uncertain" &&
          r.wallExceeded === true &&
          r.monoExceeded === true,
      ),
    ).toBe(true);
    expect(new Set(samples.map((r) => r.role)).size).toBe(2);
    expect(new Set(samples.map((r) => r.group)).size).toBe(1);
    console.info(
      JSON.stringify({
        diagnostic: "clock-quality-controlled-arm",
        mode,
        bothRolesObservedWaiting: true,
        initialized: outcome.initialized,
        unavailable: outcome.unavailable,
        roleSamples: samples.length,
        eventLoopDelayMaxMs: Math.min(
          60000,
          Math.round(Number(histogram.max) / 1e6),
        ),
        eventLoopDelayObserved: histogram.count > 0,
      }),
    );
  } finally {
    histogram.disable();
    if (transaction) await blocker.query("ROLLBACK");
    await pending;
    // fx owns this client and its exact disposal map; no unrelated termination.
  }
}

describe("B2e clock-quality controlled evidence, no timing policy change", () => {
  scenario(
    "fresh purpose pools and established serial role use retain both metadata and clock checks",
    async () => {
      const before = records.length;
      const authority = await createAdmissionAuthority(configuration());
      try {
        const initialized = records
          .slice(before)
          .filter((r) => r.phase === "initialization");
        expect(initialized.length).toBe(2);
        expect(
          initialized.every(
            (r) =>
              r.reason === "valid" &&
              r.wallExceeded === false &&
              r.monoExceeded === false,
          ),
        ).toBe(true);
        expect(
          initialized.every(
            (r) => r.poolTotalBefore === 0 && r.poolIdleBefore === 0,
          ),
        ).toBe(true);
        // Nonexistent fixed identifiers are NOT caller-supplied positive identity.
        const warmStart = records.length;
        const denied = await authority.checkAccess(
          "diagnostic_absent_user",
          "diagnostic_absent_session",
        );
        expect(denied.allowed).toBe(false);
        const warm = records
          .slice(warmStart)
          .filter((r) => r.role === "staff" && r.phase === "operation");
        expect(warm.length).toBe(1);
        expect(
          warm.every(
            (r) =>
              r.reason === "valid" &&
              r.poolTotalBefore === 1 &&
              r.poolIdleBefore === 1,
          ),
        ).toBe(true);
        // Fresh role constructor success is not MFA/admission proof.
        console.info(
          JSON.stringify({
            diagnostic: "clock-quality-cold-pool-baseline",
            roleSamples: initialized.length,
            initialized: true,
            absentActorDenied: true,
          }),
        );
      } finally {
        await authority.close();
      }
    },
  );
  scenario(
    "real governance wait exceeding250ms rejects BOTH purpose samples with no returned authority",
    () => slowProbe("database-hold"),
  );
  scenario(
    "representative combined governance wait and bounded event-loop load remains fail-closed",
    () => slowProbe("database-hold-plus-event-loop-load"),
  );
  scenario(
    "genuine cold Node process validates both roles and drains naturally without runtime bootstrap",
    async () => {
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS: "1",
        BOOKSTORE_CLOCK_INVESTIGATION_CONFIG: JSON.stringify(configuration()),
      };
      for (const key of [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "APPDATA",
        "LOCALAPPDATA",
      ])
        if (process.env[key]) env[key] = process.env[key];
      const child = spawn(
        process.execPath,
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          fileURLToPath(new URL("./clock-quality-worker.ts", import.meta.url)),
        ],
        { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "ignore", "ipc"] },
      );
      let data = "",
        oversized = false;
      let packet: unknown;
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (data.length + chunk.length <= 65536) data += chunk;
        else oversized = true;
      });
      child.on("message", (message: unknown) => {
        packet = message;
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const exit = new Promise<number | null>((resolve, reject) => {
          child.once("exit", resolve);
          child.once("error", () =>
            reject(new Error("Clock child unavailable.")),
          );
        });
        const drained = new Promise<void>((resolve) => {
          child.stdout?.once("end", resolve);
        });
        const result = await Promise.race([
          Promise.all([exit, drained]),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Clock child lifetime unavailable.")),
              45000,
            );
          }),
        ]);
        expect(result[0]).toBe(0);
        expect(child.connected).toBe(false);
        expect(oversized).toBe(false);
        expect(packet).toEqual({
          v: 1,
          operation: "security.clock-quality-cold",
          initialized: true,
          closed: true,
          unavailable: false,
        });
        const childRecords = data
          .split(/\r?\n/)
          .filter((line) => line.startsWith(prefix))
          .map(
            (line) =>
              JSON.parse(line.slice(prefix.length)) as Record<string, unknown>,
          );
        expect(childRecords.length).toBe(2);
        expect(
          childRecords.every(
            (r) =>
              r.reason === "valid" &&
              r.poolTotalBefore === 0 &&
              r.poolIdleBefore === 0,
          ),
        ).toBe(true);
        // Print only the verified fixed scalar diagnostic shape, NEVER raw stdout.
        const allowedKeys = Object.keys(records[0] ?? {}).sort();
        for (const sample of childRecords) {
          expect(Object.keys(sample).sort()).toEqual(allowedKeys);
          expect(
            Object.entries(sample).every(([key, value]) => {
              if (key === "capped" || key === "invalid")
                return (
                  value !== null &&
                  typeof value === "object" &&
                  Object.values(value).every((v) => typeof v === "boolean")
                );
              if (["role", "phase", "reason"].includes(key))
                return [
                  "staff",
                  "verifier",
                  "initialization",
                  "valid",
                ].includes(String(value));
              return (
                typeof value === "boolean" ||
                (typeof value === "number" &&
                  Number.isFinite(value) &&
                  Math.abs(value) <=
                    (key === "group" ? Number.MAX_SAFE_INTEGER : 60000))
              );
            }),
          ).toBe(true);
          console.info(
            JSON.stringify({
              diagnostic: "clock-quality-cold-process-sample",
              sample,
            }),
          );
        }
        console.info(
          JSON.stringify({
            diagnostic: "clock-quality-cold-process",
            initialized: true,
            closed: true,
            naturalExit: true,
            stdoutDrained: true,
            roleSamples: childRecords.length,
          }),
        );
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill(); // failure cleanup only; never success evidence
      }
    },
  );
  scenario(
    "unavailable purpose connection never returns an authority or diagnostic secrets",
    async () => {
      const bad = new URL(fx.owned.staffUrl);
      bad.password = "synthetic-unavailable-purpose-credential";
      let returned = false;
      let unavailable = false;
      try {
        const authority = await createAdmissionAuthority({
          verifierUrl: fx.owned.verifierUrl,
          staffUrl: bad.toString(),
        });
        returned = true;
        await authority.close();
      } catch (error) {
        unavailable =
          error instanceof Error && error.message === "metadataUnavailable";
      }
      expect(returned).toBe(false);
      expect(unavailable).toBe(true);
      const encoded = JSON.stringify(records);
      expect(
        [
          fx.owned.staffUrl,
          fx.owned.verifierUrl,
          fx.config.secret,
          bad.toString(),
          "synthetic-unavailable-purpose-credential",
        ].every((secret) => !encoded.includes(secret)),
      ).toBe(true);
      expect(
        !/"(?:nodeBeforeMs|nodeAfterMs|databaseTime|userId|sessionId|secret|token|cookie|url)"/.test(
          encoded,
        ),
      ).toBe(true);
    },
  );
  scenario(
    "exact wall and monotonic boundary classification is independent and includes conservative precision padding",
    async () => {
      const db = "2026-01-01T00:00:00.000Z",
        epoch = Date.parse(db);
      const cases: [number, number, number, string][] = [
        [250, 250, 0, "valid"],
        [251, 250, 0, "uncertain"],
        [250, 250.001, 0, "uncertain"],
        [251, 251, 0, "uncertain"],
        [248, 248, 1, "valid"],
        [249, 249, 1, "uncertain"],
      ];
      for (const [width, elapsed, pad, expected] of cases)
        expect(
          validateControlClockSample({
            nodeBeforeMs: epoch - pad,
            nodeAfterMs: epoch + width + pad,
            monotonicElapsedMs: elapsed,
            databaseTime: db,
          }).reason,
        ).toBe(expected);
    },
  );
});
