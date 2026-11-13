import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { Client } from "pg";
import { assertFoundationBaseUrl } from "../../src/server/security/database-config";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  createReconciliationWorker,
  type ReconciliationResult,
  type ReconciliationWorker,
} from "../../src/server/security/reconciliation-worker";
import { ControlFixtures } from "../admission-controls/fixtures";
import { createWorkerProcess, type WorkerProcess } from "./worker-client";

const fx = new ControlFixtures();
const workers = new Set<ReconciliationWorker>();
const children = new Set<WorkerProcess>();
async function worker() {
  const value = await createReconciliationWorker({
    workerUrl: fx.owned.workerUrl,
  });
  workers.add(value);
  return value;
}
async function child() {
  const value = await createWorkerProcess(fx.owned.workerUrl);
  children.add(value);
  return value;
}
function safeResult(result: ReconciliationResult): boolean {
  return (
    Object.keys(result).length === 7 &&
    ["completed", "partial", "unavailable", "deadline", "busy"].includes(
      result.status,
    ) &&
    Object.entries(result).every(
      ([name, value]) =>
        name === "status" ||
        (typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= 20),
    ) &&
    result.applied + result.skipped <= result.selected
  );
}
async function sessions(userId: string, count: number) {
  for (let index = 0; index < count; index++) {
    const id = randomUUID();
    await fx.auth.query(
      'INSERT INTO identity."Session" (id,token,"userId","expiresAt","updatedAt") VALUES ($1,$2,$3,clock_timestamp()+interval \'1 hour\',clock_timestamp())',
      [id, randomUUID(), userId],
    );
  }
}
async function changed(userId: string) {
  await fx.auth.query('UPDATE identity."User" SET email=$2 WHERE id=$1', [
    userId,
    `${randomUUID()}@example.invalid`,
  ]);
}
async function pending(userId: string): Promise<string[]> {
  const rows = await fx.migration.query<{ id: string }>(
    "SELECT id FROM audit.provider_events WHERE user_id=$1 AND state='pending' ORDER BY id",
    [userId],
  );
  return rows.rows.map((row) => row.id);
}
async function auditFault(slow = false) {
  await fx.migration.query(
    slow
      ? `CREATE FUNCTION public.reconciliation_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF NEW.action='provider.reconciled' THEN PERFORM pg_sleep(0.9); END IF; RETURN NEW; END $$`
      : `CREATE FUNCTION public.reconciliation_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF NEW.action='provider.reconciled' THEN RAISE EXCEPTION 'Synthetic reconciliation audit outage' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$`,
  );
  await fx.migration.query(
    "CREATE TRIGGER reconciliation_test_fault BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION public.reconciliation_test_fault()",
  );
}
async function restoreAudit() {
  await fx.migration.query(
    "DROP TRIGGER reconciliation_test_fault ON audit.events",
  );
  await fx.migration.query("DROP FUNCTION public.reconciliation_test_fault()");
}

// Offline-only, fixed fault vocabulary. Never imported by the worker child;
// this is not an administrator API and never grants a runtime superuser role.
async function withAclFault(
  kind: "extra-exec" | "public-exec" | "grant-option" | "logging",
  inspect: () => Promise<void>,
) {
  const worker = new URL(fx.owned.workerUrl);
  const base = new URL(
    assertFoundationBaseUrl(process.env.SECURITY_TEST_DATABASE_URL ?? ""),
  );
  if (
    worker.hostname !== base.hostname ||
    worker.port !== base.port ||
    !/^bf_[a-f0-9]{12}_worker$/.test(worker.username) ||
    !/^bookstore_security_test_[a-f0-9]{12}$/.test(fx.owned.name)
  )
    throw new Error("Owned ACL fault binding unavailable.");
  base.pathname = `/${fx.owned.name}`;
  const admin = new Client({
    connectionString: base.toString(),
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    options:
      "-c application_name=bookstore-offline-reconciliation-fault -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0",
  });
  const role = `"${worker.username}"`;
  const database = `"${fx.owned.name}"`;
  const changes = {
    "extra-exec": [
      `GRANT EXECUTE ON FUNCTION audit.record_denial(uuid,text,text) TO ${role}`,
      `REVOKE EXECUTE ON FUNCTION audit.record_denial(uuid,text,text) FROM ${role}`,
    ],
    "public-exec": [
      "GRANT EXECUTE ON FUNCTION audit.pending_provider_events(integer) TO PUBLIC",
      "REVOKE EXECUTE ON FUNCTION audit.pending_provider_events(integer) FROM PUBLIC",
    ],
    "grant-option": [
      `GRANT EXECUTE ON FUNCTION audit.pending_provider_events(integer) TO ${role} WITH GRANT OPTION`,
      `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION audit.pending_provider_events(integer) FROM ${role}`,
    ],
    logging: [
      `ALTER ROLE ${role} IN DATABASE ${database} SET log_parameter_max_length='-1'`,
      `ALTER ROLE ${role} IN DATABASE ${database} RESET log_parameter_max_length`,
    ],
  } as const;
  let changed = false;
  try {
    await admin.connect();
    const check = await admin.query<{ safe: boolean }>(
      `SELECT current_user='bookstore_security_bootstrap' AND r.rolsuper
       AND pg_get_userbyid(d.datdba)=$2
       AND shobj_description(d.oid,'pg_database') ~ $3
       AND shobj_description(w.oid,'pg_authid')=shobj_description(d.oid,'pg_database') AS safe
       FROM pg_roles r CROSS JOIN pg_roles w CROSS JOIN pg_database d
       WHERE r.rolname=current_user AND w.rolname=$1 AND d.datname=current_database()`,
      [
        worker.username,
        worker.username.replace(/_worker$/, "_migrate"),
        `^bookstore-security-foundation:${worker.username.slice(3, 15)}:[a-f0-9]{32}$`,
      ],
    );
    if (check.rows.length !== 1 || check.rows[0]?.safe !== true)
      throw new Error("Owned ACL fault marker unavailable.");
    changed = true;
    await admin.query(changes[kind][0]);
    await inspect();
  } finally {
    try {
      if (changed) await admin.query(changes[kind][1]);
    } finally {
      await admin.end();
    }
  }
}

beforeAll(async () => {
  await fx.start();
}, 180_000);
beforeEach(async () => {
  // Independent scenarios ONLY, never within a budget/epoch/failure scenario.
  await fx.resetScenario();
});
async function closeOwnedWorkers() {
  const results = await Promise.allSettled([
    ...[...workers].map((value) => value.close()),
    ...[...children].map((value) => value.close()),
  ]);
  workers.clear();
  children.clear();
  if (results.some((value) => value.status === "rejected"))
    throw new Error("Isolated reconciliation cleanup unavailable.");
}
afterEach(closeOwnedWorkers, 15_000);
afterAll(async () => {
  await closeOwnedWorkers();
  await fx.stop();
}, 45_000);

describe("bounded deny-only reconciliation worker", () => {
  it("rejects wrong-purpose, extra-key and accessor configurations before SQL", async () => {
    let getterCalled = false;
    const cases = [
      { workerUrl: fx.owned.staffUrl },
      { workerUrl: fx.owned.workerUrl, query: "forbidden" },
      Object.defineProperty({}, "workerUrl", {
        get() {
          getterCalled = true;
          return fx.owned.workerUrl;
        },
      }),
    ];
    for (const config of cases) {
      let rejected = false;
      try {
        const value = await createReconciliationWorker(
          config as { workerUrl: string },
        );
        await value.close();
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    }
    expect(getterCalled).toBe(false);
  });

  it("takes one snapshot of at most20 and admits no overlapping queued run", async () => {
    const principal = await fx.createPrincipal();
    await sessions(principal.userId, 23);
    const value = await worker();
    const first = value.runOnce();
    const busy = await value.runOnce();
    const result = await first;
    expect(busy.status === "busy" && busy.selected === 0).toBe(true);
    expect(safeResult(result)).toBe(true);
    expect(
      result.status === "completed" &&
        result.selected === 20 &&
        result.applied === 20,
    ).toBe(true);
    expect((await pending(principal.userId)).length === 3).toBe(true);
    expect((await value.runOnce()).applied === 3).toBe(true);
  });

  it("keeps pending session.created noninvalidating and preserves live ready evidence", async () => {
    const principal = await fx.createPrincipal();
    const ready = await fx.ready(principal);
    expect((await pending(principal.userId)).length > 0).toBe(true);
    const processed = await (await worker()).runOnce();
    expect(safeResult(processed) && processed.status === "completed").toBe(
      true,
    );
    const finalized = await fx.subject.finalize(
      ready.operation.evidenceHandle,
      ready.jar.header,
    );
    expect(finalized.response.ok).toBe(true);
    expect((await fx.subject.check(ready.jar.header)).allowed).toBe(true);
    // A pending create for ANOTHER session is also intentionally noninvalidating.
    await sessions(principal.userId, 1);
    expect((await fx.subject.check(ready.jar.header)).allowed).toBe(true);
  });

  it("survives child loss after source commit without a watermark or automatic readmission", async () => {
    const principal = await fx.createPrincipal();
    const admitted = await fx.admitted(principal);
    await fx.drain();
    const abandoned = await child();
    expect((await fx.subject.check(admitted.jar.header)).allowed).toBe(true);
    await changed(principal.userId);
    await abandoned.kill();
    expect((await fx.subject.check(admitted.jar.header)).allowed).toBe(false);
    const restarted = await child();
    expect(await restarted.rejectTargetSelector()).toBe(true);
    expect((await pending(principal.userId)).length === 1).toBe(true);
    const result = await restarted.runOnce();
    expect(
      safeResult(result) &&
        result.status === "completed" &&
        result.applied === 1,
    ).toBe(true);
    expect((await fx.subject.check(admitted.jar.header)).allowed).toBe(false);
    const facts = await fx.migration.query<{ safe: boolean }>(
      `SELECT (SELECT retired FROM control_private.approved_generations WHERE generation_id=$1)
        AND NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$2)
        AND NOT EXISTS(SELECT 1 FROM audit.provider_events WHERE user_id=$2 AND state<>'processed') AS safe`,
      [principal.generationId, principal.userId],
    );
    expect(facts.rows[0]?.safe === true).toBe(true);
    expect((await restarted.runOnce()).applied === 0).toBe(true);
  });

  it("two real children apply a duplicate selection only once with one transition audit", async () => {
    const principal = await fx.createPrincipal();
    await changed(principal.userId);
    const transitions = await pending(principal.userId);
    expect(transitions.length === 1).toBe(true);
    const [left, right] = await Promise.all([child(), child()]);
    const results = await Promise.all([left.runOnce(), right.runOnce()]);
    expect(results.every(safeResult)).toBe(true);
    expect(results.reduce((sum, value) => sum + value.applied, 0) === 1).toBe(
      true,
    );
    const facts = await fx.migration.query<{ safe: boolean }>(
      `SELECT (SELECT count(*) FROM audit.events WHERE transition_id=$2::bigint)=1
        AND NOT EXISTS(SELECT 1 FROM audit.provider_events WHERE user_id=$1 AND state<>'processed') AS safe`,
      [principal.userId, transitions[0]],
    );
    expect(facts.rows[0]?.safe === true).toBe(true);
  });

  it("process loss during a real governance wait preserves one auditable outcome without rollback certainty", async () => {
    const principal = await fx.createPrincipal();
    await changed(principal.userId);
    const transitions = await pending(principal.userId);
    expect(transitions.length === 1).toBe(true);
    const value = await child();
    await fx.migration.query("BEGIN");
    await fx.migration.query(
      "SELECT 1 FROM staff.governance WHERE singleton FOR UPDATE",
    );
    const lost = value.runOnce().then(
      () => false,
      () => true,
    );
    try {
      const end = performance.now() + 900;
      let waiting = false;
      while (performance.now() < end && !waiting) {
        const barrier = await fx.worker.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='bookstore-reconciliation-worker' AND wait_event_type='Lock') AS waiting",
        );
        waiting = barrier.rows[0]?.waiting === true;
        if (!waiting) await pause(10);
      }
      expect(waiting).toBe(true);
      await value.kill();
      expect(await lost).toBe(true);
    } finally {
      await fx.migration.query("ROLLBACK");
      await value.kill();
      await lost;
    }
    // Killing the caller is NOT certain rollback: after the gate is released,
    // PostgreSQL may finish the already-sent statement before noticing EOF.
    const result = await (await child()).runOnce();
    expect(
      safeResult(result) &&
        result.status === "completed" &&
        result.applied <= 1,
    ).toBe(true);
    const facts = await fx.migration.query<{ safe: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM audit.provider_events WHERE id=$1::bigint AND state='processed')
        AND (SELECT count(*) FROM audit.events WHERE transition_id=$1::bigint)=1
        AND (SELECT retired FROM control_private.approved_generations WHERE generation_id=$2)
        AND NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$3) AS safe`,
      [transitions[0], principal.generationId, principal.userId],
    );
    expect(facts.rows[0]?.safe === true).toBe(true);
  });

  it("close owns an outstanding query and reports unavailable rather than certain rollback", async () => {
    const principal = await fx.createPrincipal();
    await changed(principal.userId);
    const value = await worker();
    await fx.migration.query("BEGIN");
    await fx.migration.query(
      "SELECT 1 FROM staff.governance WHERE singleton FOR UPDATE",
    );
    const run = value.runOnce();
    try {
      const end = performance.now() + 900;
      let waiting = false;
      while (performance.now() < end && !waiting) {
        const barrier = await fx.worker.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='bookstore-reconciliation-worker' AND wait_event_type='Lock') AS waiting",
        );
        waiting = barrier.rows[0]?.waiting === true;
        if (!waiting) await pause(10);
      }
      expect(waiting).toBe(true);
      await Promise.all([value.close(), value.close()]);
      const result = await run;
      expect(
        safeResult(result) &&
          result.status === "unavailable" &&
          result.uncertain === 1,
      ).toBe(true);
      expect(!Object.hasOwn(result, "rolledBack")).toBe(true);
    } finally {
      await fx.migration.query("ROLLBACK");
      await value.close();
      await run;
    }
  });

  it("processes lower pending IDs after a distinct higher event without rebasing approval", async () => {
    const principal = await fx.createPrincipal();
    await changed(principal.userId);
    await changed(principal.userId);
    const ids = await pending(principal.userId);
    expect(ids.length === 2).toBe(true);
    const higher = await fx.worker.query<{ done: boolean }>(
      "SELECT audit.reconcile_provider_event($1::bigint) AS done",
      [ids[1]],
    );
    expect(higher.rows[0]?.done === true).toBe(true);
    const result = await (await worker()).runOnce();
    expect(result.applied === 1 && result.selected === 1).toBe(true);
    const facts = await fx.migration.query<{ safe: boolean }>(
      `SELECT (SELECT retired FROM control_private.approved_generations WHERE generation_id=$1)
        AND (SELECT count(*) FROM audit.events WHERE transition_id=ANY($2::bigint[]))=2 AS safe`,
      [principal.generationId, ids],
    );
    expect(facts.rows[0]?.safe === true).toBe(true);
  });

  it("rolls audit failures back locally and blocks after five confirmed failure calls without granting", async () => {
    const principal = await fx.createPrincipal();
    const admitted = await fx.admitted(principal);
    await fx.drain();
    const before = await fx.migration.query<{ version: number }>(
      "SELECT authz_version AS version FROM staff.principals WHERE user_id=$1",
      [principal.userId],
    );
    await changed(principal.userId);
    const value = await worker();
    await auditFault();
    try {
      for (let index = 0; index < 5; index++) {
        const result = await value.runOnce();
        expect(safeResult(result)).toBe(true);
        expect(
          result.status === "partial" &&
            result.failed === 1 &&
            result.uncertain === 1 &&
            result.failureRecordCallsConfirmed === 1,
        ).toBe(true);
      }
      const facts = await fx.migration.query<{ safe: boolean }>(
        `SELECT (SELECT authz_version FROM staff.principals WHERE user_id=$1)=$2
          AND EXISTS(SELECT 1 FROM audit.provider_events WHERE user_id=$1 AND state='blocked' AND attempts=5)
          AND NOT EXISTS(SELECT 1 FROM audit.events e JOIN audit.provider_events p ON p.id=e.transition_id
            WHERE p.user_id=$1 AND p.state='blocked') AS safe`,
        [principal.userId, before.rows[0].version],
      );
      expect(facts.rows[0]?.safe === true).toBe(true);
      expect((await fx.subject.check(admitted.jar.header)).allowed).toBe(false);
    } finally {
      await restoreAudit();
    }
    const result = await value.runOnce();
    // selected0 is only this snapshot, NOT all-drained/healthy/blocked-total.
    expect(
      result.selected === 0 &&
        !Object.hasOwn(result, "healthy") &&
        !Object.hasOwn(result, "blocked"),
    ).toBe(true);
    expect((await fx.subject.check(admitted.jar.header)).allowed).toBe(false);
  });

  it("a fresh child retries pending work after local audit rollback, never source rollback", async () => {
    const principal = await fx.createPrincipal();
    await changed(principal.userId);
    const first = await child();
    await auditFault();
    try {
      const failed = await first.runOnce();
      expect(
        failed.status === "partial" && failed.failureRecordCallsConfirmed === 1,
      ).toBe(true);
      expect((await pending(principal.userId)).length === 1).toBe(true);
    } finally {
      await restoreAudit();
      await first.kill();
    }
    const result = await (await child()).runOnce();
    expect(result.status === "completed" && result.applied === 1).toBe(true);
    const facts = await fx.migration.query<{ safe: boolean }>(
      "SELECT retired AS safe FROM control_private.approved_generations WHERE generation_id=$1",
      [principal.generationId],
    );
    expect(facts.rows[0]?.safe === true).toBe(true);
  });

  it("rejects effective column SELECT drift on every checkout, even without schema usage", async () => {
    const value = await worker();
    const role = new URL(fx.owned.workerUrl).username;
    if (!/^bf_[a-f0-9]{12}_worker$/.test(role))
      throw new Error("Owned role unavailable.");
    await fx.migration.query(
      `GRANT SELECT (user_id) ON staff.principals TO "${role}"`,
    );
    try {
      const result = await value.runOnce();
      expect(result.status === "unavailable" && result.applied === 0).toBe(
        true,
      );
    } finally {
      await fx.migration.query(
        `REVOKE SELECT (user_id) ON staff.principals FROM "${role}"`,
      );
    }
    expect((await value.runOnce()).status === "completed").toBe(true);
  });

  it.each(["extra-exec", "public-exec", "grant-option", "logging"] as const)(
    "fails closed for owned offline %s drift without transmitting provider credentials",
    async (kind) => {
      await withAclFault(kind, async () => {
        let rejected = false;
        try {
          const candidate = await createReconciliationWorker({
            workerUrl: fx.owned.workerUrl,
          });
          await candidate.close();
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
      });
      expect((await (await worker()).runOnce()).status === "completed").toBe(
        true,
      );
    },
  );

  it("witnesses exactly five installed canonical EXECUTEs and idempotent closed denial", async () => {
    const value = await worker();
    const role = new URL(fx.owned.workerUrl).username;
    if (!/^bf_[a-f0-9]{12}_worker$/.test(role))
      throw new Error("Owned role unavailable.");
    // Independent catalog witness, not an inference from URL spelling or a
    // previous constructor. Offline fault cases above restore exact ACLs.
    const witness = await fx.migration.query<{ safe: boolean }>(
      `SELECT count(*)=5 AS safe FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname IN ('staff','audit','control_private') AND has_function_privilege($1,p.oid,'EXECUTE')`,
      [role],
    );
    expect(witness.rows[0]?.safe === true).toBe(true);
    await value.close();
    const result = await value.runOnce();
    expect(safeResult(result) && result.status === "unavailable").toBe(true);
  });

  it("stops scheduling after15seconds and never reports a late query as success", async () => {
    const principal = await fx.createPrincipal();
    await sessions(principal.userId, 20);
    const value = await worker();
    await auditFault(true);
    try {
      const started = performance.now();
      const result = await value.runOnce();
      expect(safeResult(result)).toBe(true);
      expect(result.status === "deadline" && result.applied < 20).toBe(true);
      expect(performance.now() - started < 20_000).toBe(true);
      await value.close();
      expect((await value.runOnce()).status === "unavailable").toBe(true);
    } finally {
      await restoreAudit();
    }
  });
});
