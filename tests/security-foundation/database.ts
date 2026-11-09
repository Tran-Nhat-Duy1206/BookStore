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
const workerFunctions = [
  "audit.pending_provider_events(integer)",
  "audit.reconcile_provider_event(bigint)",
  "audit.record_reconcile_failure(bigint,text)",
];

function identifier(value: string): string {
  if (
    !databasePattern.test(value) &&
    !/^bf_[a-f0-9]{12}_(migrate|reader|auth|staff|worker|guard)$/.test(value)
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
  return new Error(
    `Security-foundation ${stage} failed${/^[A-Z0-9]{5}$/.test(code) ? ` (SQLSTATE ${code})` : ""}; credentials and SQL suppressed.`,
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
            "-c log_statement=none -c log_min_error_statement=panic -c log_min_messages=panic",
        }
      : {}),
  });
  const failures: Error[] = [];
  let result: T | undefined;
  try {
    await client.connect();
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
            for (const schema of ["public", "identity", "staff", "audit"]) {
              for (const recipient of [
                "PUBLIC",
                ...[
                  roles.reader,
                  roles.auth,
                  roles.staff,
                  roles.worker,
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
              "SELECT p.oid::regprocedure::text AS signature, p.prosecdef AS definer, p.proconfig AS config, p.prokind AS kind FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('staff','audit') ORDER BY p.oid",
            );
            // Temporary CREATE satisfies ownership-transfer checks on every supported
            // PostgreSQL path. Never persists outside this atomic transaction.
            await admin.query(
              `GRANT CREATE ON SCHEMA staff, audit TO ${identifier(guard)}`,
            );
            for (const fn of functions.rows) {
              if (
                !fn.definer ||
                fn.kind !== "f" ||
                !fn.config?.includes("search_path=pg_catalog")
              )
                throw new Error(
                  "Canonical functions require SECURITY DEFINER SET search_path=pg_catalog.",
                );
              await admin.query(
                `ALTER FUNCTION ${fn.signature} OWNER TO ${identifier(guard)}`,
              );
            }
            await admin.query(
              `REVOKE CREATE ON SCHEMA staff, audit FROM ${identifier(guard)}`,
            );
            const reader = identifier(roles.reader),
              auth = identifier(roles.auth),
              staff = identifier(roles.staff),
              worker = identifier(roles.worker),
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
          });
        },
      );
    },
    dispose: cleanup,
  };
}
