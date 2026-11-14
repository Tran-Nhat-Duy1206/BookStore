import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { Client } from "pg";
import {
  assertFoundationBaseUrl,
  assertFoundationUrl,
} from "../../src/server/security/database-config";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createSecurityKernel } from "../../src/server/security/kernel";
import {
  ControlFixtures,
  secretSafe,
  type SyntheticPrincipal,
} from "../admission-controls/fixtures";

// ADR020 F-01: real canonical SDK admission, then the existing trusted TEST
// composition of the dormant kernel. No runtime resolver/provider/clock hook is
// added. These offline watermark mutations simulate an observed rollback fence;
// they are NOT OS-clock experiments, restore safety, or operational recovery.
const fx = new ControlFixtures();
const scenario = (name: string, run: () => Promise<void>) =>
  it(name, () => secretSafe(run));
type Kernel = ReturnType<typeof createSecurityKernel>;
const kernels = new Set<Kernel>();

beforeAll(() => secretSafe(() => fx.start()));
beforeEach(() => secretSafe(() => fx.resetScenario()));
afterEach(() =>
  secretSafe(async () => {
    // Covers failures during fixture preparation before a scenario's try block.
    for (const kernel of kernels) {
      await kernel.close();
      kernels.delete(kernel);
    }
  }),
);
afterAll(() => secretSafe(() => fx.stop()));

async function assertOwnedOfflineFixture(): Promise<void> {
  const binding = new URL(fx.owned.migrationUrl);
  const suffix = /^bookstore_security_test_([a-f0-9]{12})$/.exec(
    fx.owned.name,
  )?.[1];
  if (!suffix || binding.username !== `bf_${suffix}_migrate`)
    throw new Error("Integrated offline fixture binding rejected.");
  const result = await fx.migration.query<{ owned: boolean }>(
    `SELECT current_database()=$1 AND current_user=$2
      AND pg_get_userbyid(d.datdba)=$2
      AND shobj_description(d.oid,'pg_database') ~ $3
      AND shobj_description(r.oid,'pg_authid')=shobj_description(d.oid,'pg_database') AS owned
     FROM pg_database d JOIN pg_roles r ON r.rolname=$2 WHERE d.datname=$1`,
    [
      fx.owned.name,
      binding.username,
      `^bookstore-security-foundation:${suffix}:[a-f0-9]{32}$`,
    ],
  );
  if (result.rowCount !== 1 || result.rows[0]?.owned !== true)
    throw new Error("Integrated offline fixture ownership rejected.");
}

async function admittedKernel(role: "Owner" | "Analyst" = "Owner") {
  const principal = await fx.createPrincipal(role);
  // Generate ONLY with maintained utilities at actual time. Supplying this code
  // avoids ControlFixtures.code's temporary Date.now spy entirely in this suite.
  const code = await createOTP(base32.decode(principal.secret), {
    period: 30,
    digits: 6,
  }).totp();
  const admission = await fx.admitted(principal, code);
  const kernel = createSecurityKernel(fx.owned.staffUrl, async () => ({
    userId: principal.userId,
    sessionId: admission.sessionId,
  }));
  kernels.add(kernel);
  try {
    const baseline = await kernel.authorize("security.self.read");
    expect(baseline.allowed).toBe(true);
  } catch (error) {
    await kernel.close();
    throw error;
  }
  return { principal, admission, kernel };
}

async function frozen(): Promise<boolean> {
  const result = await fx.migration.query<{ frozen: boolean }>(
    "SELECT frozen FROM control_private.clock_state WHERE singleton",
  );
  if (result.rowCount !== 1)
    throw new Error("Integrated clock witness missing.");
  return result.rows[0].frozen;
}

async function setFutureWatermark(): Promise<void> {
  await assertOwnedOfflineFixture();
  const result = await fx.migration.query(
    "UPDATE control_private.clock_state SET high_water=clock_timestamp()+interval '10 seconds' WHERE singleton AND NOT frozen",
  );
  expect(result.rowCount === 1).toBe(true);
}

async function restoreOfflineClock(): Promise<void> {
  // Explicit test-fixture cleanup ONLY in the NEW run-owned disposable DB.
  // This is not a runtime capability, approved recovery or safe-restore claim.
  await assertOwnedOfflineFixture();
  const result = await fx.migration.query(
    `UPDATE control_private.clock_state c SET frozen=false,high_water=clock_timestamp(),
      realm_id=s.realm_id,key_checksum=s.key_checksum
     FROM control_private.secrets s WHERE c.singleton AND s.singleton`,
  );
  expect(result.rowCount === 1).toBe(true);
}

async function businessSnapshot(subjects: readonly string[]): Promise<string> {
  const result = await fx.migration.query<{ snapshot: string }>(
    `SELECT jsonb_build_object(
      'principals',(SELECT jsonb_agg(jsonb_build_array(user_id,status,authz_version,permission_version) ORDER BY user_id)
        FROM staff.principals WHERE user_id=ANY($1::text[])),
      'roles',(SELECT jsonb_agg(jsonb_build_array(user_id,role_name) ORDER BY user_id,role_name)
        FROM staff.role_grants WHERE user_id=ANY($1::text[])),
      'admissions',(SELECT jsonb_agg(jsonb_build_array(session_id,user_id,mode,authz_version,authenticated_at,last_seen_at,mfa_at) ORDER BY session_id)
        FROM staff.admissions WHERE user_id=ANY($1::text[])),
      'controls',(SELECT jsonb_agg(jsonb_build_array(session_id,user_id,revoked,authenticated_at,absolute_deadline) ORDER BY session_id)
        FROM control_private.session_controls WHERE user_id=ANY($1::text[])),
      'successAudit',(SELECT count(*) FROM audit.events WHERE subject_id=ANY($1::text[]))
     )::text AS snapshot`,
    [subjects],
  );
  if (result.rowCount !== 1)
    throw new Error("Integrated business witness missing.");
  // Private in-memory comparison only. Never assert or print this row/string.
  return result.rows[0].snapshot;
}

async function denialCounts() {
  const result = await fx.migration.query<{
    denied: number;
    rolled_back: number;
    unavailable: number;
  }>(
    `SELECT count(*) FILTER(WHERE outcome='denied')::int AS denied,
      count(*) FILTER(WHERE outcome='rolled_back')::int AS rolled_back,
      count(*) FILTER(WHERE outcome='unavailable')::int AS unavailable FROM audit.denials`,
  );
  return result.rows[0];
}

// TEST-ONLY ownership scope: clock_state is Guard-owned; Migrate DML does not
// confer CREATE/DROP TRIGGER ownership. Use the EXISTING supervisor bootstrap
// credential ONLY for these two literal trigger statements in this newly owned
// disposable DB. Never grant rights, transfer ownership, expose an admin client,
// or pass this credential/configuration into Next, a worker, or the kernel.
async function clockTrigger(action: "install" | "remove"): Promise<void> {
  await assertOwnedOfflineFixture();
  const migration = new URL(
    assertFoundationUrl(fx.owned.migrationUrl, "migrate"),
  );
  const bootstrap = new URL(
    assertFoundationBaseUrl(process.env.SECURITY_TEST_DATABASE_URL ?? ""),
  );
  const suffix = /^bookstore_security_test_([a-f0-9]{12})$/.exec(
    fx.owned.name,
  )?.[1];
  if (
    !suffix ||
    migration.pathname !== `/${fx.owned.name}` ||
    bootstrap.hostname !== migration.hostname ||
    bootstrap.port !== migration.port
  )
    throw new Error("Integrated trigger supervisor binding rejected.");
  bootstrap.pathname = `/${fx.owned.name}`;
  const admin = new Client({
    connectionString: bootstrap.toString(),
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    options:
      "-c application_name=bookstore-integrated-offline-trigger -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 -c log_duration=off -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 -c log_transaction_sample_rate=0",
  });
  try {
    await admin.connect();
    const marker = await admin.query<{ safe: boolean }>(
      `SELECT current_database()=$1 AND current_user='bookstore_security_bootstrap'
        AND session_user='bookstore_security_bootstrap'
        AND (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
        AND pg_get_userbyid(d.datdba)=$2
        AND shobj_description(d.oid,'pg_database') ~ $4
        AND shobj_description(m.oid,'pg_authid')=shobj_description(d.oid,'pg_database')
        AND shobj_description(g.oid,'pg_authid')=shobj_description(d.oid,'pg_database')
        AND NOT g.rolcanlogin AND NOT g.rolsuper AND NOT g.rolcreatedb
        AND NOT g.rolcreaterole AND NOT g.rolbypassrls AND NOT g.rolinherit
        AND NOT EXISTS(SELECT 1 FROM pg_auth_members a WHERE a.member=g.oid)
        AND c.relowner=g.oid
        AND current_setting('log_statement')='none'
        AND current_setting('log_min_error_statement')='panic'
        AND current_setting('log_parameter_max_length')='0'
        AND current_setting('log_parameter_max_length_on_error')='0'
        AND current_setting('log_duration')='off'
        AND current_setting('log_min_duration_statement')='-1'
        AND current_setting('log_min_duration_sample')='-1'
        AND current_setting('log_transaction_sample_rate')::numeric=0 AS safe
       FROM pg_database d JOIN pg_roles m ON m.rolname=$2
       JOIN pg_roles g ON g.rolname=$3
       JOIN pg_class c ON c.oid='control_private.clock_state'::regclass
       WHERE d.datname=$1`,
      [
        fx.owned.name,
        migration.username,
        `bf_${suffix}_guard`,
        `^bookstore-security-foundation:${suffix}:[a-f0-9]{32}$`,
      ],
    );
    if (marker.rowCount !== 1 || marker.rows[0]?.safe !== true)
      throw new Error("Integrated trigger supervisor attestation rejected.");
    if (action === "install") {
      await admin.query(`CREATE TRIGGER b2e_nested_clock_fixture
        BEFORE UPDATE OF high_water ON control_private.clock_state FOR EACH ROW
        EXECUTE FUNCTION public.b2e_nested_clock_fixture()`);
    } else {
      await admin.query(
        "DROP TRIGGER IF EXISTS b2e_nested_clock_fixture ON control_private.clock_state",
      );
    }
  } finally {
    await admin.end();
  }
}

async function installNestedFence(): Promise<void> {
  await assertOwnedOfflineFixture();
  // Guard runs this invoker trigger through its existing UPDATE privilege. NO
  // runtime grant, extra definer, configuration setting or production seam.
  // First high_water UPDATE stores a future value while clock_probe returns its
  // already-sampled n. The next nested guard sees it and updates frozen only;
  // UPDATE OF high_water therefore cannot fire a second time in this operation.
  await fx.migration
    .query(`CREATE FUNCTION public.b2e_nested_clock_fixture() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog AS $$
    BEGIN
      IF TG_TABLE_SCHEMA<>'control_private' OR TG_TABLE_NAME<>'clock_state'
        OR TG_OP<>'UPDATE' OR pg_trigger_depth()<>1 OR OLD.frozen OR NEW.frozen
        OR NEW.high_water IS NOT DISTINCT FROM OLD.high_water
        OR OLD.high_water>clock_timestamp() THEN
        RAISE EXCEPTION 'Integrated nested clock fixture guard rejected' USING ERRCODE='P0001';
      END IF;
      NEW.high_water=clock_timestamp()+interval '10 seconds';
      RETURN NEW;
    END $$`);
  await fx.migration.query(
    "REVOKE ALL ON FUNCTION public.b2e_nested_clock_fixture() FROM PUBLIC",
  );
  await clockTrigger("install");
}

async function removeNestedFence(): Promise<void> {
  await assertOwnedOfflineFixture();
  await clockTrigger("remove");
  await fx.migration.query(
    "DROP FUNCTION IF EXISTS public.b2e_nested_clock_fixture()",
  );
}

async function installAuditFault(kind: "denial" | "business"): Promise<void> {
  await assertOwnedOfflineFixture();
  // Names, table and WHEN grammar are fixed allowlisted fixture choices, never
  // caller SQL. Invoker trigger has no positive capability or secret payload.
  await fx.migration
    .query(`CREATE FUNCTION public.b2e_audit_fault_fixture() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog AS $$
    BEGIN RAISE EXCEPTION 'Integrated audit fixture fault' USING ERRCODE='P0001'; END $$`);
  await fx.migration.query(
    "REVOKE ALL ON FUNCTION public.b2e_audit_fault_fixture() FROM PUBLIC",
  );
  if (kind === "denial") {
    await fx.migration.query(`CREATE TRIGGER b2e_audit_fault_fixture
      BEFORE INSERT ON audit.denials FOR EACH ROW
      EXECUTE FUNCTION public.b2e_audit_fault_fixture()`);
  } else {
    await fx.migration.query(`CREATE TRIGGER b2e_audit_fault_fixture
      BEFORE INSERT ON audit.events FOR EACH ROW WHEN (NEW.action='principal.update')
      EXECUTE FUNCTION public.b2e_audit_fault_fixture()`);
  }
}

async function removeAuditFault(): Promise<void> {
  await assertOwnedOfflineFixture();
  await fx.migration.query(
    "DROP TRIGGER IF EXISTS b2e_audit_fault_fixture ON audit.denials",
  );
  await fx.migration.query(
    "DROP TRIGGER IF EXISTS b2e_audit_fault_fixture ON audit.events",
  );
  await fx.migration.query(
    "DROP FUNCTION IF EXISTS public.b2e_audit_fault_fixture()",
  );
}

async function cleanupScenario(
  kernel: Kernel,
  options: { nested?: boolean; audit?: boolean; clock?: boolean },
): Promise<void> {
  let nestedFailed = false,
    auditFailed = false,
    clockFailed = false,
    closeFailed = false;
  // Always attempt restoration/close even if exact trigger cleanup fails. Never
  // retry or widen rights; report only fixed failure labels, not raw SQL/rows.
  if (options.nested) {
    try {
      await removeNestedFence();
    } catch {
      nestedFailed = true;
    }
  }
  if (options.audit) {
    try {
      await removeAuditFault();
    } catch {
      auditFailed = true;
    }
  }
  if (options.clock) {
    try {
      await restoreOfflineClock();
    } catch {
      clockFailed = true;
    }
  }
  try {
    await kernel.close();
  } catch {
    closeFailed = true;
  }
  expect(nestedFailed, "Integrated cleanup: fixed nested trigger").toBe(false);
  expect(auditFailed, "Integrated cleanup: fixed audit trigger").toBe(false);
  expect(clockFailed, "Integrated cleanup: disposable clock restoration").toBe(
    false,
  );
  expect(closeFailed, "Integrated cleanup: owned kernel close").toBe(false);
}

async function immutableContinuityWitness(): Promise<string> {
  const roleNames = [
    "migrate",
    "reader",
    "auth",
    "staff",
    "worker",
    "verifier",
    "guard",
  ].map((purpose) =>
    new URL(fx.owned.migrationUrl).username.replace(/_migrate$/, `_${purpose}`),
  );
  const result = await fx.migration.query<{ witness: string }>(
    `SELECT encode(sha256(convert_to(jsonb_build_object(
      'key',(SELECT to_jsonb(s) FROM control_private.secrets s WHERE singleton),
      'configuration',(SELECT to_jsonb(w) FROM control_private.configuration_witness w WHERE singleton),
      'clockBinding',(SELECT jsonb_build_array(realm_id,key_checksum) FROM control_private.clock_state WHERE singleton),
      'roles',(SELECT jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolbypassrls,rolconfig) ORDER BY oid)
        FROM pg_roles WHERE rolname=ANY($1::text[])),
      'membership',(SELECT jsonb_agg(to_jsonb(m) ORDER BY roleid,member) FROM pg_auth_members m
        WHERE member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[]))),
      'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig) ORDER BY p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('staff','audit','control_private'))
      )::text,'UTF8')),'hex') AS witness`,
    [roleNames],
  );
  if (result.rowCount !== 1)
    throw new Error("Integrated continuity witness missing.");
  // Key bytes never leave PG; even the digest stays private/asserted as boolean.
  return createHash("sha256").update(result.rows[0].witness).digest("hex");
}

async function coldFrozenConstructor(): Promise<{
  naturalExit: boolean;
  oneFixedDenial: boolean;
}> {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    TSX_DISABLE_CACHE: "1",
    BOOKSTORE_FROZEN_STARTUP_CONFIG: JSON.stringify(fx.config),
  };
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "ComSpec",
    "PATHEXT",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        fileURLToPath(new URL("./frozen-restart-worker.ts", import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let messages = 0,
      valid = false,
      timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30000);
    child.on("message", (value: unknown) => {
      messages += 1;
      valid =
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).sort().join(",") === "denied,operation,v" &&
        "v" in value &&
        value.v === 1 &&
        "operation" in value &&
        value.operation === "security.frozen-startup-denied" &&
        "denied" in value &&
        value.denied === true;
    });
    child.once("error", () => {
      clearTimeout(deadline);
      reject(new Error("Integrated cold constructor child unavailable."));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      if (timedOut)
        reject(
          new Error(
            "Integrated cold constructor natural-exit deadline exceeded.",
          ),
        );
      else
        resolve({
          naturalExit: code === 0 && signal === null,
          oneFixedDenial: messages === 1 && valid,
        });
    });
  });
}

async function invokeFixedMutation(
  kind: "status" | "roles" | "revoke",
  kernel: Kernel,
  target: SyntheticPrincipal,
  actorSessionId: string,
) {
  switch (kind) {
    case "status":
      return kernel.setStatus(target.userId, "suspended");
    case "roles":
      return kernel.replaceRoles(target.userId, ["Owner"]);
    case "revoke":
      return kernel.revokeOwnSession(actorSessionId);
  }
}

describe("integrated dormant kernel denial-only clock continuity", () => {
  scenario(
    "persists a pre-guard future-watermark fence immediately without changing admitted business state",
    async () => {
      const actor = await admittedKernel();
      const subjects = [actor.principal.userId];
      const before = await businessSnapshot(subjects);
      try {
        await setFutureWatermark();
        const result = await actor.kernel.authorize("security.self.read");
        expect(!result.allowed && result.reason === "unavailable").toBe(true);
        // Baseline F-01 failure: old execute rolls this frozen update back.
        expect(await frozen()).toBe(true);
        expect((await businessSnapshot(subjects)) === before).toBe(true);
      } finally {
        await cleanupScenario(actor.kernel, { clock: true });
      }
    },
  );

  scenario(
    "retains the frozen gate after natural DB-clock catch-up and a genuine cold constructor process",
    async () => {
      const actor = await admittedKernel();
      const businessBefore = await businessSnapshot([actor.principal.userId]);
      const immutableBefore = await immutableContinuityWitness();
      try {
        await assertOwnedOfflineFixture();
        const future = await fx.migration.query<{ high_water: string }>(
          `UPDATE control_private.clock_state
           SET high_water=clock_timestamp()+interval '2 seconds'
           WHERE singleton AND NOT frozen RETURNING high_water::text`,
        );
        expect(future.rows.length).toBe(1);
        const first = await actor.kernel.authorize("security.self.read");
        expect(!first.allowed && first.reason === "unavailable").toBe(true);
        expect(await frozen()).toBe(true);
        const started = performance.now();
        let queries = 0,
          crossed = false,
          nextQueryAt = started;
        // Observe ACTUAL database time, bounded by BOTH5s/2000queries. Yield via
        // setImmediate (no sleep, OS clock control or Date.now monkeypatch).
        // A2ms observer cadence avoids exhausting the query cap before2s on a
        // fast local DB; it is NOT a security-policy/sample-threshold change.
        while (
          !crossed &&
          queries < 2000 &&
          performance.now() - started < 5000
        ) {
          if (performance.now() >= nextQueryAt) {
            const clock = await fx.migration.query<{ crossed: boolean }>(
              "SELECT clock_timestamp()>=$1::timestamptz AS crossed",
              [future.rows[0].high_water],
            );
            queries += 1;
            crossed = clock.rows[0]?.crossed === true;
            nextQueryAt = performance.now() + 2;
          }
          if (!crossed)
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(crossed && queries > 0 && queries <= 2000).toBe(true);
        expect(await frozen()).toBe(true);
        const warm = await actor.kernel.authorize("security.self.read");
        expect(!warm.allowed && warm.reason === "unavailable").toBe(true);
        expect((await immutableContinuityWitness()) === immutableBefore).toBe(
          true,
        );
        const cold = await coldFrozenConstructor();
        expect(cold.naturalExit && cold.oneFixedDenial).toBe(true);
        expect(await frozen()).toBe(true);
        expect((await immutableContinuityWitness()) === immutableBefore).toBe(
          true,
        );
        expect(
          (await businessSnapshot([actor.principal.userId])) === businessBefore,
        ).toBe(true);
        // Future-watermark SIMULATION + natural wall passage + cold constructor
        // denial proves this persisted gate only, NOT real OS rollback, physical
        // restore, universal constructor-fault attribution or safe recovery.
      } finally {
        await cleanupScenario(actor.kernel, { clock: true });
      }
    },
  );

  for (const kind of ["status", "roles", "revoke"] as const) {
    scenario(
      `persists the nested ${kind} guard fence without committing business mutation or success audit`,
      async () => {
        const actor = await admittedKernel();
        const target = await fx.createPrincipal();
        const subjects = [actor.principal.userId, target.userId];
        const before = await businessSnapshot(subjects);
        const denialsBefore = await denialCounts();
        try {
          await installNestedFence();
          const result = await invokeFixedMutation(
            kind,
            actor.kernel,
            target,
            actor.admission.sessionId,
          );
          expect(!result.allowed && result.reason === "unavailable").toBe(true);
          // No subject/facade call occurs between trigger installation and the
          // fixed kernel operation. Initial probe returns allowed, nested false
          // is the only path to unavailable without throwing in this fixture.
          expect(await frozen()).toBe(true);
          expect((await businessSnapshot(subjects)) === before).toBe(true);
          const denialsAfter = await denialCounts();
          expect(denialsAfter.unavailable - denialsBefore.unavailable).toBe(1);
          expect(denialsAfter.rolled_back - denialsBefore.rolled_back).toBe(0);
        } finally {
          await cleanupScenario(actor.kernel, { nested: true, clock: true });
        }
      },
    );
  }

  scenario(
    "retains a committed denial fence when the separate denial audit sink fails",
    async () => {
      const actor = await admittedKernel();
      const subjects = [actor.principal.userId];
      const before = await businessSnapshot(subjects);
      const denialsBefore = await denialCounts();
      try {
        await setFutureWatermark();
        await installAuditFault("denial");
        const result = await actor.kernel.authorize("security.self.read");
        expect(!result.allowed && result.reason === "unavailable").toBe(true);
        expect(await frozen()).toBe(true);
        expect((await businessSnapshot(subjects)) === before).toBe(true);
        const denialsAfter = await denialCounts();
        expect(denialsAfter.unavailable - denialsBefore.unavailable).toBe(0);
        expect(
          actor.kernel.getOperationalStatus().denialEvidenceUnavailable,
        ).toBe(true);
      } finally {
        await cleanupScenario(actor.kernel, { audit: true, clock: true });
      }
    },
  );

  scenario(
    "still rolls back a permitted business mutation when its success audit raises",
    async () => {
      const actor = await admittedKernel();
      const target = await fx.createPrincipal();
      const subjects = [actor.principal.userId, target.userId];
      const before = await businessSnapshot(subjects);
      const denialsBefore = await denialCounts();
      try {
        await installAuditFault("business");
        const result = await actor.kernel.setStatus(target.userId, "suspended");
        expect(!result.allowed && result.reason === "unavailable").toBe(true);
        expect((await businessSnapshot(subjects)) === before).toBe(true);
        expect(await frozen()).toBe(false);
        const denialsAfter = await denialCounts();
        expect(denialsAfter.rolled_back - denialsBefore.rolled_back).toBe(1);
      } finally {
        await cleanupScenario(actor.kernel, { audit: true });
      }
    },
  );

  scenario(
    "classifies a canonical permission denial as denied rather than uncertain business commit",
    async () => {
      const actor = await admittedKernel("Analyst");
      const target = await fx.createPrincipal();
      const subjects = [actor.principal.userId, target.userId];
      const before = await businessSnapshot(subjects);
      const denialsBefore = await denialCounts();
      try {
        const result = await actor.kernel.setStatus(target.userId, "suspended");
        expect(
          !result.allowed &&
            result.reason === "forbidden" &&
            result.status === 403,
        ).toBe(true);
        expect((await businessSnapshot(subjects)) === before).toBe(true);
        expect(await frozen()).toBe(false);
        const denialsAfter = await denialCounts();
        expect(denialsAfter.denied - denialsBefore.denied).toBe(1);
        expect(denialsAfter.unavailable - denialsBefore.unavailable).toBe(0);
        expect(denialsAfter.rolled_back - denialsBefore.rolled_back).toBe(0);
      } finally {
        await actor.kernel.close();
      }
    },
  );
});

// Evidence gaps intentionally NOT hidden by runtime client/callback seams:
// malformed SQL output after DML and lost/ambiguous COMMIT responses require a
// separately reviewed unit/wire fault harness. These real-PG scenarios do not
// claim either fault is executed, or actual OS rollback/whole-DB restore safety.
