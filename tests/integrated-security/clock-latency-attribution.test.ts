import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlFixtures, secretSafe } from "../admission-controls/fixtures";

type Role = "verifier" | "staff";
type Mode = "idle" | "node-only" | "db-only" | "combined";
type Sample = {
  rawWallSpanMs: number;
  adjustedWallSpanMs: number;
  monoElapsedMs: number;
  precisionPadMs: number;
  wallExceeded: boolean;
  monoExceeded: boolean;
  quality: string;
};
type Summary = {
  v: 1;
  operation: "result";
  role: Role;
  mode: Mode;
  ok: boolean;
  closed: boolean;
  submissionObserved: false;
  readySignal: "public-query-end";
  readyObserved: boolean;
  autocommitIdleAtEnd: boolean;
  connectMs: number;
  preflightMs: number;
  queryApiMs: number;
  callToRowMs: number;
  callToCallbackMs: number;
  callToEndMs: number;
  callToContinuationMs: number;
  endToContinuationMs: number;
  settledToContinuationMs: number;
  rowCount: number;
  callbackBeforeEnd: boolean;
  endBeforeContinuation: boolean;
  apiReturnBeforeRow: boolean;
  busyRan: boolean;
  control: Sample;
  actual: Sample;
  capped: boolean;
};
const fx = new ControlFixtures();
const path = new URL("./clock-latency-worker.mjs", import.meta.url);
const modes: Mode[] = ["idle", "db-only", "node-only", "combined"];
const roles: Role[] = ["verifier", "staff"];
const qualities = ["valid", "malformed", "clock-jump", "uncertain", "skew"];
let governanceOid = 0;
beforeAll(() =>
  secretSafe(async () => {
    await fx.start();
    // Resolve owned schema metadata with the existing migrator; VERIFIER has no
    // staff schema USAGE. Pass only a private OID to public pg_locks, no new grant.
    const object = await fx.migration.query<{ oid: number }>(
      "SELECT 'staff.governance'::regclass::oid::integer oid",
    );
    governanceOid = object.rows[0]?.oid;
    expect(Number.isSafeInteger(governanceOid) && governanceOid > 0).toBe(true);
  }),
);
afterAll(() => secretSafe(() => fx.stop()));
const scenario = (name: string, run: () => Promise<void>) =>
  it(name, () => secretSafe(run));
function validSample(value: unknown): value is Sample {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Object.keys(r).sort().join(",") ===
      "adjustedWallSpanMs,monoElapsedMs,monoExceeded,precisionPadMs,quality,rawWallSpanMs,wallExceeded" &&
    [
      r.rawWallSpanMs,
      r.adjustedWallSpanMs,
      r.monoElapsedMs,
      r.precisionPadMs,
    ].every(
      (n) =>
        typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 60000,
    ) &&
    typeof r.wallExceeded === "boolean" &&
    typeof r.monoExceeded === "boolean" &&
    qualities.includes(String(r.quality))
  );
}
function validSummary(value: unknown): value is Summary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const strings: Record<string, readonly string[]> = {
    operation: ["result"],
    role: roles,
    mode: modes,
    readySignal: ["public-query-end"],
  };
  const numbers = [
    "connectMs",
    "preflightMs",
    "queryApiMs",
    "callToRowMs",
    "callToCallbackMs",
    "callToEndMs",
    "callToContinuationMs",
    "endToContinuationMs",
    "settledToContinuationMs",
    "rowCount",
  ];
  const bools = [
    "ok",
    "closed",
    "submissionObserved",
    "readyObserved",
    "autocommitIdleAtEnd",
    "callbackBeforeEnd",
    "endBeforeContinuation",
    "apiReturnBeforeRow",
    "busyRan",
    "capped",
  ];
  const expected = [
    "v",
    ...Object.keys(strings),
    ...numbers,
    ...bools,
    "control",
    "actual",
  ].sort();
  return (
    Object.keys(r).sort().join(",") === expected.join(",") &&
    r.v === 1 &&
    Object.entries(strings).every(([key, allowed]) =>
      allowed.includes(String(r[key])),
    ) &&
    numbers.every(
      (key) =>
        typeof r[key] === "number" &&
        Number.isFinite(r[key]) &&
        (r[key] as number) >= 0 &&
        (r[key] as number) <= 60000,
    ) &&
    bools.every((key) => typeof r[key] === "boolean") &&
    validSample(r.control) &&
    validSample(r.actual)
  );
}
function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
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
  // No bootstrap/Migrate/AUTH/other-purpose URLs or NODE_OPTIONS inheritance.
  return env;
}
function thread(role: Role, mode: Mode) {
  const shared = new SharedArrayBuffer(32),
    view = new Int32Array(shared);
  const target = new Worker(path, {
    execArgv: [],
    env: minimalEnvironment(),
    workerData: {
      v: 1,
      url: fx.owned[role === "verifier" ? "verifierUrl" : "staffUrl"],
      role,
      mode,
      shared,
    },
  });
  const stored = new Map<string, unknown>(),
    waiters = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
  let failed = false;
  const fail = () => {
    failed = true;
    for (const w of waiters.values())
      w.reject(new Error("Clock attribution worker unavailable."));
  };
  target.on("error", fail);
  target.on("message", (packet: unknown) => {
    if (!packet || typeof packet !== "object" || Array.isArray(packet))
      return fail();
    const m = packet as Record<string, unknown>;
    if (
      m.v !== 1 ||
      !["ready", "query-called", "busy-start", "result"].includes(
        String(m.operation),
      ) ||
      m.role !== role ||
      m.mode !== mode
    )
      return fail();
    const op = String(m.operation);
    if (stored.has(op)) return fail();
    stored.set(op, packet);
    waiters.get(op)?.resolve(packet);
  });
  const wait = (op: string): Promise<unknown> => {
    if (failed)
      return Promise.reject(new Error("Clock attribution worker unavailable."));
    if (stored.has(op)) return Promise.resolve(stored.get(op));
    return new Promise((resolve, reject) =>
      waiters.set(op, { resolve, reject }),
    );
  };
  const exit = new Promise<number>((resolve, reject) => {
    target.once("exit", resolve);
    target.once("error", () =>
      reject(new Error("Clock attribution exit unavailable.")),
    );
  });
  // Every timer and worker is owned by this one predetermined observation.
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Clock attribution lifetime unavailable.")),
      45000,
    );
  });
  // Attach rejection handling immediately; no detached/unhandled deadline rejection.
  void deadline.catch(() => {});
  void exit.catch(() => {});
  return {
    target,
    view,
    wait,
    exit,
    deadline,
    async close() {
      clearTimeout(timeout);
      if (target.threadId !== -1) await target.terminate();
    },
  };
}
async function observe(role: Role, pid: number) {
  // Same-purpose observer can see its own role's activity; no read-all-stats grant.
  const result = await fx[role].query<{
    visible: boolean;
    idle: boolean;
    waiting: boolean;
    blocked: boolean;
    governanceLock: boolean;
  }>(
    `SELECT
    EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.pid=$1 AND a.datname=current_database() AND a.usename=current_user) visible,
    EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.pid=$1 AND a.datname=current_database() AND a.usename=current_user AND a.state='idle') idle,
    EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=$1 AND NOT l.granted) waiting,
    cardinality(pg_blocking_pids($1))>0 blocked,
    EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=$1 AND l.relation=$2::oid) AS "governanceLock"`,
    [pid, governanceOid],
  );
  const row = result.rows[0];
  if (!row || Object.values(row).some((v) => typeof v !== "boolean"))
    throw new Error("Clock attribution observer unavailable.");
  return row;
}
async function teardown(
  subject: ReturnType<typeof thread>,
  blocker: typeof fx.migration | undefined,
  held: boolean,
) {
  try {
    if (held) await blocker?.query("ROLLBACK");
  } finally {
    await subject.close();
  }
}
async function run(role: Role, mode: Mode) {
  const subject = thread(role, mode);
  let blocker: typeof fx.migration | undefined;
  let held = false;
  const observations = {
    planned: mode === "node-only" || mode === "combined" ? 12 : 3,
    completed: 0,
    visible: 0,
    waiting: 0,
    blocked: 0,
    duringBusy: 0,
    duringBusyIdle: 0,
    duringBusyNoBlocker: 0,
    duringBusyNoGovernanceLock: 0,
  };
  try {
    if (mode === "db-only" || mode === "combined")
      blocker = await fx.client(fx.owned.migrationUrl);
    if (blocker) {
      await blocker.query("BEGIN");
      held = true;
      await blocker.query(
        "SELECT singleton FROM staff.governance WHERE singleton=true FOR UPDATE",
      );
    }
    await Promise.race([subject.wait("ready"), subject.deadline]);
    const pid = Atomics.load(subject.view, 0);
    expect(pid > 0).toBe(true);
    expect(Atomics.load(subject.view, 4) === 1).toBe(true);
    subject.target.postMessage({ v: 1, operation: "run" });
    await Promise.race([subject.wait("query-called"), subject.deadline]);
    if (blocker) {
      // EXACT three planned observations; no poll-until-witness/retry loop.
      for (let i = 0; i < 3; i++) {
        const r = await observe(role, pid);
        observations.completed++;
        observations.visible += Number(r.visible);
        observations.waiting += Number(r.waiting);
        observations.blocked += Number(r.blocked);
      }
      expect(observations.waiting > 0 && observations.blocked > 0).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      await blocker.query("ROLLBACK");
      held = false;
    }
    if (mode === "node-only" || mode === "combined") {
      await Promise.race([subject.wait("busy-start"), subject.deadline]);
      const duringCount = mode === "combined" ? 9 : 12; // combined:3pre-wait +9during =12total
      for (let i = 0; i < duringCount; i++) {
        const before = Atomics.load(subject.view, 1) === 1;
        const r = await observe(role, pid);
        const during = before && Atomics.load(subject.view, 1) === 1;
        observations.completed++;
        observations.visible += Number(r.visible);
        if (during) {
          observations.duringBusy++;
          observations.duringBusyIdle += Number(r.idle);
          observations.duringBusyNoBlocker += Number(!r.waiting && !r.blocked);
          observations.duringBusyNoGovernanceLock += Number(!r.governanceLock);
        }
        if (i < duringCount - 1)
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(observations.duringBusy > 0).toBe(true);
      expect(
        observations.duringBusyIdle === observations.duringBusy &&
          observations.duringBusyNoBlocker === observations.duringBusy &&
          observations.duringBusyNoGovernanceLock === observations.duringBusy,
      ).toBe(true);
    } else if (!blocker) {
      for (let i = 0; i < 3; i++) {
        const r = await observe(role, pid);
        observations.completed++;
        observations.visible += Number(r.visible);
      }
    }
    const packet = await Promise.race([
      subject.wait("result"),
      subject.deadline,
    ]);
    expect(validSummary(packet)).toBe(true);
    if (!validSummary(packet))
      throw new Error("Clock attribution result unavailable.");
    const naturalExit = await Promise.race([subject.exit, subject.deadline]);
    expect(
      naturalExit === 0 &&
        packet.ok &&
        packet.closed &&
        Atomics.load(subject.view, 2) === 1,
    ).toBe(true);
    expect(
      packet.submissionObserved === false &&
        packet.readyObserved &&
        packet.autocommitIdleAtEnd &&
        packet.rowCount === 1 &&
        packet.callbackBeforeEnd &&
        packet.endBeforeContinuation &&
        !packet.capped,
    ).toBe(true);
    if (mode === "node-only") {
      expect(
        packet.control.quality === "valid" &&
          packet.actual.quality === "uncertain" &&
          packet.actual.wallExceeded &&
          packet.actual.monoExceeded &&
          packet.endToContinuationMs >= 350 &&
          packet.settledToContinuationMs >= 350,
      ).toBe(true);
    } else if (mode === "idle") expect(packet.actual.quality).toBe("valid");
    else
      expect(
        packet.actual.quality === "uncertain" &&
          packet.actual.wallExceeded &&
          packet.actual.monoExceeded,
      ).toBe(true);
    // Fixed validated projection only: never raw worker messages, rows, IDs or times.
    console.info(
      JSON.stringify({
        diagnostic: "clock-latency-attribution",
        harnessProjection: true,
        actualAuthorityOutcomeObserved: false,
        role,
        mode,
        observations,
        sample: packet,
      }),
    );
  } finally {
    // A failed blocker connection must not retain the independent worker/timer.
    await teardown(subject, blocker, held);
  }
}

describe("supported public-query clock latency attribution, fixed matrix", () => {
  scenario(
    "failure-only worker cleanup still completes when the owned blocker connection is closed",
    async () => {
      const subject = thread("verifier", "idle");
      const blocker = new Client({
        connectionString: fx.owned.migrationUrl,
        options: "-c application_name=bookstore-clock-cleanup-test",
        connectionTimeoutMillis: 3000,
        statement_timeout: 5000,
      });
      let rejected = false;
      try {
        await blocker.connect();
        await blocker.query("BEGIN");
        await Promise.race([subject.wait("ready"), subject.deadline]);
        await blocker.end(); // ONLY this newly created fixture connection; no termination API.
        try {
          await teardown(subject, blocker, true);
        } catch {
          rejected = true;
        }
        expect(rejected && subject.target.threadId === -1).toBe(true);
        console.info(
          JSON.stringify({
            diagnostic: "clock-attribution-failure-cleanup",
            rollbackUnavailable: true,
            workerTerminated: true,
            authenticationAttempted: false,
          }),
        );
      } finally {
        await subject.close();
        await blocker.end();
      }
    },
  );
  for (const mode of modes)
    for (const role of roles)
      scenario(
        `${mode} / ${role}: one fixed probe, bounded independent observations`,
        () => run(role, mode),
      );
  scenario(
    "fresh process and cold connection: one verifier public-query observation",
    async () => {
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        BOOKSTORE_CLOCK_LATENCY_CONFIG: JSON.stringify({
          v: 1,
          url: fx.owned.verifierUrl,
          role: "verifier",
          mode: "idle",
        }),
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
      const child = spawn(process.execPath, [fileURLToPath(path)], {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let ready = false,
        packet: unknown,
        unexpected = false;
      const received = new Promise<void>((resolve, reject) => {
        child.on("error", () =>
          reject(new Error("Cold clock attribution unavailable.")),
        );
        child.on("message", (message: unknown) => {
          if (
            !message ||
            typeof message !== "object" ||
            Array.isArray(message)
          ) {
            unexpected = true;
            return;
          }
          const r = message as Record<string, unknown>;
          if (r.operation === "ready" && !ready) {
            ready = true;
            child.send({ v: 1, operation: "run" });
          } else if (r.operation === "result") {
            packet = message;
            resolve();
          } else if (r.operation === "error")
            reject(new Error("Cold clock attribution collection failed."));
          else if (r.operation !== "query-called") unexpected = true;
        });
      });
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([received, exited]),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error("Cold clock attribution lifetime unavailable."),
                ),
              45000,
            );
          }),
        ]);
        expect(
          !unexpected &&
            ready &&
            validSummary(packet) &&
            child.exitCode === 0 &&
            !child.connected,
        ).toBe(true);
        if (!validSummary(packet))
          throw new Error("Cold clock attribution result unavailable.");
        expect(
          packet.ok &&
            packet.closed &&
            packet.actual.quality === "valid" &&
            packet.submissionObserved === false,
        ).toBe(true);
        console.info(
          JSON.stringify({
            diagnostic: "clock-latency-cold-process",
            harnessProjection: true,
            sample: packet,
          }),
        );
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill();
      }
    },
  );
});
