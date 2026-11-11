import { randomBytes, randomUUID } from "node:crypto";
import type { Client, QueryResult } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createAdmissionAuthority } from "../../src/server/security/admission-authority";
import { createSecurityKernel } from "../../src/server/security/kernel";
import {
  ControlFixtures,
  restartProbe,
  secretSafe,
  type SyntheticPrincipal,
} from "./fixtures";
import { pinOfflineGeneration } from "./offline-fixture";

const fx = new ControlFixtures();
const scenario = (name: string, run: () => Promise<void>) =>
  it(name, () => secretSafe(run));
async function sqlState(
  client: Client,
  query: string,
  args: unknown[] = [],
): Promise<string | null> {
  try {
    await client.query(query, args);
    return null;
  } catch (error) {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
      ? error.code
      : "unavailable";
  }
}
async function countAdmissions(userId: string): Promise<number> {
  const result = await fx.migration.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM staff.admissions WHERE user_id=$1",
    [userId],
  );
  return result.rows[0].count;
}
async function snapshot(sessionId: string) {
  const result = await fx.migration.query<{
    same_origin: string;
    same_idle: string;
    same_deadline: string;
    mfa: string;
  }>(
    `SELECT a.authenticated_at::text AS same_origin,a.last_seen_at::text AS same_idle,
      c.absolute_deadline::text AS same_deadline,a.mfa_at::text AS mfa
     FROM staff.admissions a JOIN control_private.session_controls c USING(session_id) WHERE a.session_id=$1`,
    [sessionId],
  );
  if (result.rowCount !== 1)
    throw new Error("Synthetic admission snapshot missing.");
  return result.rows[0];
}
async function wrongCode(principal: SyntheticPrincipal): Promise<string> {
  const accepted = new Set([
    await fx.code(principal, -1),
    await fx.code(principal),
    await fx.code(principal, 1),
  ]);
  const value = ["000000", "000001", "000002", "000003"].find(
    (candidate) => !accepted.has(candidate),
  );
  if (!value) throw new Error("Synthetic incorrect code unavailable.");
  return value;
}
async function restoreClock(): Promise<void> {
  // Explicit OFFLINE fixture recovery only; NEVER a runtime reset capability.
  await fx.migration
    .query(`UPDATE control_private.clock_state c SET frozen=false,high_water=clock_timestamp(),
    realm_id=s.realm_id,key_checksum=s.key_checksum FROM control_private.secrets s WHERE c.singleton AND s.singleton`);
}

async function waitForExpectedBlock(
  waiter: number,
  blocker: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await fx.migration.query<{ blocked: boolean }>(
      "SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked",
      [waiter, blocker],
    );
    if (result.rows[0].blocked) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Expected governance lock barrier was not reached.");
}
async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  return result.rows[0].pid;
}
async function settledRaceDecision(
  client: Client,
  sql: string,
  args: unknown[],
): Promise<{ allowed: boolean; failed: boolean }> {
  // Settle immediately into safe flags so a pre-barrier SQL fault cannot emit an
  // unhandled raw PG error. Every race asserts failed=false as well as outcome.
  try {
    const result = await client.query<{ decision: { allowed: boolean } }>(
      sql,
      args,
    );
    const allowed = result.rows[0]?.decision?.allowed;
    return {
      allowed: allowed === true,
      failed: result.rowCount !== 1 || typeof allowed !== "boolean",
    };
  } catch {
    return { allowed: false, failed: true };
  }
}
async function readyStepUpForRace() {
  // All real SDK work completes BEFORE any staff/governance transaction starts.
  const principal = await fx.createPrincipal(),
    admitted = await fx.admitted(principal);
  const next = await fx.code(principal, 1);
  expect(next !== admitted.code).toBe(true);
  const ready = await fx.subject.stepUp(next, admitted.jar.header);
  expect(ready.response.status).toBe(200);
  if (!ready.evidenceHandle)
    throw new Error("Real SDK step-up evidence missing.");
  const live = await fx.subject.check(admitted.jar.header);
  if (
    !live.allowed ||
    !("authorizationVersion" in live) ||
    typeof live.authorizationVersion !== "number"
  )
    throw new Error("Live native admission version missing.");
  return {
    principal,
    admitted,
    evidenceHandle: ready.evidenceHandle,
    version: live.authorizationVersion,
  };
}

beforeAll(() => secretSafe(() => fx.start()));
beforeEach(() => secretSafe(() => fx.resetScenario()));
afterAll(() => secretSafe(() => fx.stop()));

describe("dormant real SDK admission controls, no mounted authentication", () => {
  scenario(
    "keeps password-only state non-admitted and the default kernel closed",
    async () => {
      const p = await fx.createPrincipal();
      const primary = await fx.begin(p);
      expect(primary.operation.response.status).toBe(200);
      expect(primary.operation.evidenceHandle === null).toBe(true);
      expect(await countAdmissions(p.userId)).toBe(0);
      expect((await fx.subject.check(primary.jar.header)).allowed).toBe(false);
      const kernel = createSecurityKernel(fx.owned.staffUrl);
      try {
        expect(
          (
            await kernel.authorize("security.self.read", {
              userId: p.userId,
              verified: true,
            })
          ).allowed,
        ).toBe(false);
      } finally {
        await kernel.close();
      }
    },
  );

  scenario(
    "requires ready consumption after actual MFA and never wires the default resolver",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      expect(await countAdmissions(p.userId)).toBe(0);
      expect((await fx.subject.check(ready.jar.header)).allowed).toBe(false);
      const finalized = await fx.subject.finalize(
        ready.operation.evidenceHandle,
        ready.jar.header,
      );
      expect(finalized.response.status).toBe(200);
      expect((await fx.subject.check(ready.jar.header)).allowed).toBe(true);
      expect(await countAdmissions(p.userId)).toBe(1);
      const kernel = createSecurityKernel(fx.owned.staffUrl);
      try {
        expect((await kernel.authorize("security.self.read")).allowed).toBe(
          false,
        );
      } finally {
        await kernel.close();
      }
    },
  );

  scenario(
    "projects only the disabled application envelope, never capabilities or provider secrets",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      const body = (await ready.operation.response.clone().json()) as Record<
        string,
        unknown
      >;
      expect(Object.keys(body).sort()).toEqual([
        "allowed",
        "applicationAdmission",
        "reason",
        "state",
      ]);
      expect(body.applicationAdmission === "disabled").toBe(true);
      expect(
        typeof ready.operation.evidenceHandle === "string" &&
          /^[a-f0-9]{64}$/.test(ready.operation.evidenceHandle),
      ).toBe(true);
      expect(
        ready.operation.response.headers.get("cache-control") ===
          "private, no-store",
      ).toBe(true);
      expect(
        ready.operation.response.headers
          .getSetCookie()
          .every(
            (entry) =>
              /;\s*secure(?:;|$)/i.test(entry) &&
              /;\s*httponly(?:;|$)/i.test(entry),
          ),
      ).toBe(true);
    },
  );

  scenario(
    "rejects fabricated and malformed proof handles without creating admission",
    async () => {
      const p = await fx.createPrincipal();
      for (const capability of [
        randomBytes(32).toString("hex"),
        "not-a-proof",
        { allowed: true },
      ]) {
        const result = await fx.subject.finalize(capability, p.setupJar.header);
        expect(result.response.ok).toBe(false);
      }
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );

  scenario(
    "makes identical consumed-proof retries idempotent without touching any epoch or audit",
    async () => {
      const p = await fx.createPrincipal(),
        admitted = await fx.admitted(p);
      const before = await snapshot(admitted.sessionId);
      const auditBefore = await fx.migration.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM audit.events WHERE subject_id=$1 AND action='control.login'",
        [p.userId],
      );
      expect(
        (
          await fx.subject.finalize(
            admitted.operation.evidenceHandle,
            admitted.jar.header,
          )
        ).response.status,
      ).toBe(200);
      const after = await snapshot(admitted.sessionId);
      expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
      const auditAfter = await fx.migration.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM audit.events WHERE subject_id=$1 AND action='control.login'",
        [p.userId],
      );
      expect(auditAfter.rows[0].count === auditBefore.rows[0].count).toBe(true);
    },
  );

  scenario(
    "rejects ready evidence after its immutable reservation deadline",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      // Boundary fixture changes time fields only after genuine SDK ready success.
      await fx.migration.query(
        `WITH boundary AS MATERIALIZED (SELECT clock_timestamp()-interval '31 seconds' AS reserved)
      UPDATE control_private.attempts SET reserved_at=boundary.reserved,
      deadline=least(primary_deadline,boundary.reserved+interval '30 seconds') FROM boundary WHERE evidence_handle=$1`,
        [ready.operation.evidenceHandle],
      );
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            ready.jar.header,
          )
        ).response.ok,
      ).toBe(false);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );

  scenario(
    "does not rebase ready evidence onto a newer authorization version",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      await fx.migration.query(
        "UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=$1",
        [p.userId],
      );
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            ready.jar.header,
          )
        ).response.ok,
      ).toBe(false);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );

  scenario(
    "denies expired primary cookies without a reservation or native session",
    async () => {
      const p = await fx.createPrincipal(),
        primary = await fx.begin(p);
      await fx.migration.query(
        `WITH boundary AS MATERIALIZED (SELECT clock_timestamp()-interval '121 seconds' AS origin)
      UPDATE control_private.attempts SET authenticated_at=boundary.origin,
      primary_deadline=boundary.origin+interval '120 seconds' FROM boundary WHERE user_id=$1 AND state='bound'`,
        [p.userId],
      );
      const result = await fx.subject.verifyTotp(
        await fx.code(p),
        primary.jar.header,
      );
      expect(result.response.ok).toBe(false);
      const row = await fx.migration.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM control_private.attempts WHERE user_id=$1 AND operation_handle IS NOT NULL",
        [p.userId],
      );
      expect(row.rows[0].count).toBe(0);
    },
  );

  scenario(
    "has one ready winner across two native challenges and independent factory workers",
    async () => {
      const p = await fx.createPrincipal(),
        other = await fx.newSubject();
      const first = await fx.begin(p),
        second = await fx.begin(p, other),
        code = await fx.code(p);
      const results = await Promise.all([
        fx.subject.verifyTotp(code, first.jar.header),
        other.verifyTotp(code, second.jar.header),
      ]);
      expect(
        results.filter(
          (result) => result.response.ok && result.evidenceHandle !== null,
        ),
      ).toHaveLength(1);
      const state = await fx.migration.query<{
        ready: number;
        denied: number;
        created: number;
      }>(
        `SELECT count(*) FILTER(WHERE state='ready')::integer AS ready,
       count(*) FILTER(WHERE state='denied')::integer AS denied,
       count(final_session_id)::integer AS created FROM control_private.attempts WHERE user_id=$1`,
        [p.userId],
      );
      expect(state.rows[0]).toEqual({ ready: 1, denied: 1, created: 1 });
      const index = results.findIndex((result) => result.response.ok);
      const jar = index === 0 ? first.jar : second.jar;
      jar.absorb(results[index].response);
      expect(
        (await fx.subject.finalize(results[index].evidenceHandle, jar.header))
          .response.status,
      ).toBe(200);
      expect(await countAdmissions(p.userId)).toBe(1);
      await fx.closeSubject(other);
    },
  );

  scenario(
    "claims one challenge only once even for two distinct valid SDK codes",
    async () => {
      const p = await fx.createPrincipal(),
        primary = await fx.begin(p);
      const current = await fx.code(p),
        next = await fx.code(p, 1);
      expect(current !== next).toBe(true);
      const results = await Promise.all([
        fx.subject.verifyTotp(current, primary.jar.header),
        fx.subject.verifyTotp(next, primary.jar.header),
      ]);
      expect(results.filter((result) => result.response.ok)).toHaveLength(1);
      const state = await fx.migration.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM control_private.attempts WHERE user_id=$1 AND operation_handle IS NOT NULL",
        [p.userId],
      );
      expect(state.rows[0].count).toBe(1);
    },
  );

  scenario(
    "burns incorrect SDK codes durably and cannot resume an inflight attempt",
    async () => {
      const p = await fx.createPrincipal(),
        primary = await fx.begin(p),
        code = await wrongCode(p);
      const denied = await fx.subject.verifyTotp(code, primary.jar.header);
      expect(denied.response.ok).toBe(false);
      expect(denied.evidenceHandle === null).toBe(true);
      const burn = await fx.migration.query<{
        burned: boolean;
        retained: boolean;
      }>(
        `SELECT EXISTS(SELECT 1 FROM control_private.replay_burns b JOIN control_private.attempts a ON a.code_mac=b.code_mac WHERE a.user_id=$1) AS burned,
       EXISTS(SELECT 1 FROM control_private.attempts WHERE user_id=$1 AND state='inflight') AS retained`,
        [p.userId],
      );
      expect(burn.rows[0]).toEqual({ burned: true, retained: true });
      expect(
        (await fx.subject.verifyTotp(await fx.code(p), primary.jar.header))
          .response.ok,
      ).toBe(false);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );

  scenario(
    "binds proof to the exact same-user session cookie, not another provider session",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            p.setupJar.header,
          )
        ).response.ok,
      ).toBe(false);
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            ready.jar.header,
          )
        ).response.status,
      ).toBe(200);
    },
  );

  scenario(
    "rejects cross-user cookie and code substitution without admitting either user",
    async () => {
      const a = await fx.createPrincipal(),
        b = await fx.createPrincipal();
      const ready = await fx.ready(a),
        primary = await fx.begin(b);
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            b.setupJar.header,
          )
        ).response.ok,
      ).toBe(false);
      const otherCodes = new Set([
        await fx.code(b, -1),
        await fx.code(b),
        await fx.code(b, 1),
      ]);
      expect(otherCodes.has(ready.code)).toBe(false);
      const substituted = await fx.subject.verifyTotp(
        ready.code,
        primary.jar.header,
      );
      expect(substituted.response.ok).toBe(false);
      expect(substituted.evidenceHandle === null).toBe(true);
      expect(
        (await countAdmissions(a.userId)) + (await countAdmissions(b.userId)),
      ).toBe(0);
    },
  );

  scenario(
    "shares the login burn with step-up and preserves absolute and idle origins",
    async () => {
      const p = await fx.createPrincipal(),
        admitted = await fx.admitted(p);
      const before = await snapshot(admitted.sessionId);
      expect(
        (await fx.subject.stepUp(admitted.code, admitted.jar.header)).response
          .ok,
      ).toBe(false);
      const next = await fx.code(p, 1);
      expect(next !== admitted.code).toBe(true);
      const ready = await fx.subject.stepUp(next, admitted.jar.header);
      expect(ready.response.status).toBe(200);
      expect(ready.evidenceHandle !== null).toBe(true);
      expect(
        (await fx.subject.finalize(ready.evidenceHandle, admitted.jar.header))
          .response.status,
      ).toBe(200);
      const after = await snapshot(admitted.sessionId);
      expect(before.same_origin === after.same_origin).toBe(true);
      expect(before.same_idle === after.same_idle).toBe(true);
      expect(before.same_deadline === after.same_deadline).toBe(true);
      const anotherLogin = await fx.begin(p);
      expect(anotherLogin.operation.response.status).toBe(200);
      // Reverse purpose direction too: step-up's code cannot mint a new login.
      expect(
        (await fx.subject.verifyTotp(next, anotherLogin.jar.header)).response
          .ok,
      ).toBe(false);
    },
  );

  scenario(
    "retains the same code burn across an authorization-version reset and fresh login",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      await fx.migration.query(
        "UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=$1",
        [p.userId],
      );
      const fresh = await fx.begin(p);
      expect(fresh.operation.response.status).toBe(200);
      expect(
        (await fx.subject.verifyTotp(ready.code, fresh.jar.header)).response.ok,
      ).toBe(false);
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            ready.jar.header,
          )
        ).response.ok,
      ).toBe(false);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );

  scenario(
    "retires poisoned password generations monotonically even after exact-byte ABA restoration",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      const original = await fx.auth.query<{ id: string; password: string }>(
        'SELECT id,password FROM identity."Account" WHERE "userId"=$1 AND "providerId"=\'credential\'',
        [p.userId],
      );
      const account = original.rows[0];
      await fx.auth.query(
        'UPDATE identity."Account" SET password=$1 WHERE id=$2',
        [randomBytes(32).toString("hex"), account.id],
      );
      await fx.auth.query(
        'UPDATE identity."Account" SET password=$1 WHERE id=$2',
        [account.password, account.id],
      );
      await fx.drain();
      const retired = await fx.migration.query<{ retired: boolean }>(
        "SELECT retired FROM control_private.approved_generations WHERE generation_id=$1",
        [p.generationId],
      );
      expect(retired.rows[0].retired).toBe(true);
      expect((await fx.begin(p)).operation.response.ok).toBe(false);
      const newGeneration = await pinOfflineGeneration(fx.migration, p.userId);
      expect(newGeneration !== p.generationId).toBe(true);
      const fresh = await fx.begin(p);
      expect(fresh.operation.response.status).toBe(200);
      expect(
        (await fx.subject.verifyTotp(ready.code, fresh.jar.header)).response.ok,
      ).toBe(false);
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            ready.jar.header,
          )
        ).response.ok,
      ).toBe(false);
    },
  );

  scenario(
    "retires exact factor-ciphertext ABA and never re-approves it at runtime",
    async () => {
      const p = await fx.createPrincipal();
      const original = await fx.auth.query<{ id: string; secret: string }>(
        'SELECT id,secret FROM identity."TwoFactor" WHERE "userId"=$1',
        [p.userId],
      );
      await fx.auth.query(
        'UPDATE identity."TwoFactor" SET secret=$1 WHERE id=$2',
        [randomBytes(40).toString("base64url"), original.rows[0].id],
      );
      await fx.auth.query(
        'UPDATE identity."TwoFactor" SET secret=$1 WHERE id=$2',
        [original.rows[0].secret, original.rows[0].id],
      );
      await fx.drain();
      const row = await fx.migration.query<{ retired: boolean }>(
        "SELECT retired FROM control_private.approved_generations WHERE generation_id=$1",
        [p.generationId],
      );
      expect(row.rows[0].retired).toBe(true);
      expect((await fx.begin(p)).operation.response.ok).toBe(false);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );

  scenario(
    "rejects AUTH session primary-key rename before ABA and retains the original proof binding",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      expect(
        await sqlState(
          fx.auth,
          'UPDATE identity."Session" SET id=$1 WHERE id=$2',
          [randomUUID(), ready.sessionId],
        ),
      ).toBe("23514");
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            ready.jar.header,
          )
        ).response.status,
      ).toBe(200);
      expect((await fx.subject.check(ready.jar.header)).allowed).toBe(true);
    },
  );

  scenario(
    "denies token rotation and cannot restore old evidence with the old token bytes",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      const original = await fx.auth.query<{ token: string }>(
        'SELECT token FROM identity."Session" WHERE id=$1',
        [ready.sessionId],
      );
      await fx.auth.query(
        'UPDATE identity."Session" SET token=$1 WHERE id=$2',
        [randomBytes(40).toString("base64url"), ready.sessionId],
      );
      await fx.auth.query(
        'UPDATE identity."Session" SET token=$1 WHERE id=$2',
        [original.rows[0].token, ready.sessionId],
      );
      await fx.drain();
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            ready.jar.header,
          )
        ).response.ok,
      ).toBe(false);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );

  scenario(
    "treats provider expiry mutation as retirement, not harmless age refresh",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      await fx.auth.query(
        'UPDATE identity."Session" SET "expiresAt"="expiresAt"+interval \'1 minute\' WHERE id=$1',
        [ready.sessionId],
      );
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            ready.jar.header,
          )
        ).response.ok,
      ).toBe(false);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );

  scenario(
    "linearizes revocation before a blocked native step-up finalizer",
    async () => {
      const state = await readyStepUpForRace();
      const revoker = await fx.client(fx.owned.staffUrl),
        finalizer = await fx.client(fx.owned.staffUrl);
      const revokerPid = await backendPid(revoker),
        finalizerPid = await backendPid(finalizer);
      let pending: Promise<{ allowed: boolean; failed: boolean }> | undefined;
      let committed = false;
      await revoker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        // STAFF has no raw governance UPDATE privilege. The existing reviewed
        // definer clock probe takes the SAME governance lock until this COMMIT.
        const gate = await settledRaceDecision(
          revoker,
          "SELECT staff.control_clock_probe() AS decision",
          [],
        );
        expect(gate).toEqual({ allowed: true, failed: false });
        expect(
          await settledRaceDecision(
            revoker,
            "SELECT staff.revoke_admission($1::text,$2::text,$3::bigint,$2::text) AS decision",
            [state.principal.userId, state.admitted.sessionId, state.version],
          ),
        ).toEqual({ allowed: true, failed: false });
        pending = settledRaceDecision(
          finalizer,
          "SELECT staff.finalize_control($1::text,$2::text,$3::text) AS decision",
          [
            state.evidenceHandle,
            state.admitted.sessionId,
            state.admitted.jar.canonical,
          ],
        );
        await waitForExpectedBlock(finalizerPid, revokerPid);
        await revoker.query("COMMIT");
        committed = true;
        expect(await pending).toEqual({ allowed: false, failed: false });
      } finally {
        if (!committed) await revoker.query("ROLLBACK");
        if (pending) await pending;
        await fx.release(finalizer);
        await fx.release(revoker);
      }
      const durable = await fx.migration.query<{
        revoked: boolean;
        success_count: number;
      }>(
        `SELECT
      c.revoked AND o.retired AND a.mode='revoked' AS revoked,
      (SELECT count(*)::integer FROM audit.events WHERE subject_id=$2 AND action='control.step_up') AS success_count
      FROM control_private.session_controls c JOIN control_private.session_observations o USING(session_id)
      JOIN staff.admissions a USING(session_id) WHERE c.session_id=$1`,
        [state.admitted.sessionId, state.principal.userId],
      );
      expect(durable.rows[0]).toEqual({ revoked: true, success_count: 0 });
      expect((await fx.subject.check(state.admitted.jar.header)).allowed).toBe(
        false,
      );
      expect(
        (
          await fx.subject.finalize(
            state.evidenceHandle,
            state.admitted.jar.header,
          )
        ).response.ok,
      ).toBe(false);
    },
  );

  scenario(
    "preserves a committed step-up fact when a later blocked revocation wins next",
    async () => {
      const state = await readyStepUpForRace();
      const finalizer = await fx.client(fx.owned.staffUrl),
        revoker = await fx.client(fx.owned.staffUrl);
      const finalizerPid = await backendPid(finalizer),
        revokerPid = await backendPid(revoker);
      let pending: Promise<{ allowed: boolean; failed: boolean }> | undefined;
      let committed = false;
      await finalizer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        expect(
          await settledRaceDecision(
            finalizer,
            "SELECT staff.control_clock_probe() AS decision",
            [],
          ),
        ).toEqual({ allowed: true, failed: false });
        expect(
          await settledRaceDecision(
            finalizer,
            "SELECT staff.finalize_control($1::text,$2::text,$3::text) AS decision",
            [
              state.evidenceHandle,
              state.admitted.sessionId,
              state.admitted.jar.canonical,
            ],
          ),
        ).toEqual({ allowed: true, failed: false });
        pending = settledRaceDecision(
          revoker,
          "SELECT staff.revoke_admission($1::text,$2::text,$3::bigint,$2::text) AS decision",
          [state.principal.userId, state.admitted.sessionId, state.version],
        );
        await waitForExpectedBlock(revokerPid, finalizerPid);
        await finalizer.query("COMMIT");
        committed = true;
        expect(await pending).toEqual({ allowed: true, failed: false });
      } finally {
        if (!committed) await finalizer.query("ROLLBACK");
        if (pending) await pending;
        await fx.release(revoker);
        await fx.release(finalizer);
      }
      const durable = await fx.migration.query<{
        revoked: boolean;
        success_count: number;
      }>(
        `SELECT
      c.revoked AND o.retired AND a.mode='revoked' AS revoked,
      (SELECT count(*)::integer FROM audit.events WHERE subject_id=$2 AND action='control.step_up') AS success_count
      FROM control_private.session_controls c JOIN control_private.session_observations o USING(session_id)
      JOIN staff.admissions a USING(session_id) WHERE c.session_id=$1`,
        [state.admitted.sessionId, state.principal.userId],
      );
      expect(durable.rows[0]).toEqual({ revoked: true, success_count: 1 });
      expect((await fx.subject.check(state.admitted.jar.header)).allowed).toBe(
        false,
      );
      expect(
        (
          await fx.subject.finalize(
            state.evidenceHandle,
            state.admitted.jar.header,
          )
        ).response.ok,
      ).toBe(false);
    },
  );

  scenario(
    "denies concurrent original-code step-up replay across two genuinely admitted active sessions",
    async () => {
      const p = await fx.createPrincipal(),
        first = await fx.admitted(p);
      const next = await fx.code(p, 1);
      expect(next !== first.code).toBe(true);
      const second = await fx.admitted(p, next);
      expect(first.sessionId !== second.sessionId).toBe(true);
      expect((await fx.subject.check(first.jar.header)).allowed).toBe(true);
      expect((await fx.subject.check(second.jar.header)).allowed).toBe(true);
      const beforeFirst = await snapshot(first.sessionId),
        beforeSecond = await snapshot(second.sessionId);
      const results = await Promise.all([
        fx.subject.stepUp(first.code, first.jar.header),
        fx.subject.stepUp(first.code, second.jar.header),
      ]);
      expect(
        results.every(
          (result) => !result.response.ok && result.evidenceHandle === null,
        ),
      ).toBe(true);
      expect(
        JSON.stringify(beforeFirst) ===
          JSON.stringify(await snapshot(first.sessionId)),
      ).toBe(true);
      expect(
        JSON.stringify(beforeSecond) ===
          JSON.stringify(await snapshot(second.sessionId)),
      ).toBe(true);
      expect(await countAdmissions(p.userId)).toBe(2);
      const audit = await fx.migration.query<{
        logins: number;
        stepups: number;
      }>(
        `SELECT
      count(*) FILTER(WHERE action='control.login')::integer AS logins,
      count(*) FILTER(WHERE action='control.step_up')::integer AS stepups
      FROM audit.events WHERE subject_id=$1`,
        [p.userId],
      );
      expect(audit.rows[0]).toEqual({ logins: 2, stepups: 0 });
      expect((await fx.subject.check(first.jar.header)).allowed).toBe(true);
      expect((await fx.subject.check(second.jar.header)).allowed).toBe(true);
    },
  );

  scenario(
    "preserves self-revocation tombstones across admission and provider-session deletion",
    async () => {
      const p = await fx.createPrincipal(),
        admitted = await fx.admitted(p);
      expect(
        (await fx.subject.revoke(admitted.jar.header)).response.status,
      ).toBe(200);
      await fx.migration.query(
        "DELETE FROM staff.admissions WHERE session_id=$1",
        [admitted.sessionId],
      );
      await fx.auth.query('DELETE FROM identity."Session" WHERE id=$1', [
        admitted.sessionId,
      ]);
      const controls = await fx.migration.query<{
        revoked: boolean;
        retired: boolean;
      }>(
        "SELECT c.revoked,o.retired FROM control_private.session_controls c JOIN control_private.session_observations o USING(session_id) WHERE c.session_id=$1",
        [admitted.sessionId],
      );
      expect(controls.rows[0]).toEqual({ revoked: true, retired: true });
      expect(
        (
          await fx.subject.finalize(
            admitted.operation.evidenceHandle,
            admitted.jar.header,
          )
        ).response.ok,
      ).toBe(false);
    },
  );

  scenario(
    "tombstones direct admission deletion rather than allowing proof resurrection",
    async () => {
      const p = await fx.createPrincipal(),
        admitted = await fx.admitted(p);
      await fx.migration.query(
        "DELETE FROM staff.admissions WHERE session_id=$1",
        [admitted.sessionId],
      );
      expect(
        (
          await fx.subject.finalize(
            admitted.operation.evidenceHandle,
            admitted.jar.header,
          )
        ).response.ok,
      ).toBe(false);
      expect((await fx.subject.check(admitted.jar.header)).allowed).toBe(false);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );

  scenario(
    "checks idle expiry before touch and cannot revive the original epoch",
    async () => {
      const p = await fx.createPrincipal(),
        admitted = await fx.admitted(p);
      // OFFLINE age-boundary fixture after actual native admission. Preserve
      // the existing last_seen>=authentication and immutable eight-hour-deadline
      // SQL constraints; no runtime caller receives an epoch-changing primitive.
      await fx.migration.query(
        `WITH boundary AS MATERIALIZED (SELECT clock_timestamp() AS n), changed AS (
          UPDATE staff.admissions SET authenticated_at=boundary.n-interval '32 minutes',
            last_seen_at=boundary.n-interval '31 minutes' FROM boundary WHERE session_id=$1
          RETURNING session_id,authenticated_at)
         UPDATE control_private.session_controls c SET authenticated_at=a.authenticated_at,
           absolute_deadline=a.authenticated_at+interval '8 hours'
         FROM changed a WHERE c.session_id=a.session_id`,
        [admitted.sessionId],
      );
      const before = await snapshot(admitted.sessionId);
      expect((await fx.subject.touch(admitted.jar.header)).response.ok).toBe(
        false,
      );
      expect(
        (await snapshot(admitted.sessionId)).same_idle === before.same_idle,
      ).toBe(true);
    },
  );

  scenario(
    "touches only explicit live activity without moving the authentication origin",
    async () => {
      const p = await fx.createPrincipal(),
        admitted = await fx.admitted(p);
      const before = await snapshot(admitted.sessionId);
      expect(
        (await fx.subject.touch(admitted.jar.header)).response.status,
      ).toBe(200);
      const after = await snapshot(admitted.sessionId);
      expect(
        before.same_origin === after.same_origin &&
          before.same_deadline === after.same_deadline,
      ).toBe(true);
      const moved = await fx.migration.query<{ moved: boolean }>(
        "SELECT last_seen_at >= $2::timestamptz AS moved FROM staff.admissions WHERE session_id=$1",
        [admitted.sessionId, before.same_idle],
      );
      expect(moved.rows[0].moved).toBe(true);
    },
  );

  scenario(
    "rolls local finalization and success audit back while retaining the committed replay burn",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      await fx.migration.query(
        "CREATE FUNCTION public.gate_fail_final_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic final audit fault' USING ERRCODE='P0001'; END $$",
      );
      await fx.migration.query(
        "CREATE TRIGGER gate_fail_final_audit BEFORE INSERT ON audit.events FOR EACH ROW WHEN (NEW.action IN ('control.login','control.step_up')) EXECUTE FUNCTION public.gate_fail_final_audit()",
      );
      try {
        expect(
          (
            await fx.subject.finalize(
              ready.operation.evidenceHandle,
              ready.jar.header,
            )
          ).response.status,
        ).toBe(503);
        expect(await countAdmissions(p.userId)).toBe(0);
        const row = await fx.migration.query<{
          ready: boolean;
          burned: boolean;
        }>(
          `SELECT a.state='ready' AS ready,EXISTS(SELECT 1 FROM control_private.replay_burns b WHERE b.code_mac=a.code_mac AND b.expires_at>clock_timestamp()) AS burned
         FROM control_private.attempts a WHERE evidence_handle=$1`,
          [ready.operation.evidenceHandle],
        );
        expect(row.rows[0]).toEqual({ ready: true, burned: true });
      } finally {
        await fx.migration.query(
          "DROP TRIGGER gate_fail_final_audit ON audit.events",
        );
        await fx.migration.query(
          "DROP FUNCTION public.gate_fail_final_audit()",
        );
      }
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            ready.jar.header,
          )
        ).response.status,
      ).toBe(200);
      expect(await countAdmissions(p.userId)).toBe(1);
    },
  );

  scenario(
    "never issues evidence after real native session persistence fails",
    async () => {
      const p = await fx.createPrincipal(),
        primary = await fx.begin(p);
      await fx.migration.query(
        "CREATE FUNCTION public.gate_fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic native session fault' USING ERRCODE='P0001'; END $$",
      );
      await fx.migration.query(
        'CREATE TRIGGER gate_fail_session BEFORE INSERT ON identity."Session" FOR EACH ROW EXECUTE FUNCTION public.gate_fail_session()',
      );
      try {
        const failed = await fx.subject.verifyTotp(
          await fx.code(p),
          primary.jar.header,
        );
        expect(failed.response.status).toBe(503);
        expect(failed.evidenceHandle === null).toBe(true);
        expect(failed.response.headers.getSetCookie()).toHaveLength(0);
        expect(await countAdmissions(p.userId)).toBe(0);
      } finally {
        await fx.migration.query(
          'DROP TRIGGER gate_fail_session ON identity."Session"',
        );
        await fx.migration.query("DROP FUNCTION public.gate_fail_session()");
      }
    },
  );

  scenario(
    "denies a real post-comparison factor-persistence fault without exposing SDK errors",
    async () => {
      const p = await fx.createPrincipal(),
        primary = await fx.begin(p);
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      await fx.migration.query(
        "CREATE FUNCTION public.gate_fail_factor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic factor persistence fault' USING ERRCODE='P0001'; END $$",
      );
      await fx.migration.query(
        'CREATE TRIGGER gate_fail_factor BEFORE UPDATE ON identity."TwoFactor" FOR EACH ROW EXECUTE FUNCTION public.gate_fail_factor()',
      );
      try {
        // Real SDK success resets native factor accounting AFTER its maintained
        // comparison, before sign-in challenge/session completion. This does NOT
        // claim operational enrollment or an endpoint-wide provider rollback.
        const failed = await fx.subject.verifyTotp(
          await fx.code(p),
          primary.jar.header,
        );
        expect(failed.response.status).toBe(503);
        expect(failed.evidenceHandle === null).toBe(true);
        expect(failed.response.headers.getSetCookie()).toHaveLength(0);
        expect(consoleError.mock.calls.length).toBe(0);
        expect(await countAdmissions(p.userId)).toBe(0);
      } finally {
        consoleError.mockRestore();
        await fx.migration.query(
          'DROP TRIGGER gate_fail_factor ON identity."TwoFactor"',
        );
        await fx.migration.query("DROP FUNCTION public.gate_fail_factor()");
      }
    },
  );

  scenario(
    "sets audit actor from the bound proof instead of a forged caller GUC",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      await fx.staff.query(
        "SELECT set_config('bookstore.security_actor',$1,false)",
        [randomUUID()],
      );
      try {
        const finalized = await fx.staff.query<{
          decision: { allowed: boolean };
        }>(
          "SELECT staff.finalize_control($1::text,$2::text,$3::text) AS decision",
          [
            ready.operation.evidenceHandle,
            ready.sessionId,
            ready.jar.canonical,
          ],
        );
        expect(finalized.rows[0].decision.allowed).toBe(true);
        const audit = await fx.migration.query<{ actor_matches: boolean }>(
          "SELECT actor_id=$1 AS actor_matches FROM audit.events WHERE subject_id=$1 AND action='control.login'",
          [p.userId],
        );
        expect(audit.rowCount).toBe(1);
        expect(audit.rows[0].actor_matches).toBe(true);
      } finally {
        await fx.staff.query("RESET bookstore.security_actor");
      }
    },
  );

  scenario(
    "charges a shared account password budget atomically and never extends it on denial",
    async () => {
      const p = await fx.createPrincipal();
      const clients = await Promise.all(
        Array.from({ length: 4 }, () => fx.client(fx.owned.verifierUrl)),
      );
      try {
        const results = (
          await Promise.all(
            clients.map(async (client) => {
              const outcomes: boolean[] = [];
              for (let round = 0; round < 2; round++) {
                const result = await client.query<{
                  decision: { allowed: boolean };
                }>(
                  "SELECT control_private.prepare_password($1::text,'gatebudget'::text) AS decision",
                  [p.email],
                );
                outcomes.push(result.rows[0].decision.allowed);
              }
              return outcomes;
            }),
          )
        ).flat();
        expect(results.filter(Boolean)).toHaveLength(5);
        const before = await fx.migration.query<{
          used: number;
          window_end: string;
        }>(
          "SELECT used,window_end::text FROM control_private.budgets WHERE key_mac=control_private.mac('budget-account-password',$1)",
          [p.email],
        );
        expect(before.rows[0].used).toBe(5);
        await fx.verifier.query(
          "SELECT control_private.prepare_password($1::text,'gatebudget'::text)",
          [p.email],
        );
        const after = await fx.migration.query<{
          used: number;
          window_end: string;
        }>(
          "SELECT used,window_end::text FROM control_private.budgets WHERE key_mac=control_private.mac('budget-account-password',$1)",
          [p.email],
        );
        expect(after.rows[0].used).toBe(5);
        expect(before.rows[0].window_end === after.rows[0].window_end).toBe(
          true,
        );
      } finally {
        for (const client of clients) await fx.release(client);
      }
    },
  );

  scenario(
    "counts concurrent inflight MFA reservations against the global account budget",
    async () => {
      const p = await fx.createPrincipal(),
        admitted = await fx.admitted(p);
      const challenges: string[] = [];
      for (let index = 0; index < 12; index++) {
        const prepared = await fx.verifier.query<{
          decision: { allowed: boolean; challengeHandle: string };
        }>(
          "SELECT control_private.prepare_step_up($1::text,$2::text,$3::text,'gatebudget'::text) AS decision",
          [p.userId, admitted.sessionId, admitted.jar.canonical],
        );
        expect(prepared.rows[0].decision.allowed).toBe(true);
        challenges.push(prepared.rows[0].decision.challengeHandle);
      }
      const codes = Array.from({ length: 13 }, (_, index) =>
        String(100000 + index),
      )
        .filter((candidate) => candidate !== admitted.code)
        .slice(0, 12);
      const clients = await Promise.all(
        Array.from({ length: 4 }, () => fx.client(fx.owned.verifierUrl)),
      );
      try {
        const results = (
          await Promise.all(
            clients.map(async (client, worker) => {
              const outcomes: boolean[] = [];
              for (
                let index = worker;
                index < challenges.length;
                index += clients.length
              ) {
                const result = await client.query<{
                  decision: { allowed: boolean };
                }>(
                  "SELECT control_private.reserve_mfa($1::text,$2::text,$3::text) AS decision",
                  [challenges[index], admitted.jar.canonical, codes[index]],
                );
                outcomes.push(result.rows[0].decision.allowed);
              }
              return outcomes;
            }),
          )
        ).flat();
        // The real login already charged one; uncertain/inflight reservations count.
        expect(results.filter(Boolean)).toHaveLength(9);
        const row = await fx.migration.query<{ used: number }>(
          "SELECT used FROM control_private.budgets WHERE key_mac=control_private.mac('budget-account-mfa',$1)",
          [p.userId],
        );
        expect(row.rows[0].used).toBe(10);
      } finally {
        for (const client of clients) await fx.release(client);
      }
    },
  );

  scenario(
    "uses DB first-seen time rather than AUTH-createdAt for deny-only orphan cleanup",
    async () => {
      const p = await fx.createPrincipal();
      const sessions = await fx.auth.query<{ id: string }>(
        'SELECT id FROM identity."Session" WHERE "userId"=$1',
        [p.userId],
      );
      expect(sessions.rowCount).toBe(1);
      const sid = sessions.rows[0].id;
      await fx.auth.query(
        'UPDATE identity."Session" SET "createdAt"=clock_timestamp()+interval \'1 year\' WHERE id=$1',
        [sid],
      );
      await fx.migration.query(
        "UPDATE control_private.session_observations SET first_seen_at=clock_timestamp()-interval '6 minutes' WHERE session_id=$1",
        [sid],
      );
      expect(
        await sqlState(
          fx.worker,
          'DELETE FROM identity."Session" WHERE id=$1',
          [sid],
        ),
      ).toBe("42501");
      await fx.worker.query("SELECT audit.cleanup_control_orphans(100)");
      const row = await fx.migration.query<{ gone: boolean; retired: boolean }>(
        'SELECT NOT EXISTS(SELECT 1 FROM identity."Session" WHERE id=$1) AS gone,retired FROM control_private.session_observations WHERE session_id=$1',
        [sid],
      );
      expect(row.rows[0]).toEqual({ gone: true, retired: true });
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );

  scenario(
    "never lets orphan cleanup delete a live ready session",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      await fx.migration.query(
        "UPDATE control_private.session_observations SET first_seen_at=clock_timestamp()-interval '6 minutes' WHERE session_id=$1",
        [ready.sessionId],
      );
      await fx.worker.query("SELECT audit.cleanup_control_orphans(100)");
      const row = await fx.auth.query<{ present: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM identity."Session" WHERE id=$1) AS present',
        [ready.sessionId],
      );
      expect(row.rows[0].present).toBe(true);
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            ready.jar.header,
          )
        ).response.status,
      ).toBe(200);
    },
  );

  scenario(
    "expires proof rows without releasing a live 180-second code fingerprint",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      await fx.migration.query(
        `WITH boundary AS MATERIALIZED (SELECT clock_timestamp()-interval '31 seconds' AS reserved)
      UPDATE control_private.attempts SET reserved_at=boundary.reserved,
      deadline=least(primary_deadline,boundary.reserved+interval '30 seconds') FROM boundary WHERE evidence_handle=$1`,
        [ready.operation.evidenceHandle],
      );
      const original = await fx.migration.query<{ code_mac: Buffer }>(
        "SELECT code_mac FROM control_private.attempts WHERE evidence_handle=$1",
        [ready.operation.evidenceHandle],
      );
      await fx.worker.query("SELECT audit.expire_control_attempts(100)");
      const row = await fx.migration.query<{
        retained: boolean;
        horizon: boolean;
      }>(
        "SELECT EXISTS(SELECT 1 FROM control_private.replay_burns WHERE code_mac=$1) AS retained,EXISTS(SELECT 1 FROM control_private.replay_burns WHERE code_mac=$1 AND expires_at=reserved_at+interval '180 seconds') AS horizon",
        [original.rows[0].code_mac],
      );
      expect(row.rows[0]).toEqual({ retained: true, horizon: true });
    },
  );

  scenario(
    "checks finalization time after waiting for governance, not statement start",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      const blocker = await fx.client(fx.owned.migrationUrl);
      let pending:
        Promise<QueryResult<{ decision: { allowed: boolean } }>> | undefined;
      await blocker.query("BEGIN");
      try {
        await blocker.query(
          "SELECT 1 FROM staff.governance WHERE singleton FOR UPDATE",
        );
        // Time-boundary fixture on a genuinely ready operation; keep all SQL
        // reservation/deadline/replay equality constraints mutually consistent.
        await blocker.query(
          `WITH boundary AS MATERIALIZED (SELECT clock_timestamp()-interval '29.7 seconds' AS origin), changed AS (
        UPDATE control_private.attempts SET reserved_at=boundary.origin,
          deadline=least(primary_deadline,boundary.origin+interval '30 seconds') FROM boundary
        WHERE evidence_handle=$1 RETURNING code_mac,reserved_at)
        UPDATE control_private.replay_burns b SET reserved_at=c.reserved_at,expires_at=c.reserved_at+interval '180 seconds'
        FROM changed c WHERE b.code_mac=c.code_mac`,
          [ready.operation.evidenceHandle],
        );
        pending = fx.staff.query<{ decision: { allowed: boolean } }>(
          "SELECT staff.finalize_control($1::text,$2::text,$3::text) AS decision",
          [
            ready.operation.evidenceHandle,
            ready.sessionId,
            ready.jar.canonical,
          ],
        );
        await blocker.query("SELECT pg_sleep(0.45)");
        await blocker.query("COMMIT");
        const result = await pending;
        expect(result.rows[0].decision.allowed).toBe(false);
        expect(await countAdmissions(p.userId)).toBe(0);
      } finally {
        await blocker.query("ROLLBACK");
        if (pending) await pending;
        await fx.release(blocker);
      }
    },
  );

  scenario(
    "rejects excessive Node skew in either direction before SDK invocation",
    async () => {
      const p = await fx.createPrincipal(),
        primary = await fx.begin(p),
        code = await fx.code(p);
      const initial = await fx.auth.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM identity."Session" WHERE "userId"=$1',
        [p.userId],
      );
      for (const offset of [-6500, 6500]) {
        const actualNow = Date.now(),
          spy = vi.spyOn(Date, "now").mockReturnValue(actualNow + offset);
        try {
          expect(
            (await fx.subject.verifyTotp(code, primary.jar.header)).response
              .status,
          ).toBe(503);
        } finally {
          spy.mockRestore();
        }
      }
      const after = await fx.auth.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM identity."Session" WHERE "userId"=$1',
        [p.userId],
      );
      expect(initial.rows[0].count === after.rows[0].count).toBe(true);
      const operations = await fx.migration.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM control_private.attempts WHERE user_id=$1 AND operation_handle IS NOT NULL",
        [p.userId],
      );
      expect(operations.rows[0].count).toBe(0);
    },
  );

  scenario(
    "commits the clock rollback latch and fails closed until offline fixture restoration",
    async () => {
      const p = await fx.createPrincipal();
      try {
        await fx.migration.query(
          "UPDATE control_private.clock_state SET high_water=clock_timestamp()+interval '10 seconds' WHERE singleton",
        );
        expect((await fx.begin(p)).operation.response.status).toBe(503);
        const row = await fx.migration.query<{ frozen: boolean }>(
          "SELECT frozen FROM control_private.clock_state WHERE singleton",
        );
        expect(row.rows[0].frozen).toBe(true);
      } finally {
        await restoreClock();
      }
    },
  );

  scenario(
    "fails closed for a key-continuity mismatch without clearing replay state",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      try {
        await fx.migration.query(
          "UPDATE control_private.clock_state SET key_checksum=decode(repeat('00',32),'hex') WHERE singleton",
        );
        expect(
          (
            await fx.subject.finalize(
              ready.operation.evidenceHandle,
              ready.jar.header,
            )
          ).response.status,
        ).toBe(503);
        expect(await countAdmissions(p.userId)).toBe(0);
      } finally {
        await restoreClock();
      }
      const row = await fx.migration.query<{ burned: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM control_private.replay_burns b JOIN control_private.attempts a ON a.code_mac=b.code_mac WHERE a.evidence_handle=$1) AS burned",
        [ready.operation.evidenceHandle],
      );
      expect(row.rows[0].burned).toBe(true);
    },
  );

  scenario(
    "rejects runtime raw proof, key and admission authority",
    async () => {
      expect(
        await sqlState(
          fx.verifier,
          "SELECT key_bytes FROM control_private.secrets",
        ),
      ).toBe("42501");
      expect(
        await sqlState(
          fx.verifier,
          "SELECT control_private.mac('cookie','synthetic')",
        ),
      ).toBe("42501");
      expect(
        await sqlState(fx.staff, "SELECT control_private.clock_probe()"),
      ).toBe("42501");
      expect(
        await sqlState(fx.auth, "SELECT control_private.clock_probe()"),
      ).toBe("42501");
      expect(
        await sqlState(
          fx.worker,
          "SELECT staff.finalize_control($1::text,$2::text,$3::text)",
          [
            randomBytes(32).toString("hex"),
            "SyntheticSession",
            "fixture-only-private-channel",
          ],
        ),
      ).toBe("42501");
      expect(
        await sqlState(
          fx.verifier,
          "INSERT INTO staff.admissions DEFAULT VALUES",
        ),
      ).toBe("42501");
    },
  );

  scenario(
    "detects column-level credential privilege drift and restores it offline",
    async () => {
      const p = await fx.createPrincipal(),
        role = new URL(fx.owned.staffUrl).username;
      await fx.migration.query(
        `GRANT SELECT(password) ON identity."Account" TO "${role}"`,
      );
      try {
        expect((await fx.begin(p)).operation.response.status).toBe(503);
      } finally {
        await fx.migration.query(
          `REVOKE SELECT(password) ON identity."Account" FROM "${role}"`,
        );
      }
      expect((await fx.begin(p)).operation.response.status).toBe(200);
    },
  );

  scenario(
    "rejects an executable private-function overload even with the reviewed base name",
    async () => {
      const role = new URL(fx.owned.verifierUrl).username;
      await fx.migration.query(
        `CREATE FUNCTION control_private.reserve_mfa(text,text,text,boolean) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"allowed":false,"reason":"forbidden"}'::jsonb $$`,
      );
      await fx.migration.query(
        `GRANT EXECUTE ON FUNCTION control_private.reserve_mfa(text,text,text,boolean) TO "${role}"`,
      );
      let authority:
        Awaited<ReturnType<typeof createAdmissionAuthority>> | undefined;
      try {
        let rejected = false;
        try {
          authority = await createAdmissionAuthority({
            verifierUrl: fx.owned.verifierUrl,
            staffUrl: fx.owned.staffUrl,
          });
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
      } finally {
        await authority?.close();
        await fx.migration.query(
          "DROP FUNCTION control_private.reserve_mfa(text,text,text,boolean)",
        );
      }
    },
  );

  scenario(
    "normalizes trusted non-UTC database display timestamps without changing clock epochs",
    async () => {
      const p = await fx.createPrincipal();
      const name = fx.owned.name;
      if (!/^bookstore_security_test_[a-f0-9]{12}$/.test(name))
        throw new Error("Unexpected owned timezone fixture database.");
      const ownership = await fx.migration.query<{
        owned: boolean;
        no_override: boolean;
      }>(
        `SELECT
      current_database()=$1 AND pg_get_userbyid(d.datdba)=current_user AS owned,
      NOT EXISTS(SELECT 1 FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) item(value)
        WHERE s.setdatabase=d.oid AND s.setrole=0 AND lower(split_part(item.value,'=',1))='timezone') AS no_override
      FROM pg_database d WHERE d.datname=$1`,
        [name],
      );
      expect(ownership.rowCount).toBe(1);
      expect(ownership.rows[0]).toEqual({ owned: true, no_override: true });
      let factory:
        Awaited<ReturnType<ControlFixtures["newSubject"]>> | undefined;
      let authority:
        Awaited<ReturnType<typeof createAdmissionAuthority>> | undefined;
      let observed: Client | undefined;
      // USERSET display formatting only, inside this checked disposable database.
      // Never adjust clocks, host/global timezone, SDK Date, or security deadlines.
      await fx.migration.query(
        `ALTER DATABASE "${name}" SET timezone='Asia/Ho_Chi_Minh'`,
      );
      try {
        observed = await fx.client(fx.owned.verifierUrl);
        const raw = await observed.query<{
          decision: { allowed: boolean; databaseTime: unknown };
        }>("SELECT control_private.clock_probe() AS decision");
        expect(raw.rows[0].decision.allowed).toBe(true);
        expect(
          typeof raw.rows[0].decision.databaseTime === "string" &&
            /[+-](?!00:00$)\d{2}:\d{2}$/.test(
              raw.rows[0].decision.databaseTime,
            ),
        ).toBe(true);
        authority = await createAdmissionAuthority({
          verifierUrl: fx.owned.verifierUrl,
          staffUrl: fx.owned.staffUrl,
        });
        const normalized = await authority.clockProbe();
        expect(normalized.allowed).toBe(true);
        expect(
          typeof normalized.databaseTime === "string" &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
              normalized.databaseTime,
            ),
        ).toBe(true);
        factory = await fx.newSubject();
        const ready = await fx.ready(p, factory);
        expect(
          (
            await factory.finalize(
              ready.operation.evidenceHandle,
              ready.jar.header,
            )
          ).response.status,
        ).toBe(200);
        expect((await factory.check(ready.jar.header)).allowed).toBe(true);
      } finally {
        const closed = await Promise.allSettled([
          ...(authority ? [authority.close()] : []),
          ...(factory ? [fx.closeSubject(factory)] : []),
          ...(observed ? [fx.release(observed)] : []),
        ]);
        await fx.migration.query(`ALTER DATABASE "${name}" RESET timezone`);
        if (closed.some((result) => result.status === "rejected"))
          throw new Error("Timezone fixture cleanup failed.");
      }
    },
  );

  scenario(
    "checks readable runtime logs and restricted configuration visibility without extra privileges",
    async () => {
      for (const client of [fx.auth, fx.staff, fx.worker, fx.verifier]) {
        const logging = await client.query<{ safe: boolean }>(`SELECT
        current_setting('log_statement')='none'
        AND current_setting('log_min_error_statement')='panic'
        AND current_setting('log_parameter_max_length')='0'
        AND current_setting('log_parameter_max_length_on_error')='0'
        AND current_setting('log_duration')='off'
        AND current_setting('log_min_duration_statement')='-1'
        AND current_setting('log_min_duration_sample')='-1'
        AND current_setting('log_transaction_sample_rate')::numeric=0
        AND NOT EXISTS(SELECT 1 FROM pg_settings WHERE name LIKE 'pgaudit.%' OR name LIKE 'auto_explain.%')
        AND NOT EXISTS(SELECT 1 FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) config(value)
          WHERE s.setrole IN (0,(SELECT oid FROM pg_roles WHERE rolname=current_user))
          AND s.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
          AND split_part(config.value,'=',1) IN ('shared_preload_libraries','session_preload_libraries','local_preload_libraries')
          AND btrim(substring(config.value FROM position('=' IN config.value)+1),' "')<>'')
        AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
        AND NOT pg_has_role(current_user,'pg_read_all_settings','MEMBER') AS safe`);
        expect(logging.rows[0].safe).toBe(true);
        // Least privilege is deliberate: the actual protected shared-preload
        // value is inspected only by the owned offline hardener, not this role.
        expect(
          await sqlState(
            client,
            "SELECT current_setting('shared_preload_libraries')",
          ),
        ).toBe("42501");
        expect(
          await sqlState(
            client,
            "SELECT * FROM control_private.configuration_witness",
          ),
        ).toBe("42501");
      }
      const witness = await fx.migration.query<{ safe: boolean }>(`SELECT
        w.realm_id=s.realm_id AND w.postmaster_started_at=pg_postmaster_start_time()
        AND w.empty_preloads AND w.policy_version=1 AS safe
        FROM control_private.configuration_witness w JOIN control_private.secrets s USING(singleton)`);
      expect(witness.rowCount).toBe(1);
      expect(witness.rows[0].safe).toBe(true);
    },
  );

  scenario(
    "rejects stronger AUTH database logging overrides before SDK secrets and re-hardens them",
    async () => {
      const before = await fx.migration.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM audit.events WHERE action IN ('control.login','control.step_up')",
      );
      expect(await fx.checkDatabaseScopedAuthLoggingRegression()).toEqual({
        rejected: true,
        defaultsRestored: true,
        reopened: true,
      });
      const after = await fx.migration.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM audit.events WHERE action IN ('control.login','control.step_up')",
      );
      expect(after.rows[0].count === before.rows[0].count).toBe(true);
    },
  );

  scenario(
    "denies missing or stale offline configuration witnesses without resetting burns",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p);
      const witness = await fx.migration.query<{
        realm_id: string;
        postmaster_started_at: string;
      }>(
        "SELECT realm_id::text,postmaster_started_at::text FROM control_private.configuration_witness WHERE singleton",
      );
      expect(witness.rowCount).toBe(1);
      const original = witness.rows[0];
      try {
        await fx.migration.query(
          "UPDATE control_private.configuration_witness SET postmaster_started_at=postmaster_started_at-interval '1 second' WHERE singleton",
        );
        for (const missing of [false, true]) {
          if (missing)
            await fx.migration.query(
              "DELETE FROM control_private.configuration_witness WHERE singleton",
            );
          const probe = await fx.verifier.query<{
            decision: { allowed: boolean; reason: string };
          }>("SELECT control_private.clock_probe() AS decision");
          expect(probe.rows[0].decision.allowed).toBe(false);
          expect(probe.rows[0].decision.reason === "unavailable").toBe(true);
          expect(
            (
              await fx.subject.finalize(
                ready.operation.evidenceHandle,
                ready.jar.header,
              )
            ).response.status,
          ).toBe(503);
          let rejected = false;
          let authority:
            Awaited<ReturnType<typeof createAdmissionAuthority>> | undefined;
          try {
            authority = await createAdmissionAuthority({
              verifierUrl: fx.owned.verifierUrl,
              staffUrl: fx.owned.staffUrl,
            });
          } catch {
            rejected = true;
          } finally {
            await authority?.close();
          }
          expect(rejected).toBe(true);
          expect(await countAdmissions(p.userId)).toBe(0);
          const state = await fx.migration.query<{
            preserved: boolean;
            unfrozen: boolean;
          }>(
            `SELECT
          EXISTS(SELECT 1 FROM control_private.attempts a JOIN control_private.replay_burns b ON b.code_mac=a.code_mac
            WHERE a.evidence_handle=$1 AND a.state='ready' AND b.reserved_at=a.reserved_at AND b.expires_at=a.reserved_at+interval '180 seconds') AS preserved,
          NOT frozen AS unfrozen FROM control_private.clock_state WHERE singleton`,
            [ready.operation.evidenceHandle],
          );
          expect(state.rows[0]).toEqual({ preserved: true, unfrozen: true });
        }
      } finally {
        // OFFLINE test fixture restoration of the ORIGINAL hardener attestation.
        // Do not attest a new server process, restart PG or reset key/burn/clock.
        const restored = await fx.migration.query(
          `INSERT INTO control_private.configuration_witness(singleton,realm_id,postmaster_started_at,empty_preloads,policy_version)
        SELECT true,s.realm_id,$2::timestamptz,true,1 FROM control_private.secrets s
        WHERE s.singleton AND s.realm_id=$1::uuid AND pg_postmaster_start_time()=$2::timestamptz
        ON CONFLICT(singleton) DO UPDATE SET realm_id=EXCLUDED.realm_id,postmaster_started_at=EXCLUDED.postmaster_started_at,
          empty_preloads=EXCLUDED.empty_preloads,policy_version=EXCLUDED.policy_version`,
          [original.realm_id, original.postmaster_started_at],
        );
        expect(restored.rowCount).toBe(1);
      }
      const restoredProbe = await fx.verifier.query<{
        decision: { allowed: boolean };
      }>("SELECT control_private.clock_probe() AS decision");
      expect(restoredProbe.rows[0].decision.allowed).toBe(true);
      expect(
        (
          await fx.subject.finalize(
            ready.operation.evidenceHandle,
            ready.jar.header,
          )
        ).response.status,
      ).toBe(200);
    },
  );

  scenario(
    "rejects unsupported isolation rather than relying on an old snapshot",
    async () => {
      await fx.staff.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      try {
        expect(
          await sqlState(fx.staff, "SELECT staff.control_clock_probe()"),
        ).toBe("0A000");
      } finally {
        await fx.staff.query("ROLLBACK");
      }
    },
  );

  scenario(
    "survives real process replacement from persisted unclaimed primary without WeakMap authority",
    async () => {
      const p = await fx.createPrincipal(),
        preparer = await fx.newSubject();
      const primary = await fx.begin(p, preparer),
        code = await fx.code(p);
      expect(primary.operation.response.status).toBe(200);
      await fx.closeSubject(preparer);
      expect(
        await restartProbe("complete-allowed", fx.config, {
          cookie: primary.jar.header,
          code,
        }),
      ).toBe(0);
      expect(await countAdmissions(p.userId)).toBe(1);
    },
  );

  scenario(
    "consumes a real ready capability in a new process without reconstructing SDK success",
    async () => {
      const p = await fx.createPrincipal(),
        issuer = await fx.newSubject(),
        ready = await fx.ready(p, issuer);
      await fx.closeSubject(issuer);
      expect(
        await restartProbe("finalize-allowed", fx.config, {
          cookie: ready.jar.header,
          evidenceHandle: ready.operation.evidenceHandle!,
        }),
      ).toBe(0);
      expect(await countAdmissions(p.userId)).toBe(1);
    },
  );

  scenario(
    "denies the same user code after process replacement across a fresh challenge",
    async () => {
      const p = await fx.createPrincipal(),
        ready = await fx.ready(p),
        preparer = await fx.newSubject();
      const primary = await fx.begin(p, preparer);
      expect(primary.operation.response.status).toBe(200);
      await fx.closeSubject(preparer);
      expect(
        await restartProbe("verify-rejected", fx.config, {
          cookie: primary.jar.header,
          code: ready.code,
        }),
      ).toBe(0);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );
});
