import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  NEXT_AUTH_PATHS,
  SECURITY_PAGE,
} from "../../experiments/next-security/wire";
import {
  ControlFixtures,
  secretSafe,
  type SyntheticPrincipal,
} from "../admission-controls/fixtures";
import {
  createTransportCertificates,
  type TransportCertificateFixture,
} from "../https-transport/certificates";
import {
  nativeAction,
  nextConfig,
  NextWireClient,
  startNextProcess,
  type NextProcess,
  type NextWireResponse,
} from "../next-security/client";
import {
  createWorkerProcess,
  type WorkerProcess,
} from "../next-security/worker-client";

// ADR020 composition evidence: actual production-built Next and real SDK/PG over
// CA-validated Node HTTPS. Header replay is NOT Linux Chromium cookie/TLS proof.
// All operations below use the existing private helpers and fixed worker IPC.
const fx = new ControlFixtures();
const workers = new Set<WorkerProcess>();
const csrfSecret = randomBytes(48).toString("base64url");
let certs: TransportCertificateFixture;
let host: NextProcess | undefined;
const scenario = (name: string, work: () => Promise<void>) =>
  it(name, () => secretSafe(work));
const client = () => new NextWireClient(certs.ca);
const safe = (response: NextWireResponse) =>
  response.authorized && response.noStore && !response.location;
const admitted = (response: NextWireResponse) =>
  response.body.includes('data-live-guard="admitted-test-session"');
const denied = (response: NextWireResponse) =>
  response.body.includes('data-live-guard="denied-test-session"') &&
  !admitted(response);
type ActionRef = { id: string; csrf: string };
type References = { probe: ActionRef; revoke: ActionRef; signOut: ActionRef };
type CriticalEvent = { principal: SyntheticPrincipal; eventId: string };

async function references(wire: NextWireClient): Promise<References> {
  const page = await wire.page();
  expect(safe(page) && admitted(page) && page.cookies.length === 0).toBe(true);
  const probe = nativeAction(page.body, "probe");
  const revoke = nativeAction(page.body, "revoke-self");
  const signOut = nativeAction(page.body, "sign-out");
  if (!probe || !revoke || !signOut)
    throw new Error("Synthetic integrated Action references unavailable.");
  return { probe, revoke, signOut };
}
async function login(
  principal: SyntheticPrincipal,
  wire = client(),
  suppliedCode?: string,
) {
  const password = await wire.post("password", {
    email: principal.email,
    password: principal.password,
  });
  expect(
    password.status === 200 &&
      password.state === "mfa-required" &&
      safe(password),
  ).toBe(true);
  const code = suppliedCode ?? (await fx.code(principal));
  const completed = await wire.post("totp", { code });
  expect(
    completed.status === 200 &&
      completed.state === "verified-test-session" &&
      safe(completed) &&
      wire.jar.size === 1,
  ).toBe(true);
  return { wire, code, refs: await references(wire) };
}
async function lifetime(userId: string): Promise<string> {
  const rows = await fx.migration.query(
    `SELECT a.session_id,a.authenticated_at::text,a.last_seen_at::text,a.mfa_at::text,
      c.authenticated_at::text control_authenticated,c.absolute_deadline::text,c.epoch_id::text
      FROM staff.admissions a JOIN control_private.session_controls c USING(session_id)
      WHERE a.user_id=$1 ORDER BY a.session_id`,
    [userId],
  );
  return createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex");
}
async function operationWitness(): Promise<string> {
  const rows = await fx.migration.query(`SELECT jsonb_build_object(
    'budgets',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY key_mac),'[]'::jsonb) FROM control_private.budgets b),
    'clock',(SELECT to_jsonb(c) FROM control_private.clock_state c WHERE singleton),
    'admissions',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY session_id),'[]'::jsonb) FROM staff.admissions a),
    'principals',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY user_id),'[]'::jsonb) FROM staff.principals p),
    'sessions',(SELECT coalesce(jsonb_agg(jsonb_build_array(id,"userId","expiresAt","updatedAt") ORDER BY id),'[]'::jsonb) FROM identity."Session"),
    'factors',(SELECT coalesce(jsonb_agg(jsonb_build_array(id,"failedVerificationCount","lockedUntil") ORDER BY id),'[]'::jsonb) FROM identity."TwoFactor"),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY challenge_handle),'[]'::jsonb) FROM control_private.attempts a),
    'events',(SELECT count(*) FROM audit.events),
    'denials',(SELECT count(*) FROM audit.denials),
    'provider_events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb) FROM audit.provider_events e)) value`);
  // Private identifiers/MACs stay in memory; only a digest equality is asserted.
  return createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex");
}
async function worker(): Promise<WorkerProcess> {
  const value = await createWorkerProcess(fx.owned.workerUrl);
  workers.add(value);
  return value;
}
async function closeWorker(value: WorkerProcess): Promise<void> {
  await value.close();
  workers.delete(value);
}
async function deniedEverywhere(wire: NextWireClient, ref: ActionRef) {
  const [page, route, native, flight] = await Promise.all([
    wire.page(),
    wire.post("session"),
    wire.action(ref.id, ref.csrf),
    wire.action(ref.id, ref.csrf, {}, true),
  ]);
  expect(
    [page, route, native, flight].every(
      (response) => safe(response) && response.cookies.length === 0,
    ) &&
      page.status === 200 &&
      denied(page) &&
      route.status === 401 &&
      route.state === "denied" &&
      [403, 500].includes(native.status) &&
      [403, 500].includes(flight.status),
  ).toBe(true);
}
async function retireWithCriticalSourceChange(
  principal: SyntheticPrincipal,
): Promise<CriticalEvent> {
  // Compound denial evidence: this natural credential-relevant source change
  // retires the original generation/controls AND creates a critical ledger event.
  // It does NOT isolate the pending predicate from retirement. Metadata-only
  // Session updates cannot do so: immutable005 line176 suppresses that event.
  // Drain setup events ONLY before this source change; preserve their history.
  await fx.drain();
  await fx.auth.query('UPDATE identity."User" SET email=$2 WHERE id=$1', [
    principal.userId,
    `${randomUUID()}@example.invalid`,
  ]);
  const rows = await fx.migration.query<{ id: string }>(
    "SELECT id::text FROM audit.provider_events WHERE user_id=$1 AND invalidates_user AND state='pending'",
    [principal.userId],
  );
  expect(rows.rows.length).toBe(1);
  const critical = { principal, eventId: rows.rows[0].id };
  await expectCriticalState(critical, "pending", 0);
  return critical;
}
async function expectCriticalState(
  critical: CriticalEvent,
  state: "pending" | "blocked" | "processed",
  attempts: 0 | 1 | 2 | 3 | 4 | 5,
) {
  const { principal, eventId } = critical;
  const witness = await fx.migration.query<{ safe: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM audit.provider_events WHERE id=$5::bigint
        AND user_id=$1 AND invalidates_user AND state=$3 AND attempts=$4)
      AND EXISTS(SELECT 1 FROM control_private.approved_generations
        WHERE generation_id=$2 AND user_id=$1 AND retired)
      AND (SELECT count(*) FROM control_private.approved_generations WHERE user_id=$1)=1
      AND NOT EXISTS(SELECT 1 FROM control_private.approved_generations WHERE user_id=$1 AND NOT retired)
      AND NOT EXISTS(SELECT 1 FROM control_private.session_controls WHERE user_id=$1 AND NOT revoked)
      AND ($3<>'processed' OR NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$1)) AS safe`,
    [principal.userId, principal.generationId, state, attempts, eventId],
  );
  // Source retirement immediately revokes controls/generation, not necessarily
  // the retained admission row. Only successful reconciliation deletes that row.
  expect(witness.rows.length === 1 && witness.rows[0].safe === true).toBe(true);
}
async function authorizationVersion(userId: string): Promise<string> {
  const row = await fx.migration.query<{ version: string }>(
    "SELECT authz_version::text AS version FROM staff.principals WHERE user_id=$1",
    [userId],
  );
  if (row.rows.length !== 1)
    throw new Error("Synthetic integrated version witness unavailable.");
  return row.rows[0].version;
}

type SyntheticBarrier = {
  principal: SyntheticPrincipal;
  sessionId: string;
  eventId: string;
  facts: string;
};
async function otherwiseLiveSessionFacts(
  principal: SyntheticPrincipal,
  sessionId: string,
): Promise<string> {
  const rows = await fx.migration.query<{ safe: boolean; facts: unknown }>(
    `SELECT p.status='active' AND a.mode='verified' AND NOT c.revoked
      AND NOT g.retired AND NOT o.retired AND c.fingerprint=g.fingerprint
      AND a.authz_version=p.authz_version AND c.authz_version=p.authz_version
      AND p.permission_version=1 AND c.permission_version=1
      AND c.authenticated_at=a.authenticated_at
      AND a.authenticated_at<=clock_timestamp() AND a.last_seen_at<=clock_timestamp()
      AND a.last_seen_at+interval '30 minutes'>clock_timestamp()
      AND c.absolute_deadline>clock_timestamp() AND s."expiresAt">clock_timestamp()
      AND c.token_mac=o.token_mac AND c.token_mac=control_private.mac('session-token',s.token)
      AND u."emailVerified" AND u."twoFactorEnabled"
      AND EXISTS(SELECT 1 FROM identity."TwoFactor" WHERE "userId"=p.user_id AND verified)
      AND EXISTS(SELECT 1 FROM staff.governance WHERE singleton AND state='active') AS safe,
      jsonb_build_object('session',jsonb_build_array(s.id,s."userId",s."expiresAt",s."updatedAt",s."userAgent",s."ipAddress"),
        'user',jsonb_build_array(u.id,u.email,u."emailVerified",u."twoFactorEnabled"),
        'admission',to_jsonb(a),'control',to_jsonb(c),'observation',to_jsonb(o),
        'generation',to_jsonb(g),'principal',to_jsonb(p),
        'factors',(SELECT jsonb_agg(jsonb_build_array(id,verified,"failedVerificationCount","lockedUntil") ORDER BY id) FROM identity."TwoFactor" WHERE "userId"=p.user_id),
        'roles',(SELECT jsonb_agg(role_name ORDER BY role_name) FROM staff.role_grants WHERE user_id=p.user_id)) facts
      FROM identity."Session" s JOIN identity."User" u ON u.id=s."userId"
      JOIN staff.admissions a ON a.session_id=s.id AND a.user_id=s."userId"
      JOIN control_private.session_controls c ON c.session_id=s.id AND c.user_id=s."userId"
      JOIN control_private.session_observations o ON o.session_id=s.id AND o.user_id=s."userId"
      JOIN control_private.approved_generations g ON g.generation_id=c.generation_id AND g.user_id=s."userId"
      JOIN staff.principals p ON p.user_id=s."userId"
      WHERE s.id=$2 AND s."userId"=$1 AND g.generation_id=$3`,
    [principal.userId, sessionId, principal.generationId],
  );
  expect(rows.rows.length === 1 && rows.rows[0].safe === true).toBe(true);
  return createHash("sha256")
    .update(JSON.stringify(rows.rows[0].facts))
    .digest("hex");
}
async function installSyntheticLedgerBarrier(
  principal: SyntheticPrincipal,
): Promise<SyntheticBarrier> {
  await fx.drain();
  await assertOwnedMigrationBinding();
  const rights = await fx.migration.query<{ safe: boolean }>(
    "SELECT has_table_privilege('audit.provider_events','INSERT') AS safe",
  );
  if (rights.rows[0]?.safe !== true)
    throw new Error(
      "Owned offline ledger INSERT unavailable; no grant widened.",
    );
  const rows = await fx.migration.query<{ session_id: string }>(
    "SELECT session_id FROM staff.admissions WHERE user_id=$1 AND mode='verified'",
    [principal.userId],
  );
  expect(rows.rows.length).toBe(1);
  const sessionId = rows.rows[0].session_id;
  const facts = await otherwiseLiveSessionFacts(principal, sessionId);
  // SYNTHETIC OFFLINE LEDGER STIMULUS, NOT a native provider commit. Real user/SID
  // come only from this fixture's already SDK-finalized admission. This creates
  // denial state only, without changing provider/control/generation or ACLs.
  const inserted = await fx.migration.query<{ id: string }>(
    `INSERT INTO audit.provider_events(user_id,session_id,kind,invalidates_user)
      SELECT s."userId",s.id,'session.changed',false FROM identity."Session" s
      JOIN staff.admissions a ON a.session_id=s.id AND a.user_id=s."userId"
      WHERE s.id=$2 AND s."userId"=$1 AND a.mode='verified' RETURNING id::text`,
    [principal.userId, sessionId],
  );
  expect(inserted.rows.length).toBe(1);
  const barrier = { principal, sessionId, eventId: inserted.rows[0].id, facts };
  await expectSyntheticBarrier(barrier, "pending", 0);
  return barrier;
}
async function expectSyntheticBarrier(
  barrier: SyntheticBarrier,
  state: "pending" | "blocked",
  attempts: 0 | 1 | 2 | 3 | 4 | 5,
) {
  const rows = await fx.migration.query<{ safe: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM audit.provider_events WHERE id=$1::bigint
        AND user_id=$2 AND session_id=$3 AND kind='session.changed'
        AND NOT invalidates_user AND state=$4 AND attempts=$5)
      AND (SELECT count(*) FROM audit.provider_events WHERE user_id=$2
        AND state<>'processed' AND (invalidates_user OR session_id=$3))=1
      AND NOT EXISTS(SELECT 1 FROM audit.events WHERE transition_id=$1::bigint) AS safe`,
    [
      barrier.eventId,
      barrier.principal.userId,
      barrier.sessionId,
      state,
      attempts,
    ],
  );
  expect(rows.rows.length === 1 && rows.rows[0].safe === true).toBe(true);
  expect(
    (await otherwiseLiveSessionFacts(barrier.principal, barrier.sessionId)) ===
      barrier.facts,
  ).toBe(true);
}

async function assertOwnedMigrationBinding() {
  const suffix = /^bookstore_security_test_([a-f0-9]{12})$/.exec(
    fx.owned.name,
  )?.[1];
  if (!suffix) throw new Error("Owned integrated worker fixture unavailable.");
  const binding = await fx.migration.query<{ safe: boolean }>(
    `SELECT current_database()=$1 AND current_user::text=$2
      AND pg_get_userbyid(d.datdba)=$2
      AND shobj_description(d.oid,'pg_database') ~ $3 AS safe
      FROM pg_database d WHERE d.datname=current_database()`,
    [
      fx.owned.name,
      `bf_${suffix}_migrate`,
      `^bookstore-security-foundation:${suffix}:[a-f0-9]{32}$`,
    ],
  );
  if (binding.rows.length !== 1 || binding.rows[0].safe !== true)
    throw new Error("Owned integrated worker marker unavailable.");
}
async function withWorkerPersistenceFault(
  failRecorder: boolean,
  work: () => Promise<void>,
) {
  await assertOwnedMigrationBinding();
  let created = false,
    applyTrigger = false,
    recorderTrigger = false;
  try {
    await fx.migration.query(
      `CREATE FUNCTION public.b2e_composition_worker_fault() RETURNS trigger
        LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
        RAISE EXCEPTION 'Synthetic B2e integrated worker persistence fault' USING ERRCODE='P0001'; END $$`,
    );
    created = true;
    await fx.migration.query(
      "REVOKE ALL ON FUNCTION public.b2e_composition_worker_fault() FROM PUBLIC",
    );
    await fx.migration.query(
      `CREATE TRIGGER b2e_composition_apply_fault BEFORE INSERT ON audit.events
        FOR EACH ROW WHEN(NEW.action='provider.reconciled')
        EXECUTE FUNCTION public.b2e_composition_worker_fault()`,
    );
    applyTrigger = true;
    if (failRecorder) {
      // The existing failure recorder updates attempts, not audit.events. This
      // separate trigger makes THAT call fail after the apply already failed.
      await fx.migration.query(
        `CREATE TRIGGER b2e_composition_recorder_fault BEFORE UPDATE OF attempts ON audit.provider_events
          FOR EACH ROW WHEN(NEW.attempts IS DISTINCT FROM OLD.attempts)
          EXECUTE FUNCTION public.b2e_composition_worker_fault()`,
      );
      recorderTrigger = true;
    }
    await work();
  } finally {
    // Fixed invoker functions/triggers in this newly owned DB only. No runtime
    // grants, definer, clock-table trigger, CASCADE or repair capability.
    try {
      if (recorderTrigger)
        await fx.migration.query(
          "DROP TRIGGER b2e_composition_recorder_fault ON audit.provider_events",
        );
    } finally {
      try {
        if (applyTrigger)
          await fx.migration.query(
            "DROP TRIGGER b2e_composition_apply_fault ON audit.events",
          );
      } finally {
        if (created)
          await fx.migration.query(
            "DROP FUNCTION public.b2e_composition_worker_fault()",
          );
      }
    }
  }
}

async function denialIds(): Promise<ReadonlySet<string>> {
  const rows = await fx.migration.query<{ id: string }>(
    "SELECT id::text FROM audit.denials",
  );
  return new Set(rows.rows.map((row) => row.id));
}
async function exactNativeDenial(
  before: ReadonlySet<string>,
  principal: SyntheticPrincipal,
) {
  const rows = await fx.migration.query<{
    id: string;
    reason: string;
    outcome: string;
  }>("SELECT id::text,reason,outcome FROM audit.denials");
  expect(
    [...before].every((id) => rows.rows.some((row) => row.id === id)),
  ).toBe(true);
  const added = rows.rows.filter((row) => !before.has(row.id));
  expect(added.length).toBe(1);
  expect(
    added.every(
      (row) =>
        row.reason === "forbidden" &&
        row.outcome === "denied" &&
        row.id !== principal.userId &&
        row.id !== principal.generationId &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          row.id,
        ),
    ),
  ).toBe(true);
}
async function noGrant(principal: SyntheticPrincipal) {
  const witness = await fx.migration.query<{ safe: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$1)
      AND NOT EXISTS(SELECT 1 FROM control_private.session_controls WHERE user_id=$1)
      AND NOT EXISTS(SELECT 1 FROM control_private.attempts WHERE user_id=$1
        AND (evidence_handle IS NOT NULL OR state IN ('ready','consumed'))) AS safe`,
    [principal.userId],
  );
  expect(witness.rows.length === 1 && witness.rows[0].safe === true).toBe(true);
}
function redactedRouteFailure(
  response: NextWireResponse,
  principal: SyntheticPrincipal,
  additional: readonly string[],
) {
  const owner = host;
  if (!owner) throw new Error("Owned integrated Next log witness unavailable.");
  const forbidden = [
    principal.email,
    principal.password,
    principal.secret,
    principal.userId,
    principal.generationId,
    fx.secret,
    csrfSecret,
    ...additional,
  ].filter(Boolean);
  expect(
    response.status === 403 &&
      response.state === "denied" &&
      response.disabled &&
      safe(response) &&
      response.cookies.length === 0 &&
      forbidden.every(
        (value) => !response.body.includes(value) && !owner.logContains(value),
      ) &&
      !response.body.includes("evidenceHandle") &&
      !response.body.includes("rolled_back"),
  ).toBe(true);
}
async function closeProcesses() {
  const current = host;
  host = undefined;
  const results = await Promise.allSettled([
    ...(current ? [current.close()] : []),
    ...[...workers].map((value) => value.close()),
  ]);
  workers.clear();
  if (results.some((value) => value.status === "rejected"))
    throw new Error("Owned integrated Next cleanup unavailable.");
}

beforeAll(() =>
  secretSafe(async () => {
    certs = await createTransportCertificates();
    await fx.start();
  }),
);
beforeEach(() =>
  secretSafe(async () => {
    await fx.resetScenario();
    host = await startNextProcess(nextConfig(fx.config, certs, csrfSecret));
  }),
);
afterEach(() => secretSafe(closeProcesses));
afterAll(() =>
  secretSafe(async () => {
    try {
      await closeProcesses();
      await fx.stop();
    } finally {
      await certs?.close();
    }
  }),
);

describe("ADR020 actual Next HTTPS SDK/ALS/worker composition (Node, not browser)", () => {
  scenario(
    "negative Action/path/redirect corpus has zero actual outgoing requests and zero authority side effects",
    async () => {
      const principal = await fx.createPrincipal();
      const entry = await login(principal);
      if (!host) throw new Error("Owned integrated Next host unavailable.");
      // Known native and declared Next-Action Flight header are positive controls.
      for (const enhanced of [false, true]) {
        const positive = await entry.wire.action(
          entry.refs.probe.id,
          entry.refs.probe.csrf,
          {},
          enhanced,
        );
        expect(
          positive.status === 200 &&
            safe(positive) &&
            positive.cookies.length === 0,
        ).toBe(true);
      }
      const before = await operationWitness();
      const diagnostics = await host.diagnostics();
      const boundary = "B2eIntegratedNegativeBoundary";
      const field = (name: string, value: string, file = false) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file ? '; filename="synthetic.txt"' : ""}\r\n\r\n${value}\r\n`;
      const bodies = [
        field(`$ACTION_ID_${"f".repeat(40)}`, "") +
          field("csrf", entry.refs.probe.csrf),
        field("$ACTION_REF_0", "") + field("csrf", entry.refs.probe.csrf),
        field(`$ACTION_ID_${entry.refs.probe.id}`, "") +
          field("csrf", entry.refs.probe.csrf, true),
        field(`$ACTION_ID_${entry.refs.probe.id}`, "") +
          field("csrf", entry.refs.probe.csrf) +
          field("csrf", entry.refs.probe.csrf),
        field(`$ACTION_ID_${entry.refs.probe.id}`, "") +
          field("csrf", entry.refs.probe.csrf) +
          field("returnTo", "https://foreign.invalid/"),
      ];
      const responses: NextWireResponse[] = [];
      for (const body of bodies)
        responses.push(
          await entry.wire.send(SECURITY_PAGE, body + `--${boundary}--\r\n`, {
            method: "POST",
            headers: {
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
            },
          }),
        );
      responses.push(
        await entry.wire.action(
          "f".repeat(40),
          entry.refs.probe.csrf,
          {},
          true,
        ),
        await entry.wire.action(
          entry.refs.probe.id,
          entry.refs.probe.csrf,
          {},
          true,
          { actor: "synthetic-forged-actor" },
        ),
        await entry.wire.post(
          "session",
          {},
          {
            headers: { "Next-Action": entry.refs.probe.id },
          },
        ),
      );
      for (const path of [
        `${SECURITY_PAGE}?returnTo=https://foreign.invalid/`,
        `${SECURITY_PAGE}?_rsc=invalid&next=/`,
        "/__bookstore_next_security/other-page",
        "/__bookstore_next_auth/%73ession",
        `${NEXT_AUTH_PATHS.session}?callbackURL=//foreign.invalid`,
      ])
        responses.push(await entry.wire.send(path, "{}", { method: "POST" }));
      expect(
        responses.every(
          (response) =>
            response.status >= 400 &&
            response.status < 500 &&
            safe(response) &&
            response.cookies.length === 0,
        ),
      ).toBe(true);
      const after = await host.diagnostics();
      expect(
        diagnostics.servicePublications === 1 &&
          after.servicePublications === 1 &&
          diagnostics.outgoingHttpRequests === 0 &&
          after.outgoingHttpRequests === 0 &&
          after.ingressRequests - diagnostics.ingressRequests ===
            responses.length &&
          (await operationWitness()) === before,
      ).toBe(true);
    },
  );

  scenario(
    "same-account distinct sessions isolate mixed Route/RSC/native/Flight work, crossed nonces and self-revoke",
    async () => {
      const principal = await fx.createPrincipal();
      const first = await login(principal);
      const nextWindowCode = await fx.code(principal, 1);
      if (nextWindowCode === first.code)
        throw new Error(
          "Synthetic distinct maintained window code unavailable.",
        );
      const second = await login(principal, client(), nextWindowCode);
      expect(first.wire.jar.header !== second.wire.jar.header).toBe(true);
      const stamp = await lifetime(principal.userId);
      const mixed = await Promise.all([
        first.wire.action(first.refs.probe.id, first.refs.probe.csrf),
        second.wire.action(
          second.refs.probe.id,
          second.refs.probe.csrf,
          {},
          true,
        ),
        first.wire.post("session"),
        second.wire.page(),
        first.wire.page(),
        second.wire.post("session"),
        first.wire.action(first.refs.probe.id, first.refs.probe.csrf, {}, true),
        second.wire.action(second.refs.probe.id, second.refs.probe.csrf),
      ]);
      expect(
        mixed.every(
          (response) =>
            response.status === 200 &&
            safe(response) &&
            response.cookies.length === 0,
        ) &&
          admitted(mixed[3]) &&
          admitted(mixed[4]) &&
          (await lifetime(principal.userId)) === stamp,
      ).toBe(true);
      const beforeCrossed = await operationWitness();
      const crossed = await Promise.all([
        second.wire.action(first.refs.revoke.id, first.refs.revoke.csrf),
        first.wire.action(
          second.refs.revoke.id,
          second.refs.revoke.csrf,
          {},
          true,
        ),
        first.wire.action(first.refs.revoke.id, first.refs.probe.csrf),
        second.wire.action(
          second.refs.revoke.id,
          second.refs.signOut.csrf,
          {},
          true,
        ),
      ]);
      // Pinned native Action exceptions use generic500; raw policy denials use403.
      // Neither is a successful mutation, and neither may clear/replace cookies.
      expect(
        crossed.every(
          (response) =>
            [403, 500].includes(response.status) &&
            safe(response) &&
            response.cookies.length === 0,
        ) && (await operationWitness()) === beforeCrossed,
      ).toBe(true);
      const revoked = await first.wire.action(
        first.refs.revoke.id,
        first.refs.revoke.csrf,
        {},
        true,
      );
      expect(revoked.status === 200 && safe(revoked)).toBe(true);
      await deniedEverywhere(first.wire, first.refs.probe);
      const [otherPage, otherRoute, otherAction] = await Promise.all([
        second.wire.page(),
        second.wire.post("session"),
        second.wire.action(second.refs.probe.id, second.refs.probe.csrf),
      ]);
      const rows = await fx.migration.query<{ safe: boolean }>(
        `SELECT count(*)=2 AND count(*) FILTER(WHERE mode='verified')=1
        AND count(*) FILTER(WHERE mode='revoked')=1 AS safe
        FROM staff.admissions WHERE user_id=$1`,
        [principal.userId],
      );
      expect(
        admitted(otherPage) &&
          [otherPage, otherRoute, otherAction].every(
            (response) => response.status === 200 && safe(response),
          ) &&
          rows.rows[0]?.safe === true &&
          (await lifetime(principal.userId)) === stamp,
      ).toBe(true);
    },
  );

  scenario(
    "compound credential retirement plus pending to BLOCKED stays denied through Next and fresh worker selected0 is not repair",
    async () => {
      const principal = await fx.createPrincipal();
      const entry = await login(principal);
      const critical = await retireWithCriticalSourceChange(principal);
      const version = await authorizationVersion(principal.userId);
      await deniedEverywhere(entry.wire, entry.refs.probe);
      const first = await worker();
      await withWorkerPersistenceFault(false, async () => {
        for (const attempts of [1, 2, 3, 4, 5] as const) {
          const result = await first.runOnce();
          expect(
            result.status === "partial" &&
              result.selected === 1 &&
              result.applied === 0 &&
              result.skipped === 0 &&
              result.failed === 1 &&
              result.uncertain === 1 &&
              result.failureRecordCallsConfirmed === 1,
          ).toBe(true);
          await expectCriticalState(
            critical,
            attempts === 5 ? "blocked" : "pending",
            attempts,
          );
        }
        await deniedEverywhere(entry.wire, entry.refs.probe);
        expect((await authorizationVersion(principal.userId)) === version).toBe(
          true,
        );
      });
      await closeWorker(first);
      const fresh = await worker();
      const result = await fresh.runOnce();
      expect(
        result.status === "completed" &&
          result.selected === 0 &&
          result.applied === 0 &&
          result.failureRecordCallsConfirmed === 0 &&
          !Object.hasOwn(result, "healthy") &&
          !Object.hasOwn(result, "blocked"),
      ).toBe(true);
      await expectCriticalState(critical, "blocked", 5);
      await deniedEverywhere(entry.wire, entry.refs.probe);
      expect((await authorizationVersion(principal.userId)) === version).toBe(
        true,
      );
    },
  );

  scenario(
    "SYNTHETIC offline session.changed ledger alone denies otherwise-live session through pending BLOCKED and fresh worker selected0",
    async () => {
      const principal = await fx.createPrincipal();
      const entry = await login(principal);
      const barrier = await installSyntheticLedgerBarrier(principal);
      await deniedEverywhere(entry.wire, entry.refs.probe);
      await expectSyntheticBarrier(barrier, "pending", 0);
      const first = await worker();
      await withWorkerPersistenceFault(false, async () => {
        for (const attempts of [1, 2, 3, 4, 5] as const) {
          const result = await first.runOnce();
          expect(
            result.status === "partial" &&
              result.selected === 1 &&
              result.applied === 0 &&
              result.skipped === 0 &&
              result.failed === 1 &&
              result.uncertain === 1 &&
              result.failureRecordCallsConfirmed === 1,
          ).toBe(true);
          await expectSyntheticBarrier(
            barrier,
            attempts === 5 ? "blocked" : "pending",
            attempts,
          );
        }
        // Each apply attempted local invalidation, but its audit failure rolled
        // THAT transaction back. Original SDK session/control/generation stay live
        // in every other checked respect; only the ledger barrier denies access.
        await deniedEverywhere(entry.wire, entry.refs.probe);
        await expectSyntheticBarrier(barrier, "blocked", 5);
      });
      await closeWorker(first);
      const fresh = await worker();
      const result = await fresh.runOnce();
      expect(
        result.status === "completed" &&
          result.selected === 0 &&
          result.applied === 0 &&
          result.failed === 0 &&
          result.uncertain === 0 &&
          result.failureRecordCallsConfirmed === 0 &&
          !Object.hasOwn(result, "healthy") &&
          !Object.hasOwn(result, "blocked"),
      ).toBe(true);
      await deniedEverywhere(entry.wire, entry.refs.probe);
      await expectSyntheticBarrier(barrier, "blocked", 5);
    },
  );

  scenario(
    "reconcile plus failure-recorder outage honestly stays pending unavailable and a fresh worker never readmits",
    async () => {
      const principal = await fx.createPrincipal();
      const entry = await login(principal);
      const critical = await retireWithCriticalSourceChange(principal);
      const first = await worker();
      await withWorkerPersistenceFault(true, async () => {
        const result = await first.runOnce();
        expect(
          result.status === "unavailable" &&
            result.selected === 1 &&
            result.applied === 0 &&
            result.skipped === 0 &&
            result.failed === 1 &&
            result.uncertain === 1 &&
            result.failureRecordCallsConfirmed === 0 &&
            !Object.hasOwn(result, "rolledBack"),
        ).toBe(true);
        await expectCriticalState(critical, "pending", 0);
        await deniedEverywhere(entry.wire, entry.refs.probe);
      });
      await closeWorker(first);
      const fresh = await worker();
      const result = await fresh.runOnce();
      expect(
        result.status === "completed" &&
          result.selected === 1 &&
          result.applied === 1 &&
          result.failed === 0 &&
          result.uncertain === 0 &&
          result.failureRecordCallsConfirmed === 0,
      ).toBe(true);
      await expectCriticalState(critical, "processed", 0);
      await deniedEverywhere(entry.wire, entry.refs.probe);
    },
  );

  scenario(
    "Next password Route projects native failure while exactly one fixed redacted denial commits",
    async () => {
      const principal = await fx.createPrincipal();
      const wire = client();
      const before = await denialIds();
      const wrongPassword = `${principal.password}invalid`;
      const result = await wire.post("password", {
        email: principal.email,
        password: wrongPassword,
      });
      redactedRouteFailure(result, principal, [wrongPassword]);
      await noGrant(principal);
      await exactNativeDenial(before, principal);
      const witness = await fx.migration.query<{ safe: boolean }>(
        `SELECT (SELECT count(*) FROM control_private.attempts
        WHERE user_id=$1 AND state='prepared')=1
        AND (SELECT count(*) FROM audit.events WHERE subject_id=$1
          AND action='control.prepared')=1 AS safe`,
        [principal.userId],
      );
      expect(witness.rows[0]?.safe === true).toBe(true);
    },
  );

  scenario(
    "Next TOTP Route keeps native failure effect plus committed burn and exactly one denial without any grant",
    async () => {
      const principal = await fx.createPrincipal();
      const wire = client();
      const prepared = await wire.post("password", {
        email: principal.email,
        password: principal.password,
      });
      expect(prepared.status === 200 && safe(prepared)).toBe(true);
      const accepted = new Set([
        await fx.code(principal, -1),
        await fx.code(principal),
        await fx.code(principal, 1),
      ]);
      const invalid = ["000000", "000001", "000002", "000003"].find(
        (code) => !accepted.has(code),
      );
      if (!invalid)
        throw new Error("Synthetic integrated invalid code unavailable.");
      const before = await denialIds();
      const originalCookie = wire.jar.header;
      const result = await wire.post("totp", { code: invalid });
      redactedRouteFailure(result, principal, [
        invalid,
        originalCookie,
        ...originalCookie
          .split("; ")
          .map((part) => part.slice(part.indexOf("=") + 1)),
      ]);
      await noGrant(principal);
      await exactNativeDenial(before, principal);
      const witness = await fx.migration.query<{ safe: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM control_private.attempts a
          JOIN control_private.replay_burns b ON b.code_mac=a.code_mac
          WHERE a.user_id=$1 AND a.state='inflight' AND a.evidence_handle IS NULL
            AND b.reserved_at=a.reserved_at
            AND b.expires_at=b.reserved_at+interval '180 seconds'
            AND b.expires_at>clock_timestamp())
        AND EXISTS(SELECT 1 FROM identity."TwoFactor" WHERE "userId"=$1
          AND "failedVerificationCount"=1 AND "lockedUntil" IS NULL)
        AND (SELECT count(*) FROM control_private.budgets WHERE key_mac IN(
          control_private.mac('budget-account-mfa',$1::text),
          control_private.mac('budget-ip-mfa','unknown')) AND used=1)=2 AS safe`,
        [principal.userId],
      );
      expect(
        witness.rows[0]?.safe === true && wire.jar.header === originalCookie,
      ).toBe(true);
    },
  );
});
