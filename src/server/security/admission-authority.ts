import "server-only";

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool, type PoolClient } from "pg";
import { assertFoundationUrl } from "./database-config";
import { validateControlClockSample } from "./control-clock";

// Dormant internal positive issuer. SQL credentials authenticate this trusted
// authority; this module does NOT independently prove that an SDK call occurred.
// No application composition, public handler, configurable SQL or injected clock.
const reasons = [
  "allowed",
  "forbidden",
  "stale",
  "replay",
  "rate_limited",
  "expired",
  "unavailable",
  "unauthenticated",
] as const;
export type ControlDecisionReason = (typeof reasons)[number];
export type ReadonlyControlDecision = Readonly<{
  allowed: boolean;
  reason: ControlDecisionReason;
  challengeHandle?: string;
  operationHandle?: string;
  evidenceHandle?: string;
  userId?: string;
  sessionId?: string;
  authorizationVersion?: number;
  factorIds?: readonly string[];
  purpose?: "login" | "step_up";
  deadline?: string;
  databaseTime?: string;
  realmId?: string;
  roles?: readonly string[];
}>;
const fixedRoles = [
  "Owner",
  "CatalogManager",
  "Editor",
  "Publisher",
  "InventoryManager",
  "Analyst",
];
const issuerSignatures = [
  "control_private.clock_probe()",
  "control_private.prepare_password(text,text)",
  "control_private.bind_primary(text,text)",
  "control_private.resume_primary(text)",
  "control_private.prepare_step_up(text,text,text,text)",
  "control_private.reserve_mfa(text,text,text)",
  "control_private.issue_evidence(text,text,text)",
];
const handle = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const opaque = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const cookie = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 16384 &&
  !/[\x00-\x1f\x7f]/.test(value);
const version = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const deny = (reason: ControlDecisionReason): ReadonlyControlDecision =>
  Object.freeze({ allowed: false, reason });

// Trusted SQL output normalization only, never accepted as a caller clock input.
// PostgreSQL JSON timestamptz honors the server/session timezone. Normalize a
// strict signed-offset envelope by absolute epoch; do not require the DB to emit
// UTC already or mistake a timezone representation for excessive clock skew.
function databaseIso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    return null;
  if (
    typeof value === "string" &&
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/.test(
      value,
    )
  )
    return null;
  const millis = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(millis) || millis < 0) return null;
  try {
    return new Date(millis).toISOString();
  } catch {
    return null;
  }
}
function project(value: unknown): ReadonlyControlDecision {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return deny("unavailable");
  const input = value as Record<string, unknown>;
  if (
    typeof input.allowed !== "boolean" ||
    !reasons.some((reason) => reason === input.reason) ||
    input.allowed !== (input.reason === "allowed")
  )
    return deny("unavailable");
  const out: Record<string, unknown> = {
    allowed: input.allowed,
    reason: input.reason,
  };
  for (const name of [
    "challengeHandle",
    "operationHandle",
    "evidenceHandle",
  ] as const) {
    if (input[name] === undefined) continue;
    if (!handle(input[name])) return deny("unavailable");
    out[name] = input[name];
  }
  for (const name of ["userId", "sessionId"] as const) {
    if (input[name] === undefined) continue;
    if (!opaque(input[name])) return deny("unavailable");
    out[name] = input[name];
  }
  if (input.authorizationVersion !== undefined) {
    if (!version(input.authorizationVersion)) return deny("unavailable");
    out.authorizationVersion = input.authorizationVersion;
  }
  for (const name of ["deadline", "databaseTime"] as const) {
    if (input[name] === undefined) continue;
    const iso = databaseIso(input[name]);
    if (!iso) return deny("unavailable");
    out[name] = iso;
  }
  if (input.realmId !== undefined) {
    if (
      typeof input.realmId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        input.realmId,
      )
    )
      return deny("unavailable");
    out.realmId = input.realmId;
  }
  if (input.purpose !== undefined) {
    if (input.purpose !== "login" && input.purpose !== "step_up")
      return deny("unavailable");
    out.purpose = input.purpose;
  }
  if (input.factorIds !== undefined) {
    if (
      !Array.isArray(input.factorIds) ||
      input.factorIds.length > 32 ||
      !input.factorIds.every(opaque)
    )
      return deny("unavailable");
    out.factorIds = Object.freeze([...input.factorIds]);
  }
  if (input.roles !== undefined) {
    if (
      !Array.isArray(input.roles) ||
      input.roles.length > 6 ||
      !input.roles.every(
        (role) => typeof role === "string" && fixedRoles.includes(role),
      )
    )
      return deny("unavailable");
    out.roles = Object.freeze([...input.roles]);
  }
  // Deliberately drop all unrecognized/private SQL keys, never spread raw JSON.
  return Object.freeze(out) as ReadonlyControlDecision;
}

type Role = "verifier" | "staff";
type Outcome = "denied" | "rolled_back" | "unavailable";

export async function createAdmissionAuthority(config: {
  verifierUrl: string;
  staffUrl: string;
}) {
  let verifierUrl: string, staffUrl: string;
  try {
    if (
      !config ||
      Object.getPrototypeOf(config) !== Object.prototype ||
      Reflect.ownKeys(config).length !== 2 ||
      !["verifierUrl", "staffUrl"].every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(config, key);
        return (
          descriptor &&
          "value" in descriptor &&
          typeof descriptor.value === "string"
        );
      })
    )
      throw new Error();
    verifierUrl = assertFoundationUrl(config.verifierUrl, "verifier");
    staffUrl = assertFoundationUrl(config.staffUrl, "staff");
    const v = new URL(verifierUrl),
      s = new URL(staffUrl);
    if (
      v.hostname !== s.hostname ||
      v.port !== s.port ||
      v.pathname !== s.pathname
    )
      throw new Error();
  } catch {
    throw new Error("invalid dormant authority configuration");
  }
  const pools = {
    verifier: new Pool({
      connectionString: verifierUrl,
      // A fixed nonempty USERSET option prevents pg's PGOPTIONS env fallback.
      options: "-c application_name=bookstore-dormant-controls",
      max: 3,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    }),
    staff: new Pool({
      connectionString: staffUrl,
      options: "-c application_name=bookstore-dormant-controls",
      max: 2,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    }),
  };
  pools.verifier.on("error", () => {});
  pools.staff.on("error", () => {});
  let closed = false;
  let closePromise: Promise<void> | undefined;

  async function metadata(client: PoolClient, role: Role) {
    const url = new URL(role === "verifier" ? verifierUrl : staffUrl);
    const result = await client.query(
      `SELECT
      current_user AS current_name,session_user AS session_name,current_database() AS database_name,
      r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolinherit,r.rolcanlogin,
      EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS membership,
      has_database_privilege(current_database(),'CREATE') OR has_database_privilege(current_database(),'TEMP') AS db_create,
      EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege(n.oid,'CREATE')) AS schema_create,
      coalesce((SELECT has_schema_privilege(n.oid,'USAGE') FROM pg_namespace n WHERE n.nspname='control_private'),false) AS private_usage,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('identity','control_private') AND c.relkind IN ('r','p','v','m','f')
        AND (has_any_column_privilege(c.oid,'SELECT,INSERT,UPDATE,REFERENCES') OR has_table_privilege(c.oid,'DELETE,TRUNCATE,TRIGGER'))) AS private_table_rights,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('staff','audit') AND c.relkind IN ('r','p','v','m','f')
        AND has_any_column_privilege(c.oid,'SELECT')) AS staff_read,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('staff','audit') AND c.relkind IN ('r','p','v','m','f')
        AND (has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') OR has_table_privilege(c.oid,'DELETE,TRUNCATE,TRIGGER'))) AS staff_dml,
      EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        JOIN pg_roles owner_role ON owner_role.oid=p.proowner
        WHERE n.nspname='control_private' AND has_function_privilege(p.oid,'EXECUTE')
        AND (NOT(p.oid=ANY(ARRAY(SELECT to_regprocedure(signature)::oid FROM unnest($1::text[]) signature)))
          OR p.proargtypes::text IS DISTINCT FROM CASE p.proname
            WHEN 'clock_probe' THEN '' WHEN 'prepare_password' THEN '25 25'
            WHEN 'bind_primary' THEN '25 25' WHEN 'resume_primary' THEN '25'
            WHEN 'prepare_step_up' THEN '25 25 25 25'
            WHEN 'reserve_mfa' THEN '25 25 25' WHEN 'issue_evidence' THEN '25 25 25'
            ELSE NULL END
          OR p.prorettype<>3802 OR NOT p.prosecdef OR p.prokind<>'f'
          OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
          OR owner_role.rolname<>$2 OR owner_role.rolcanlogin
          OR owner_role.rolsuper OR owner_role.rolcreatedb OR owner_role.rolcreaterole
          OR owner_role.rolbypassrls)) AS unexpected_private_exec,
      (SELECT count(*)::integer FROM unnest($1::text[]) signature WHERE to_regprocedure(signature) IS NOT NULL AND has_function_privilege(to_regprocedure(signature),'EXECUTE')) AS issuer_exec_count,
      current_setting('log_statement') AS log_statement,
      current_setting('log_min_error_statement') AS log_min_error_statement,
      current_setting('log_parameter_max_length') AS log_parameter_max_length,
      current_setting('log_parameter_max_length_on_error') AS log_parameter_max_length_on_error,
      current_setting('log_duration') AS log_duration,
      current_setting('log_min_duration_statement') AS log_min_duration_statement,
      current_setting('log_min_duration_sample') AS log_min_duration_sample,
      current_setting('log_transaction_sample_rate') AS log_transaction_sample_rate,
      EXISTS(SELECT 1 FROM pg_db_role_setting d CROSS JOIN LATERAL unnest(d.setconfig) setting
         WHERE d.setrole IN (0,r.oid) AND d.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
         AND setting ~* '^(shared|session|local)_preload_libraries='
         AND substring(setting FROM position('=' IN setting)+1)<>'') AS unsafe_preload_defaults,
      EXISTS(SELECT 1 FROM pg_settings WHERE name LIKE 'pgaudit.%' OR name LIKE 'auto_explain.%') AS unexpected_logging
      FROM pg_roles r WHERE r.rolname=current_user`,
      [
        role === "verifier" ? issuerSignatures : [],
        url.username.replace(/_(?:verifier|staff)$/, "_guard"),
      ],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.current_name !== url.username ||
      row.session_name !== url.username ||
      row.database_name !== url.pathname.slice(1) ||
      !row.rolcanlogin ||
      row.rolsuper ||
      row.rolcreatedb ||
      row.rolcreaterole ||
      row.rolbypassrls ||
      row.rolinherit ||
      row.membership ||
      row.db_create ||
      row.schema_create ||
      row.private_table_rights ||
      row.staff_dml ||
      (role === "verifier" && row.staff_read) ||
      row.private_usage !== (role === "verifier") ||
      row.unexpected_private_exec ||
      row.issuer_exec_count !==
        (role === "verifier" ? issuerSignatures.length : 0) ||
      row.log_statement !== "none" ||
      row.log_min_error_statement !== "panic" ||
      row.log_parameter_max_length !== "0" ||
      row.log_parameter_max_length_on_error !== "0" ||
      row.log_duration !== "off" ||
      row.log_min_duration_statement !== "-1" ||
      row.log_min_duration_sample !== "-1" ||
      Number(row.log_transaction_sample_rate) !== 0 ||
      row.unsafe_preload_defaults ||
      row.unexpected_logging
    )
      throw new Error("metadataUnavailable");
  }
  async function checked<T>(
    role: Role,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new Error("metadataUnavailable");
    const client = await pools[role].connect();
    try {
      await metadata(client, role);
      return await work(client);
    } finally {
      client.release();
    }
  }
  async function probe(
    client: PoolClient,
    role: Role,
  ): Promise<ReadonlyControlDecision> {
    const before = Date.now(),
      start = performance.now();
    // AUTOCOMMIT: a SQL false/latch result must commit before JS rejects it.
    const response = await client.query(
      role === "verifier"
        ? "SELECT control_private.clock_probe() AS decision"
        : "SELECT staff.control_clock_probe() AS decision",
    );
    const elapsed = performance.now() - start,
      after = Date.now();
    const raw = response.rows[0]?.decision;
    const decision = project(raw);
    if (!decision.allowed || !decision.databaseTime)
      return deny(decision.allowed ? "unavailable" : decision.reason);
    // ISO normalization truncates PG microseconds. Conservatively include that
    // lost precision in the sample envelope rather than use a midpoint/rounding
    // to admit a fractional out-of-bound offset at the inclusive skew boundary.
    const fraction =
      typeof raw?.databaseTime === "string"
        ? /\.(\d{4,6})(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/.exec(
            raw.databaseTime,
          )?.[1]
        : undefined;
    const uncertainty = fraction && /[1-9]/.test(fraction.slice(3)) ? 1 : 0;
    const quality = validateControlClockSample({
      nodeBeforeMs: before - uncertainty,
      nodeAfterMs: after + uncertainty,
      monotonicElapsedMs: elapsed,
      databaseTime: decision.databaseTime,
    });
    return quality.valid ? decision : deny("unavailable");
  }
  async function recordDenial(
    reason: ControlDecisionReason,
    outcome: Outcome,
  ): Promise<boolean> {
    try {
      await checked("staff", async (client) => {
        await client.query(
          "SELECT audit.record_denial($1::uuid,$2::text,$3::text)",
          [
            randomUUID(),
            reason === "unavailable"
              ? "unavailable"
              : reason === "stale"
                ? "stale"
                : "forbidden",
            outcome,
          ],
        );
      });
      return true;
    } catch {
      return false;
    }
  }
  function failureOutcome(error: unknown): Outcome {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code: unknown }).code
        : null;
    return typeof code === "string" &&
      /^[A-Z0-9]{5}$/.test(code) &&
      !code.startsWith("08") &&
      !["40003", "57P01", "57P02", "57P03"].includes(code)
      ? "rolled_back"
      : "unavailable";
  }
  async function call(
    role: Role,
    sql: string,
    args: unknown[],
    valid: boolean,
    clockOnly = false,
  ): Promise<ReadonlyControlDecision> {
    if (!valid) {
      return (await recordDenial("forbidden", "denied"))
        ? deny("forbidden")
        : deny("unavailable");
    }
    let decision: ReadonlyControlDecision;
    try {
      decision = await checked(role, async (client) => {
        const clock = await probe(client, role);
        if (!clock.allowed || clockOnly) return clock;
        const response = await client.query(sql, args);
        return project(response.rows[0]?.decision);
      });
    } catch (error) {
      // All held statements/connections have settled and been released first.
      const outcome = failureOutcome(error);
      try {
        await checked(role, (client) => probe(client, role));
      } catch {
        /* best-effort durable latch */
      }
      await recordDenial("unavailable", outcome);
      return deny("unavailable");
    }
    if (
      !decision.allowed &&
      !(await recordDenial(
        decision.reason,
        decision.reason === "unavailable" ? "unavailable" : "denied",
      ))
    )
      return deny("unavailable");
    return decision;
  }
  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      const outcomes = await Promise.allSettled([
        pools.verifier.end(),
        pools.staff.end(),
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected"))
        throw new Error("dormant authority close unavailable");
    })();
    return closePromise;
  }
  try {
    await Promise.all([
      checked("verifier", async (client) => {
        if (!(await probe(client, "verifier")).allowed)
          throw new Error("metadataUnavailable");
      }),
      checked("staff", async (client) => {
        if (!(await probe(client, "staff")).allowed)
          throw new Error("metadataUnavailable");
      }),
    ]);
  } catch {
    await close().catch(() => {});
    throw new Error("metadataUnavailable");
  }
  return Object.freeze({
    clockProbe: () =>
      call(
        "verifier",
        "SELECT control_private.clock_probe() AS decision",
        [],
        true,
        true,
      ),
    preparePassword: (email: unknown) => {
      const valid =
        typeof email === "string" &&
        email.length <= 254 &&
        /^[A-Za-z0-9._+-]+@example\.invalid$/i.test(email);
      return call(
        "verifier",
        "SELECT control_private.prepare_password($1::text,'unknown'::text) AS decision",
        [typeof email === "string" ? email.toLowerCase() : null],
        valid,
      );
    },
    bindPrimary: (challenge: unknown, credential: unknown) =>
      call(
        "verifier",
        "SELECT control_private.bind_primary($1::text,$2::text) AS decision",
        [challenge, credential],
        handle(challenge) && cookie(credential),
      ),
    resumePrimary: (credential: unknown) =>
      call(
        "verifier",
        "SELECT control_private.resume_primary($1::text) AS decision",
        [credential],
        cookie(credential),
      ),
    prepareStepUp: (actor: unknown, sid: unknown, credential: unknown) =>
      call(
        "verifier",
        "SELECT control_private.prepare_step_up($1::text,$2::text,$3::text,'unknown'::text) AS decision",
        [actor, sid, credential],
        opaque(actor) && opaque(sid) && cookie(credential),
      ),
    reserveMfa: (challenge: unknown, credential: unknown, code: unknown) =>
      call(
        "verifier",
        "SELECT control_private.reserve_mfa($1::text,$2::text,$3::text) AS decision",
        [challenge, credential, code],
        handle(challenge) &&
          cookie(credential) &&
          typeof code === "string" &&
          /^[0-9]{6}$/.test(code),
      ),
    issueEvidence: (operation: unknown, sid: unknown, credential: unknown) =>
      call(
        "verifier",
        "SELECT control_private.issue_evidence($1::text,$2::text,$3::text) AS decision",
        [operation, sid, credential],
        handle(operation) && opaque(sid) && cookie(credential),
      ),
    finalize: (evidence: unknown, sid: unknown, credential: unknown) =>
      call(
        "staff",
        "SELECT staff.finalize_control($1::text,$2::text,$3::text) AS decision",
        [evidence, sid, credential],
        handle(evidence) && opaque(sid) && cookie(credential),
      ),
    touch: (actor: unknown, sid: unknown, expectedVersion: unknown) =>
      call(
        "staff",
        "SELECT staff.touch_control($1::text,$2::text,$3::bigint) AS decision",
        [actor, sid, expectedVersion],
        opaque(actor) && opaque(sid) && version(expectedVersion),
      ),
    revoke: (
      actor: unknown,
      sid: unknown,
      expectedVersion: unknown,
      targetSid: unknown,
    ) =>
      call(
        "staff",
        "SELECT staff.revoke_admission($1::text,$2::text,$3::bigint,$4::text) AS decision",
        [actor, sid, expectedVersion, targetSid],
        opaque(actor) &&
          opaque(sid) &&
          version(expectedVersion) &&
          opaque(targetSid),
      ),
    checkAccess: (actor: unknown, sid: unknown) =>
      call(
        "staff",
        "SELECT staff.check_access($1::text,$2::text,'security.self.read'::text,NULL::bigint) AS decision",
        [actor, sid],
        opaque(actor) && opaque(sid),
      ),
    close,
  });
}
export type AdmissionAuthority = Awaited<
  ReturnType<typeof createAdmissionAuthority>
>;
