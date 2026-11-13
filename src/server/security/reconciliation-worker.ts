import "server-only";

import { performance } from "node:perf_hooks";
import { Pool, type PoolClient } from "pg";
import { assertFoundationUrl } from "./database-config";

export type ReconciliationResult = Readonly<{
  status: "completed" | "partial" | "unavailable" | "deadline" | "busy";
  selected: number;
  applied: number;
  skipped: number;
  failed: number;
  uncertain: number;
  failureRecordCallsConfirmed: number;
}>;

const signatures = [
  "audit.pending_provider_events(integer)",
  "audit.reconcile_provider_event(bigint)",
  "audit.record_reconcile_failure(bigint,text)",
  "audit.cleanup_control_orphans(integer)",
  "audit.expire_control_attempts(integer)",
];
const batch = 20;
const deadlineMillis = 15_000;
const emptyCounts = () => ({
  selected: 0,
  applied: 0,
  skipped: 0,
  failed: 0,
  uncertain: 0,
  failureRecordCallsConfirmed: 0,
});

/** Deny-only scheduler, NOT an MFA issuer, repair tool, queue health probe or HTTP API.
 * Every event is one autocommit function call. No provider/staff transaction is held.
 * Maintenance is deliberately NOT scheduled here: cleanup's zero is ambiguous and
 * expiry counts attempts only. Those existing capabilities remain ACL-checked.
 */
export async function createReconciliationWorker(config: {
  workerUrl: string;
}) {
  let workerUrl: string;
  try {
    if (
      !config ||
      Object.getPrototypeOf(config) !== Object.prototype ||
      Reflect.ownKeys(config).length !== 1
    )
      throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(config, "workerUrl");
    if (!descriptor || !("value" in descriptor)) throw new Error();
    workerUrl = assertFoundationUrl(descriptor.value, "worker");
  } catch {
    throw new Error("Reconciliation configuration unavailable.");
  }
  const url = new URL(workerUrl);
  const role = url.username;
  const guard = role.replace(/_worker$/, "_guard");
  const suffix = /^bf_([a-f0-9]{12})_worker$/.exec(role)![1];
  const pool = new Pool({
    connectionString: workerUrl,
    // Nonempty options suppress pg's PGOPTIONS environment fallback. Never use
    // caller options/SQL, environment URLs or positive-authority credentials.
    options: "-c application_name=bookstore-reconciliation-worker",
    application_name: "bookstore-reconciliation-worker",
    max: 2,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 5_000,
    statement_timeout: 1_500,
    query_timeout: 2_000,
    lock_timeout: 1_000,
    idle_in_transaction_session_timeout: 2_000,
  });
  pool.on("error", () => {
    // Never log database errors, connection strings or event identifiers.
  });
  const owned = new Set<PoolClient>();
  let closed = false;
  let running = false;
  let activeRunDone: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  function release(client: PoolClient, discard = false) {
    if (owned.delete(client)) client.release(discard);
  }

  async function checkout(): Promise<PoolClient> {
    if (closed) throw new Error("Unavailable");
    const client = await pool.connect();
    owned.add(client);
    try {
      if (closed) throw new Error("Unavailable");
      const result = await client.query<{ safe: boolean }>(
        `WITH expected AS (
          SELECT signature, to_regprocedure(signature)::oid AS oid,
          CASE signature
            WHEN 'audit.pending_provider_events(integer)' THEN '23'
            WHEN 'audit.reconcile_provider_event(bigint)' THEN '20'
            WHEN 'audit.record_reconcile_failure(bigint,text)' THEN '20 25'
            ELSE '23' END AS arguments,
          CASE signature
            WHEN 'audit.pending_provider_events(integer)' THEN 20
            WHEN 'audit.reconcile_provider_event(bigint)' THEN 16
            WHEN 'audit.record_reconcile_failure(bigint,text)' THEN 2278
            ELSE 23 END::oid AS result_type
          FROM unnest($1::text[]) signature
        ) SELECT (
          current_user::text=$2 AND session_user::text=$2 AND current_database()=$3
          AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
          AND NOT r.rolcreaterole AND NOT r.rolbypassrls AND NOT r.rolinherit
          AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
          AND NOT has_database_privilege(current_database(),'CREATE,TEMP')
          AND pg_get_userbyid(d.datdba)=$5
          AND shobj_description(d.oid,'pg_database') ~ $6
          AND shobj_description(r.oid,'pg_authid')=shobj_description(d.oid,'pg_database')
          AND shobj_description(g.oid,'pg_authid')=shobj_description(d.oid,'pg_database')
          AND NOT g.rolcanlogin AND NOT g.rolsuper AND NOT g.rolcreatedb
          AND NOT g.rolcreaterole AND NOT g.rolbypassrls AND NOT g.rolinherit
          AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=g.oid OR m.roleid=g.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_namespace n
            WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
            AND has_schema_privilege(n.oid,'CREATE'))
          AND has_schema_privilege('audit','USAGE')
          AND NOT EXISTS(SELECT 1 FROM pg_namespace n
            WHERE n.nspname IN ('public','identity','staff','control_private','control_crypto')
            AND has_schema_privilege(n.oid,'USAGE'))
          -- CASE, not an AND ordering assumption: the planner may evaluate an
          -- object-specific ACL function before a relation-kind filter.
          AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname IN ('public','identity','staff','audit','control_private','control_crypto')
            AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN
              (has_any_column_privilege(c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
                OR has_table_privilege(c.oid,'DELETE,TRUNCATE,TRIGGER'))
              ELSE false END)
          AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname IN ('public','identity','staff','audit','control_private','control_crypto')
            AND CASE WHEN c.relkind='S' THEN
              has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE') ELSE false END)
          AND (SELECT count(*) FROM expected)=5
          AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN pg_proc p ON p.oid=e.oid
            WHERE p.oid IS NULL OR NOT has_function_privilege(p.oid,'EXECUTE')
            OR p.proargtypes::text<>e.arguments OR p.prorettype<>e.result_type
            OR p.proretset<>(e.signature='audit.pending_provider_events(integer)')
            OR NOT p.prosecdef OR p.prokind<>'f' OR p.proowner<>g.oid
            OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
            OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
              WHERE acl.privilege_type<>'EXECUTE' OR acl.is_grantable
                OR acl.grantee NOT IN (g.oid,r.oid)))
          AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname IN ('staff','audit','control_private')
            AND has_function_privilege(p.oid,'EXECUTE')
            AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.oid=p.oid))
          AND current_setting('transaction_isolation')='read committed'
          AND current_setting('log_statement')='none'
          AND current_setting('log_min_error_statement')='panic'
          AND current_setting('log_parameter_max_length')='0'
          AND current_setting('log_parameter_max_length_on_error')='0'
          AND current_setting('log_duration')='off'
          AND current_setting('log_min_duration_statement')='-1'
          AND current_setting('log_min_duration_sample')='-1'
          AND current_setting('log_transaction_sample_rate')::numeric=0
          AND NOT EXISTS(SELECT 1 FROM pg_db_role_setting settings
            CROSS JOIN LATERAL unnest(settings.setconfig) setting
            WHERE settings.setrole IN (0,r.oid)
            AND settings.setdatabase IN (0,d.oid)
            AND setting ~* '^(shared|session|local)_preload_libraries='
            AND substring(setting FROM position('=' IN setting)+1)<>'')
          AND NOT EXISTS(SELECT 1 FROM pg_settings
            WHERE name LIKE 'pgaudit.%' OR name LIKE 'auto_explain.%')
        ) AS safe FROM pg_roles r CROSS JOIN pg_roles g CROSS JOIN pg_database d
        WHERE r.rolname=current_user AND g.rolname=$4 AND d.datname=current_database()`,
        [
          signatures,
          role,
          url.pathname.slice(1),
          guard,
          role.replace(/_worker$/, "_migrate"),
          `^bookstore-security-foundation:${suffix}:[a-f0-9]{32}$`,
        ],
      );
      if (result.rows.length !== 1 || result.rows[0]?.safe !== true || closed)
        throw new Error("Unavailable");
      return client;
    } catch {
      release(client, true);
      throw new Error("Reconciliation metadata unavailable.");
    }
  }

  async function close(): Promise<void> {
    if (!closing) {
      closed = true;
      // Destroying owned connections is not a claim that PostgreSQL rolled back
      // an already-sent query. runOnce will return unavailable/uncertain.
      for (const client of owned) release(client, true);
      closing = Promise.all([pool.end(), activeRunDone]).then(
        () => undefined,
        () => {
          throw new Error("Reconciliation close unavailable.");
        },
      );
    }
    return closing;
  }

  // Verify before publishing a usable instance, and again on EVERY checkout.
  try {
    const client = await checkout();
    release(client);
  } catch {
    await close();
    throw new Error("Reconciliation initialization unavailable.");
  }

  return Object.freeze({
    async runOnce(): Promise<ReconciliationResult> {
      const counts = emptyCounts();
      const finish = (status: ReconciliationResult["status"]) =>
        Object.freeze({ status, ...counts });
      if (closed) return finish("unavailable");
      if (running) return finish("busy");
      running = true;
      let settleRun!: () => void;
      activeRunDone = new Promise<void>((resolve) => {
        settleRun = resolve;
      });
      const deadline = performance.now() + deadlineMillis;
      const expired = () => performance.now() >= deadline;
      let client: PoolClient | undefined;
      try {
        client = await checkout();
        if (closed || expired())
          return finish(closed ? "unavailable" : "deadline");
        const selected = await client.query<{ id: unknown }>(
          "SELECT id FROM audit.pending_provider_events(20)",
        );
        if (closed || expired())
          return finish(closed ? "unavailable" : "deadline");
        if (
          selected.rows.length > batch ||
          selected.rows.some(
            (row) =>
              typeof row.id !== "string" ||
              !/^[1-9][0-9]{0,18}$/.test(row.id) ||
              BigInt(row.id) > 9223372036854775807n,
          ) ||
          new Set(selected.rows.map((row) => row.id)).size !==
            selected.rows.length
        )
          return finish("unavailable");
        counts.selected = selected.rows.length;
        const ids = selected.rows.map((row) => row.id as string);
        release(client);
        client = undefined;
        for (const id of ids) {
          if (closed || expired())
            return finish(closed ? "unavailable" : "deadline");
          let querySent = false;
          try {
            client = await checkout();
            if (closed || expired())
              return finish(closed ? "unavailable" : "deadline");
            querySent = true;
            const applied = await client.query<{ applied: unknown }>(
              "SELECT audit.reconcile_provider_event($1::bigint) AS applied",
              [id],
            );
            if (closed || expired()) {
              counts.uncertain++;
              release(client, true);
              client = undefined;
              return finish(closed ? "unavailable" : "deadline");
            }
            if (
              applied.rows.length !== 1 ||
              typeof applied.rows[0]?.applied !== "boolean"
            )
              throw new Error("Unavailable");
            if (applied.rows[0].applied) counts.applied++;
            else counts.skipped++;
            release(client);
            client = undefined;
          } catch {
            if (client) release(client, true);
            client = undefined;
            counts.failed++;
            // Even a query rejection is conservatively uncertain; no raw cause
            // or inferred SQL rollback classification crosses this boundary.
            if (querySent) counts.uncertain++;
            if (closed || expired())
              return finish(closed ? "unavailable" : "deadline");
            if (!querySent) return finish("unavailable");
            try {
              client = await checkout();
              if (closed || expired())
                return finish(closed ? "unavailable" : "deadline");
              await client.query(
                "SELECT audit.record_reconcile_failure($1::bigint,'apply_failed'::text)",
                [id],
              );
              if (closed || expired())
                return finish(closed ? "unavailable" : "deadline");
              counts.failureRecordCallsConfirmed++;
              release(client);
              client = undefined;
            } catch {
              if (client) release(client, true);
              client = undefined;
              // No retry, blocked-total claim or fabricated durable failure fact.
              return finish("unavailable");
            }
          }
        }
        return finish(counts.failed ? "partial" : "completed");
      } catch {
        if (client) release(client, true);
        client = undefined;
        return finish(expired() ? "deadline" : "unavailable");
      } finally {
        if (client) release(client, closed || expired());
        running = false;
        settleRun();
        activeRunDone = undefined;
      }
    },
    close,
  });
}

export type ReconciliationWorker = Awaited<
  ReturnType<typeof createReconciliationWorker>
>;
