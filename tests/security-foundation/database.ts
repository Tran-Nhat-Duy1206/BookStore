import { randomBytes } from "node:crypto";
import { Client } from "pg";
import {
  assertFoundationBaseUrl,
  assertFoundationUrl,
  type FoundationPurpose,
} from "../../src/server/security/database-config";

export interface FoundationDatabase {
  readonly name: string;
  readonly migrationUrl: string;
  readonly readerUrl: string;
  readonly authUrl: string;
  readonly staffUrl: string;
  readonly workerUrl: string;
  readonly verifierUrl: string;
  /** Owned offline maintenance only: close all clients before upgrading hardened005. */
  prepareControlUpgrade(): Promise<void>;
  /** Apply the canonical migrations first. Reapply after any offline DDL. */
  hardenPrivileges(): Promise<void>;
  /** Close ALL caller-owned clients/pools first. Never terminates connections. */
  dispose(): Promise<void>;
}

const purposes: readonly FoundationPurpose[] = [
  "migrate",
  "reader",
  "auth",
  "staff",
  "worker",
  "verifier",
];
const created = new Map<string, string>();
const databasePattern = /^bookstore_security_test_([a-f0-9]{12})$/;
const catalogTables = [
  "Work",
  "Series",
  "SeriesWork",
  "Volume",
  "Publisher",
  "Edition",
  "EditionContent",
  "Product",
  "Sku",
  "Category",
  "WorkCategory",
  "Contributor",
  "WorkContributor",
  "EditionContributor",
];
const providerTables = [
  "User",
  "Session",
  "Account",
  "Verification",
  "TwoFactor",
  "RateLimit",
];
const staffTables = [
  "roles",
  "permissions",
  "role_permissions",
  "principals",
  "role_grants",
  "admissions",
  "governance",
];
const staffFunctions = [
  "staff.check_access(text,text,text,bigint)",
  "staff.set_status(text,text,bigint,text,text)",
  "staff.replace_roles(text,text,bigint,text,text[])",
  "staff.revoke_admission(text,text,bigint,text)",
  "audit.record_denial(uuid,text,text)",
];
const controlStaffFunctions = [
  "staff.control_clock_probe()",
  "staff.finalize_control(text,text,text)",
  "staff.touch_control(text,text,bigint)",
];
const verifierFunctions = [
  "control_private.clock_probe()",
  "control_private.prepare_password(text,text)",
  "control_private.bind_primary(text,text)",
  "control_private.resume_primary(text)",
  "control_private.prepare_step_up(text,text,text,text)",
  "control_private.reserve_mfa(text,text,text)",
  "control_private.issue_evidence(text,text,text)",
];
const controlWorkerFunctions = [
  "audit.cleanup_control_orphans(integer)",
  "audit.expire_control_attempts(integer)",
];
// Fixed owned-role policy only; neither setting names nor values are caller input.
const roleLogPolicy = {
  log_statement: "none",
  log_min_error_statement: "panic",
  log_parameter_max_length: "0",
  log_parameter_max_length_on_error: "0",
  log_duration: "off",
  log_min_duration_statement: "-1",
  log_min_duration_sample: "-1",
  log_transaction_sample_rate: "0",
} as const;
const workerFunctions = [
  "audit.pending_provider_events(integer)",
  "audit.reconcile_provider_event(bigint)",
  "audit.record_reconcile_failure(bigint,text)",
];

function identifier(value: string): string {
  if (
    !databasePattern.test(value) &&
    !/^bf_[a-f0-9]{12}_(migrate|reader|auth|staff|worker|verifier|guard)$/.test(
      value,
    )
  ) {
    throw new Error("Refusing an unowned foundation identifier.");
  }
  return `"${value}"`;
}
function quoteIdentifier(value: string): string {
  // Used ONLY for identifiers returned by pg_catalog, never caller input.
  return `"${value.replaceAll('"', '""')}"`;
}
function safeError(stage: string, error: unknown): Error {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  const invariantAliases: Readonly<Record<string, string>> = {
    "Canonical functions require SECURITY DEFINER SET search_path=pg_catalog.":
      "invalid_definer",
    "Role marker mismatch.": "role_marker",
    "Owned security cluster requires an empty shared preload list.":
      "shared_preload",
    "Owned foundation database is missing.": "missing_database",
    "Database marker mismatch.": "database_marker",
    "Database ownership mismatch.": "database_owner",
    "Refusing an unowned foundation identifier.": "identifier",
  };
  const transportAliases: Readonly<Record<string, string>> = {
    ECONNREFUSED: "connection_refused",
    ECONNRESET: "connection_reset",
    ETIMEDOUT: "connection_timeout",
  };
  const invariant =
    error instanceof Error && Object.hasOwn(invariantAliases, error.message)
      ? invariantAliases[error.message]
      : Object.hasOwn(transportAliases, code)
        ? transportAliases[code]
        : undefined;
  const procedure =
    invariant === "invalid_definer" &&
    typeof error === "object" &&
    error !== null &&
    "foundationProcedure" in error
      ? String(error.foundationProcedure)
      : "";
  // Only bounded catalog procedure identifiers/types, never error detail or args.
  const safeProcedure =
    /^(staff|audit|control_private)\.[a-z_]{1,80}\([a-z_., ()]{0,200}\)$/.test(
      procedure,
    )
      ? procedure
      : "";
  return new Error(
    `Security-foundation ${stage} failed${/^[A-Z0-9]{5}$/.test(code) ? ` (SQLSTATE ${code})` : ""}${invariant ? ` (invariant ${invariant}${safeProcedure ? `: ${safeProcedure}` : ""})` : ""}; credentials and SQL suppressed.`,
  );
}
async function connected<T>(
  url: string,
  stage: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: url,
    ...(new URL(url).username === "bookstore_security_bootstrap"
      ? {
          options:
            "-c log_statement=none -c log_min_error_statement=panic -c log_min_messages=panic -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 -c log_duration=off -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 -c log_transaction_sample_rate=0 -c session_preload_libraries= -c local_preload_libraries=",
        }
      : {}),
  });
  const failures: Error[] = [];
  let result: T | undefined;
  try {
    await client.connect();
    if (new URL(url).username === "bookstore_security_bootstrap") {
      const preload = await client.query<{ shared: string }>(
        "SELECT current_setting('shared_preload_libraries') AS shared",
      );
      if (preload.rows[0]?.shared !== "")
        throw new Error(
          "Owned security cluster requires an empty shared preload list.",
        );
    }
    result = await work(client);
  } catch (error) {
    // Every nested aggregate below contains only already-sanitized errors.
    failures.push(
      error instanceof AggregateError ? error : safeError(stage, error),
    );
  } finally {
    try {
      await client.end();
    } catch (error) {
      failures.push(safeError(`${stage} client close`, error));
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `Foundation ${stage} failed; see sanitized errors.`,
    );
  return result as T;
}
async function transaction(
  client: Client,
  stage: string,
  work: () => Promise<void>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await work();
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollback) {
      throw new AggregateError(
        [safeError(stage, error), safeError(`${stage} rollback`, rollback)],
        "Foundation transaction failed.",
      );
    }
    throw error;
  }
}

/** Reads SECURITY_TEST_DATABASE_URL only; no env files, migrations, seed or exposed bootstrap URL. */
export async function createFoundationDatabase(): Promise<FoundationDatabase> {
  const base = process.env.SECURITY_TEST_DATABASE_URL;
  if (!base)
    throw new Error(
      "SECURITY_TEST_DATABASE_URL is required for the security foundation.",
    );
  assertFoundationBaseUrl(base);
  const suffix = randomBytes(6).toString("hex");
  const name = `bookstore_security_test_${suffix}`;
  const marker = `bookstore-security-foundation:${suffix}:${randomBytes(16).toString("hex")}`;
  const roles = Object.fromEntries(
    purposes.map((purpose) => [purpose, `bf_${suffix}_${purpose}`]),
  ) as Record<FoundationPurpose, string>;
  const guard = `bf_${suffix}_guard`;
  const passwords = Object.fromEntries(
    purposes.map((purpose) => [purpose, randomBytes(32).toString("hex")]),
  ) as Record<FoundationPurpose, string>;
  const urls = Object.fromEntries(
    purposes.map((purpose) => {
      const url = new URL(base);
      url.username = roles[purpose];
      url.password = passwords[purpose];
      url.pathname = `/${name}`;
      return [purpose, assertFoundationUrl(url.toString(), purpose)];
    }),
  ) as Record<FoundationPurpose, string>;
  // Private bootstrap connection is essential: no migration→guard membership or SET ROLE.
  const privateUrl = new URL(base);
  privateUrl.pathname = `/${name}`;
  const ownedRoles = new Set<string>();
  let databaseCreated = false;
  let databaseMarked = false;
  let disposed = false;

  async function verifyDatabase(admin: Client): Promise<boolean> {
    if (created.get(name) !== marker)
      throw new Error("Database is not owned by this run.");
    const result = await admin.query<{ marker: string | null; owner: string }>(
      "SELECT shobj_description(d.oid, 'pg_database') AS marker, r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1",
      [name],
    );
    if (!result.rows.length) return false;
    if (result.rows.length !== 1 || result.rows[0].owner !== roles.migrate)
      throw new Error("Database ownership mismatch.");
    if (!databaseMarked && result.rows[0].marker === null) {
      const owner = await admin.query<{ marker: string | null }>(
        "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
        [roles.migrate],
      );
      if (!ownedRoles.has(roles.migrate) || owner.rows[0]?.marker !== marker)
        throw new Error("Migration role marker mismatch.");
      await admin.query(
        `COMMENT ON DATABASE ${identifier(name)} IS '${marker}'`,
      );
      databaseMarked = true;
    } else if (result.rows[0].marker !== marker)
      throw new Error("Database marker mismatch.");
    return true;
  }
  async function cleanup(): Promise<void> {
    if (disposed) return;
    await connected(base!, "cleanup", async (admin) => {
      if (databaseCreated) {
        if (await verifyDatabase(admin)) {
          // No FORCE, termination, DROP OWNED, or other databases.
          await admin.query(`DROP DATABASE ${identifier(name)}`);
        }
        databaseCreated = false;
        created.delete(name);
      }
      const failures: Error[] = [];
      for (const role of [...ownedRoles]) {
        try {
          const result = await admin.query<{ marker: string | null }>(
            "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
            [role],
          );
          if (!result.rows.length) {
            ownedRoles.delete(role);
            continue;
          }
          if (result.rows.length !== 1 || result.rows[0].marker !== marker)
            throw new Error("Role marker mismatch.");
          await admin.query(`DROP ROLE ${identifier(role)}`);
          ownedRoles.delete(role);
        } catch (error) {
          failures.push(safeError("owned role cleanup", error));
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Some owned foundation roles remain; cleanup may be retried.",
        );
      disposed = true;
    });
  }

  try {
    await connected(base, "bootstrap", async (admin) => {
      await transaction(admin, "role creation", async () => {
        for (const role of [
          ...purposes.map((purpose) => roles[purpose]),
          guard,
        ]) {
          ownedRoles.add(role); // Track before round trip, including ambiguous COMMIT.
          const purpose = purposes.find((entry) => roles[entry] === role);
          await admin.query(
            `CREATE ROLE ${identifier(role)} ${purpose ? `LOGIN PASSWORD '${passwords[purpose]}'` : "NOLOGIN"} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`,
          );
          await admin.query(
            `COMMENT ON ROLE ${identifier(role)} IS '${marker}'`,
          );
          if (purpose) {
            // Superuser-only settings are scoped to this marked disposable role.
            await admin.query(
              `ALTER ROLE ${identifier(role)} SET log_statement = 'none'`,
            );
            await admin.query(
              `ALTER ROLE ${identifier(role)} SET log_min_error_statement = 'panic'`,
            );
            await admin.query(
              `ALTER ROLE ${identifier(role)} SET log_parameter_max_length = 0`,
            );
            await admin.query(
              `ALTER ROLE ${identifier(role)} SET log_parameter_max_length_on_error = 0`,
            );
          }
        }
      });
      databaseCreated = true; // CREATE DATABASE is nontransactional; track intent first.
      created.set(name, marker);
      await admin.query(
        `CREATE DATABASE ${identifier(name)} OWNER ${identifier(roles.migrate)} TEMPLATE template0`,
      );
      await admin.query(
        `COMMENT ON DATABASE ${identifier(name)} IS '${marker}'`,
      );
      databaseMarked = true;
      await admin.query(
        `REVOKE ALL ON DATABASE ${identifier(name)} FROM PUBLIC`,
      );
      for (const purpose of purposes)
        await admin.query(
          `GRANT CONNECT ON DATABASE ${identifier(name)} TO ${identifier(roles[purpose])}`,
        );
    });
    await connected(urls.migrate, "initial isolation", async (migration) => {
      await migration.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await migration.query(
        "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
      );
      await migration.query(
        "ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC",
      );
      await migration.query(
        "ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM PUBLIC",
      );
    });
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Foundation creation and guarded partial cleanup failed for ${name}; inspect only this run's marked objects. No forced cleanup attempted.`,
      );
    }
    throw error;
  }

  return {
    name,
    migrationUrl: urls.migrate,
    readerUrl: urls.reader,
    authUrl: urls.auth,
    staffUrl: urls.staff,
    workerUrl: urls.worker,
    verifierUrl: urls.verifier,
    async prepareControlUpgrade() {
      if (disposed || !databaseCreated || created.get(name) !== marker)
        throw new Error(
          "Foundation database is not live and owned by this run.",
        );
      await connected(
        privateUrl.toString(),
        "control upgrade maintenance",
        async (admin) => {
          if (!(await verifyDatabase(admin)))
            throw new Error("Owned database is missing.");
          for (const role of [
            ...purposes.map((purpose) => roles[purpose]),
            guard,
          ]) {
            const check = await admin.query<{ marker: string | null }>(
              "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
              [role],
            );
            if (check.rows.length !== 1 || check.rows[0].marker !== marker)
              throw new Error("Role marker mismatch.");
          }
          await transaction(admin, "control upgrade maintenance", async () => {
            await admin.query("SET LOCAL search_path=pg_catalog");
            const ledger = await admin.query<{
              foundation: boolean;
              controls: boolean;
            }>(
              `SELECT EXISTS(SELECT 1 FROM public._prisma_migrations WHERE migration_name='005_security_foundation' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS foundation,
             EXISTS(SELECT 1 FROM public._prisma_migrations WHERE migration_name='006_durable_admission_controls' AND rolled_back_at IS NULL) AS controls`,
            );
            if (!ledger.rows[0]?.foundation || ledger.rows[0]?.controls)
              throw new Error(
                "Control upgrade requires completed005 and absent006.",
              );
            const active = await admin.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
            );
            if (active.rows[0]?.n !== 0)
              throw new Error(
                "Close every caller-owned connection before maintenance.",
              );
            const signatures = [
              "staff.check_access(text,text,text,bigint)",
              "audit.staff_change()",
            ];
            for (const signature of signatures) {
              const checked = await admin.query<{ safe: boolean }>(
                `SELECT pg_get_userbyid(p.proowner)=$2 AND p.prosecdef AND p.prokind='f'
               AND p.proconfig @> ARRAY['search_path=pg_catalog']::text[]
               AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                 WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable
                 OR a.grantee NOT IN (p.proowner,(SELECT oid FROM pg_roles WHERE rolname=$3),
                   CASE WHEN $1='staff.check_access(text,text,text,bigint)' THEN (SELECT oid FROM pg_roles WHERE rolname=$4) ELSE p.proowner END)) AS safe
               FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,
                [signature, guard, roles.migrate, roles.staff],
              );
              if (checked.rows.length !== 1 || checked.rows[0].safe !== true)
                throw new Error("Upgrade function ownership or ACL mismatch.");
            }
            // Maintenance survives a later failed migration: runtime cannot reconnect
            // or execute old grant functions. Re-hardening restores exact capabilities.
            for (const purpose of purposes.filter(
              (entry) => entry !== "migrate",
            )) {
              const role = identifier(roles[purpose]);
              await admin.query(
                `REVOKE CONNECT ON DATABASE ${identifier(name)} FROM ${role}`,
              );
              await admin.query(
                `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA staff,audit FROM ${role}`,
              );
            }
            for (const signature of signatures)
              await admin.query(
                `ALTER FUNCTION ${signature} OWNER TO ${identifier(roles.migrate)}`,
              );
          });
        },
      );
    },
    async hardenPrivileges() {
      if (disposed || !databaseCreated || created.get(name) !== marker)
        throw new Error(
          "Foundation database is not live and owned by this run.",
        );
      await connected(
        privateUrl.toString(),
        "privilege hardening",
        async (admin) => {
          if (!(await verifyDatabase(admin)))
            throw new Error("Owned foundation database is missing.");
          for (const role of [
            ...purposes.map((purpose) => roles[purpose]),
            guard,
          ]) {
            const check = await admin.query<{ marker: string | null }>(
              "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
              [role],
            );
            if (check.rows.length !== 1 || check.rows[0].marker !== marker)
              throw new Error("Role marker mismatch.");
          }
          await transaction(admin, "privilege hardening", async () => {
            await admin.query("SET LOCAL search_path = pg_catalog");
            const controls =
              (
                await admin.query<{ present: boolean }>(
                  "SELECT to_regnamespace('control_private') IS NOT NULL AS present",
                )
              ).rows[0]?.present === true;
            const schemas = [
              "public",
              "identity",
              "staff",
              "audit",
              ...(controls ? ["control_private", "control_crypto"] : []),
            ];
            for (const schema of schemas) {
              for (const recipient of [
                "PUBLIC",
                ...[
                  roles.reader,
                  roles.auth,
                  roles.staff,
                  roles.worker,
                  roles.verifier,
                  guard,
                ].map(identifier),
              ]) {
                await admin.query(
                  `REVOKE ALL ON SCHEMA "${schema}" FROM ${recipient}`,
                );
                await admin.query(
                  `REVOKE ALL ON ALL TABLES IN SCHEMA "${schema}" FROM ${recipient}`,
                );
                await admin.query(
                  `REVOKE ALL ON ALL SEQUENCES IN SCHEMA "${schema}" FROM ${recipient}`,
                );
                await admin.query(
                  `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "${schema}" FROM ${recipient}`,
                );
                // Table-level REVOKE does not remove column ACLs.
                const columns = await admin.query<{
                  relation: string;
                  columns: string;
                }>(
                  `SELECT c.oid::regclass::text AS relation,string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) AS columns
                   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
                   WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') GROUP BY c.oid`,
                  [schema],
                );
                for (const column of columns.rows)
                  await admin.query(
                    `REVOKE SELECT (${column.columns}), INSERT (${column.columns}), UPDATE (${column.columns}), REFERENCES (${column.columns}) ON TABLE ${column.relation} FROM ${recipient}`,
                  );
              }
            }
            // Catalog-generated regprocedure strings are rendered with pg_catalog-only
            // search_path, fully schema-qualified and PostgreSQL identifier quoting.
            const functions = await admin.query<{
              signature: string;
              definer: boolean;
              config: string[] | null;
              kind: string;
            }>(
              "SELECT p.oid::regprocedure::text AS signature, p.prosecdef AS definer, p.proconfig AS config, p.prokind AS kind FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('staff','audit','control_private') ORDER BY p.oid",
            );
            // Temporary CREATE satisfies ownership-transfer checks on every supported
            // PostgreSQL path. Never persists outside this atomic transaction.
            await admin.query(
              `GRANT USAGE, CREATE ON SCHEMA staff, audit${controls ? ", control_private" : ""} TO ${identifier(guard)}`,
            );
            for (const fn of functions.rows) {
              if (
                !fn.definer ||
                fn.kind !== "f" ||
                !fn.config?.includes("search_path=pg_catalog")
              )
                throw Object.assign(
                  new Error(
                    "Canonical functions require SECURITY DEFINER SET search_path=pg_catalog.",
                  ),
                  { foundationProcedure: fn.signature },
                );
              await admin.query(
                `ALTER FUNCTION ${fn.signature} OWNER TO ${identifier(guard)}`,
              );
              // Owners can revoke their own ordinary EXECUTE privilege. A second
              // hardening pass must restore it even when ownership is unchanged.
              await admin.query(
                `GRANT EXECUTE ON FUNCTION ${fn.signature} TO ${identifier(guard)}`,
              );
            }
            if (controls) {
              const tables = await admin.query<{ relation: string }>(
                "SELECT c.oid::regclass::text AS relation FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='control_private' AND c.relkind IN ('r','p') ORDER BY c.oid",
              );
              for (const table of tables.rows) {
                await admin.query(
                  `ALTER TABLE ${table.relation} OWNER TO ${identifier(guard)}`,
                );
                // Likewise restore ordinary owner table rights after revocation;
                // this is the NOLOGIN definer, not a runtime credential.
                await admin.query(
                  `GRANT ALL ON TABLE ${table.relation} TO ${identifier(guard)}`,
                );
              }
            }
            await admin.query(
              `REVOKE CREATE ON SCHEMA staff, audit${controls ? ", control_private" : ""} FROM ${identifier(guard)}`,
            );
            const reader = identifier(roles.reader),
              auth = identifier(roles.auth),
              staff = identifier(roles.staff),
              worker = identifier(roles.worker),
              verifier = identifier(roles.verifier),
              migration = identifier(roles.migrate),
              trusted = identifier(guard);
            await admin.query(`GRANT USAGE ON SCHEMA public TO ${reader}`);
            await admin.query(
              `GRANT SELECT ON ${catalogTables.map((table) => `public.${quoteIdentifier(table)}`).join(", ")} TO ${reader}`,
            );
            await admin.query(`GRANT USAGE ON SCHEMA identity TO ${auth}`);
            await admin.query(
              `GRANT SELECT, INSERT, UPDATE, DELETE ON ${providerTables.map((table) => `identity.${quoteIdentifier(table)}`).join(", ")} TO ${auth}`,
            );
            await admin.query(`GRANT USAGE ON SCHEMA staff, audit TO ${staff}`);
            await admin.query(
              `GRANT SELECT ON ${staffTables.map((table) => `staff.${quoteIdentifier(table)}`).join(", ")}, audit.events TO ${staff}`,
            );
            await admin.query(`GRANT USAGE ON SCHEMA audit TO ${worker}`);
            await admin.query(
              `GRANT USAGE ON SCHEMA identity, staff, audit TO ${trusted}`,
            );
            await admin.query(
              `GRANT SELECT ON ALL TABLES IN SCHEMA identity TO ${trusted}`,
            );
            await admin.query(
              `GRANT ALL ON ALL TABLES IN SCHEMA staff, audit TO ${trusted}`,
            );
            await admin.query(
              `GRANT ALL ON ALL SEQUENCES IN SCHEMA staff, audit TO ${trusted}`,
            );
            for (const signature of staffFunctions)
              await admin.query(
                `GRANT EXECUTE ON FUNCTION ${signature} TO ${staff}`,
              );
            for (const signature of workerFunctions)
              await admin.query(
                `GRANT EXECUTE ON FUNCTION ${signature} TO ${worker}`,
              );
            if (controls) {
              await admin.query(
                `GRANT USAGE ON SCHEMA control_private TO ${trusted}, ${verifier}, ${migration}`,
              );
              await admin.query(
                `GRANT USAGE ON SCHEMA control_crypto TO ${trusted}`,
              );
              await admin.query(
                `GRANT DELETE ON identity."Session" TO ${trusted}`,
              );
              await admin.query(
                `GRANT ALL ON ALL TABLES IN SCHEMA control_private TO ${migration}`,
              );
              // Offline fixture-only snapshot/token/cookie construction, never runtime.
              await admin.query(
                `GRANT EXECUTE ON FUNCTION control_private.security_snapshot(text), control_private.mac(text,text) TO ${migration}`,
              );
              // Trusted extension functions are NOT app definer functions and may
              // be superuser-owned. Only this owned offline administrator changes ACLs.
              for (const recipient of [
                "PUBLIC",
                ...purposes.map((purpose) => identifier(roles[purpose])),
                trusted,
              ])
                await admin.query(
                  `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_crypto FROM ${recipient}`,
                );
              await admin.query(
                `GRANT USAGE ON SCHEMA control_crypto TO ${migration}`,
              );
              await admin.query(
                `GRANT EXECUTE ON FUNCTION control_crypto.hmac(bytea,bytea,text), control_crypto.gen_random_bytes(integer) TO ${trusted}, ${migration}`,
              );
              for (const signature of verifierFunctions)
                await admin.query(
                  `GRANT EXECUTE ON FUNCTION ${signature} TO ${verifier}`,
                );
              for (const signature of controlStaffFunctions)
                await admin.query(
                  `GRANT EXECUTE ON FUNCTION ${signature} TO ${staff}`,
                );
              for (const signature of controlWorkerFunctions)
                await admin.query(
                  `GRANT EXECUTE ON FUNCTION ${signature} TO ${worker}`,
                );
              // Check the actual creating owners' defaults as well as existing ACLs.
              for (const owner of [migration, trusted]) {
                await admin.query(
                  `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA control_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
                );
                await admin.query(
                  `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA control_private REVOKE ALL ON TABLES FROM PUBLIC`,
                );
                await admin.query(
                  `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA control_private REVOKE ALL ON SEQUENCES FROM PUBLIC`,
                );
              }
              // No legacy access predicate remains reachable by any runtime purpose.
              for (const purpose of purposes.filter(
                (entry) => entry !== "migrate",
              ))
                await admin.query(
                  `REVOKE ALL ON FUNCTION staff.check_access_b1(text,text,text,bigint) FROM ${identifier(roles[purpose])}`,
                );
            }
            const preload = await admin.query<{
              shared: string;
              defaults_empty: boolean;
            }>(
              `SELECT current_setting('shared_preload_libraries') AS shared,
               NOT EXISTS(SELECT 1 FROM pg_file_settings WHERE applied
                 AND name IN ('shared_preload_libraries','session_preload_libraries','local_preload_libraries') AND setting<>'')
               AND NOT EXISTS(SELECT 1 FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) c
                 WHERE s.setrole=0 AND s.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
                 AND (c LIKE 'session_preload_libraries=%' OR c LIKE 'local_preload_libraries=%')
                 AND c NOT IN ('session_preload_libraries=','local_preload_libraries=')) AS defaults_empty`,
            );
            if (
              preload.rows[0]?.shared !== "" ||
              preload.rows[0]?.defaults_empty !== true
            )
              throw new Error(
                "Owned security cluster requires an empty shared preload list.",
              );
            for (const purpose of purposes) {
              const role = identifier(roles[purpose]);
              // Role-IN-database defaults override general role defaults. Clear
              // every constrained logging override before publishing safe policy.
              for (const parameter of Object.keys(roleLogPolicy))
                await admin.query(
                  `ALTER ROLE ${role} IN DATABASE ${identifier(name)} RESET ${parameter}`,
                );
              for (const [parameter, value] of Object.entries(roleLogPolicy))
                await admin.query(
                  `ALTER ROLE ${role} SET ${parameter} = '${value}'`,
                );
              // GUC_LIST_QUOTE SET ... = '' stores a quoted empty library name
              // (not an empty list) and makes the next login try loading it.
              // Reset to the verified-empty owned cluster/database defaults.
              for (const parameter of [
                "session_preload_libraries",
                "local_preload_libraries",
              ]) {
                await admin.query(`ALTER ROLE ${role} RESET ${parameter}`);
                await admin.query(
                  `ALTER ROLE ${role} IN DATABASE ${identifier(name)} RESET ${parameter}`,
                );
              }
              await admin.query(
                `GRANT CONNECT ON DATABASE ${identifier(name)} TO ${role}`,
              );

              const logging = await admin.query<{
                audit: string | null;
                explain: string | null;
              }>(
                "SELECT current_setting('pgaudit.log_parameter',true) AS audit,current_setting('auto_explain.log_min_duration',true) AS explain",
              );
              if (logging.rows[0]?.audit != null)
                await admin.query(
                  `ALTER ROLE ${role} SET pgaudit.log_parameter = 'off'`,
                );
              if (logging.rows[0]?.explain != null)
                await admin.query(
                  `ALTER ROLE ${role} SET auto_explain.log_min_duration = '-1'`,
                );
            }
            const policy = await admin.query<{ safe: boolean }>(
              `SELECT count(*)=cardinality($1::text[]) AND coalesce(bool_and(
                (SELECT count(*) FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) c
                 WHERE s.setrole=r.oid AND s.setdatabase=0 AND c=ANY($2::text[]))=cardinality($2::text[])
                AND NOT EXISTS(SELECT 1 FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) c
                 WHERE s.setrole=r.oid AND s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())
                 AND split_part(c,'=',1)=ANY($3::text[]))),false) AS safe
               FROM pg_roles r WHERE r.rolname=ANY($1::text[])`,
              [
                purposes.map((purpose) => roles[purpose]),
                Object.entries(roleLogPolicy).map(
                  ([parameter, value]) => `${parameter}=${value}`,
                ),
                Object.keys(roleLogPolicy),
              ],
            );
            if (policy.rows[0]?.safe !== true)
              throw new Error("Owned role logging policy unavailable.");
            if (controls) {
              // Offline configuration attestation only, after all privileged
              // checks/resets above. No runtime setter, private SELECT or extra
              // EXECUTE grant is introduced. Restart requires re-hardening.
              const witness = await admin.query(
                `INSERT INTO control_private.configuration_witness(singleton,realm_id,postmaster_started_at,empty_preloads,policy_version)
                 SELECT true,realm_id,pg_postmaster_start_time(),true,1 FROM control_private.secrets WHERE singleton
                 ON CONFLICT(singleton) DO UPDATE SET realm_id=EXCLUDED.realm_id,
                 postmaster_started_at=EXCLUDED.postmaster_started_at,
                 empty_preloads=EXCLUDED.empty_preloads,policy_version=EXCLUDED.policy_version`,
              );
              if (witness.rowCount !== 1)
                throw new Error("Control configuration witness unavailable.");
            }
          });
        },
      );
    },
    dispose: cleanup,
  };
}
