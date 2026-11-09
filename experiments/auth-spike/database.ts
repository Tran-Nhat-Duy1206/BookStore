import { randomBytes } from "node:crypto";
import { Client } from "pg";

/** Experimental only: deliberately independent of the catalog URL guard. */
export type SpikePurpose = "migrate" | "reader" | "auth" | "staff";
export interface SpikeDatabase {
  readonly name: string;
  readonly migrationUrl: string;
  readonly readerUrl: string;
  readonly authUrl: string;
  readonly staffUrl: string;
  /** Call after applying catalog + experimental SQL using migrationUrl. */
  grantRuntimePrivileges(): Promise<void>;
  /** Caller must close ALL clients/pools first. Never terminates connections. */
  dispose(): Promise<void>;
}

const purposes: readonly SpikePurpose[] = [
  "migrate",
  "reader",
  "auth",
  "staff",
];
const created = new Map<string, string>();
const databasePattern = /^bookstore_auth_spike_test_([a-f0-9]{12})$/;

function parseUrl(value: string): URL {
  try {
    // WHATWG URL otherwise normalizes embedded tabs/newlines and empty ?/#.
    if (!value || /\s/.test(value) || /[?#]/.test(value)) throw new Error();
    const url = new URL(value);
    const password = decodeURIComponent(url.password);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !["55434", "55435"].includes(url.port) ||
      !password ||
      /\s/.test(password) ||
      [...password].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      url.search ||
      url.hash ||
      // Reject normalized dot segments, percent-encoded identifiers, host tricks.
      !/^(postgres|postgresql):\/\/[^/@]+@(?:127\.0\.0\.1|localhost|\[::1\]):(?:55434|55435)\/[a-z0-9_]+$/.test(
        value,
      )
    )
      throw new Error();
    return url;
  } catch {
    throw new Error("Invalid isolated BookStore auth-spike database URL.");
  }
}

/** Returns the original URL; never falls back to TEST_DATABASE_URL/DATABASE_URL. */
export function validateSpikeBaseUrl(value: string): string {
  const url = parseUrl(value);
  if (
    url.username !== "bookstore_spike_bootstrap" ||
    !(
      (url.port === "55434" && url.pathname === "/bookstore_auth_spike_test") ||
      (url.port === "55435" && url.pathname === "/bookstore_auth_spike_ci")
    )
  )
    throw new Error(
      "Spike administration requires the exact bootstrap user and local/CI base database/port.",
    );
  return value;
}

/** Validates purpose AND identical 12-hex role/database suffix. No catalog URLs. */
export function validatePurposeUrl(
  value: string,
  purpose: SpikePurpose,
): string {
  const url = parseUrl(value);
  const suffix = databasePattern.exec(url.pathname.slice(1))?.[1];
  if (
    !purposes.includes(purpose) ||
    !suffix ||
    url.username !== `bs_${suffix}_${purpose}`
  ) {
    throw new Error(
      "Spike URL role, purpose and disposable database must match exactly.",
    );
  }
  return value;
}

function identifier(value: string): string {
  if (
    !databasePattern.test(value) &&
    !/^bs_[a-f0-9]{12}_(migrate|reader|auth|staff)$/.test(value)
  ) {
    throw new Error("Refusing an unowned spike identifier.");
  }
  return `"${value}"`;
}

// No raw pg errors/SQL/URLs escape: CREATE ROLE statements contain credentials.
function safeError(stage: string, error: unknown): Error {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  return new Error(
    `Auth-spike ${stage} failed${/^[A-Z0-9]{5}$/.test(code) ? ` (SQLSTATE ${code})` : ""}; credentials and SQL suppressed.`,
  );
}

async function connected<T>(
  url: string,
  stage: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: url,
    // Bootstrap is a local superuser. Suppress password-bearing SQL even on errors.
    ...(new URL(url).username === "bookstore_spike_bootstrap"
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
      `Auth-spike ${stage} failed; see sanitized errors.`,
    );
  return result as T;
}

/**
 * Reads ONLY process.env.SPIKE_TEST_DATABASE_URL. Does not load env files.
 * Returns name + four secret URLs + grantRuntimePrivileges()/dispose().
 * No admin URL or pg clients are exposed, no SQL migrations/seeding are applied.
 * Runtime grants cover existing objects only; rerun after further migrations.
 */
export async function createSpikeDatabase(): Promise<SpikeDatabase> {
  const base = process.env.SPIKE_TEST_DATABASE_URL;
  if (!base)
    throw new Error(
      "SPIKE_TEST_DATABASE_URL is required for the experimental spike.",
    );
  validateSpikeBaseUrl(base);
  const suffix = randomBytes(6).toString("hex");
  const name = `bookstore_auth_spike_test_${suffix}`;
  const marker = `bookstore-auth-spike:${suffix}:${randomBytes(16).toString("hex")}`;
  const roles = Object.fromEntries(
    purposes.map((purpose) => [purpose, `bs_${suffix}_${purpose}`]),
  ) as Record<SpikePurpose, string>;
  const passwords = Object.fromEntries(
    purposes.map((purpose) => [purpose, randomBytes(32).toString("hex")]),
  ) as Record<SpikePurpose, string>;
  const urls = Object.fromEntries(
    purposes.map((purpose) => {
      const url = new URL(base);
      url.username = roles[purpose];
      url.password = passwords[purpose];
      url.pathname = `/${name}`;
      return [purpose, validatePurposeUrl(url.toString(), purpose)];
    }),
  ) as Record<SpikePurpose, string>;
  const ownedRoles = new Set<string>();
  let databaseCreated = false;
  let databaseMarked = false;
  let disposed = false;

  async function cleanup(): Promise<void> {
    if (disposed) return;
    await connected(base!, "cleanup", async (admin) => {
      if (databaseCreated) {
        if (created.get(name) !== marker)
          throw new Error("Database is not owned by this run.");
        const result = await admin.query<{
          marker: string | null;
          owner: string;
        }>(
          "SELECT shobj_description(d.oid, 'pg_database') AS marker, r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1",
          [name],
        );
        if (result.rows.length === 0) {
          // CREATE may have failed before taking effect, or DROP's response was lost.
          databaseCreated = false;
          created.delete(name);
        } else {
          if (
            result.rows.length !== 1 ||
            result.rows[0].owner !== roles.migrate
          ) {
            throw new Error(
              "Database ownership mismatch; refusing drop and role cleanup.",
            );
          }
          // Recover only the CREATE/COMMENT partial-failure window, and only for
          // the new database owned by this run's independently marked role.
          if (!databaseMarked && result.rows[0].marker === null) {
            const owner = await admin.query<{ marker: string | null }>(
              "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
              [roles.migrate],
            );
            if (
              !ownedRoles.has(roles.migrate) ||
              owner.rows[0]?.marker !== marker
            )
              throw new Error("Migration role marker mismatch.");
            await admin.query(
              `COMMENT ON DATABASE ${identifier(name)} IS '${marker}'`,
            );
            databaseMarked = true;
          } else if (result.rows[0].marker !== marker) {
            throw new Error(
              "Database marker mismatch; refusing drop and role cleanup.",
            );
          }
          // No FORCE, pg_terminate_backend, DROP OWNED, or other databases.
          await admin.query(`DROP DATABASE ${identifier(name)}`);
          databaseCreated = false;
          created.delete(name);
        }
      }
      const failures: Error[] = [];
      for (const role of [...ownedRoles]) {
        try {
          const result = await admin.query<{ marker: string | null }>(
            "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
            [role],
          );
          // A failed/rolled-back creation transaction can leave no role at all.
          if (result.rows.length === 0) {
            ownedRoles.delete(role);
            continue;
          }
          if (result.rows.length !== 1 || result.rows[0].marker !== marker)
            throw new Error("Role marker mismatch; refusing drop.");
          await admin.query(`DROP ROLE ${identifier(role)}`);
          ownedRoles.delete(role);
        } catch (error) {
          failures.push(safeError("owned role cleanup", error));
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Some owned spike roles could not be removed; cleanup may be retried.",
        );
      disposed = true;
    });
  }

  try {
    await connected(base, "bootstrap", async (admin) => {
      // All role creations/comments are atomic. No role memberships are granted.
      await admin.query("BEGIN");
      try {
        for (const purpose of purposes) {
          // Track attempted names before the round trip, including ambiguous COMMIT failures.
          ownedRoles.add(roles[purpose]);
          await admin.query(
            `CREATE ROLE ${identifier(roles[purpose])} LOGIN PASSWORD '${passwords[purpose]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`,
          );
          await admin.query(
            `COMMENT ON ROLE ${identifier(roles[purpose])} IS '${marker}'`,
          );
        }
        await admin.query("COMMIT");
      } catch (error) {
        try {
          await admin.query("ROLLBACK");
        } catch (rollback) {
          throw new AggregateError(
            [
              safeError("role creation", error),
              safeError("role rollback", rollback),
            ],
            "Spike role transaction failed.",
          );
        }
        throw error;
      }
      // Track intent before sending nontransactional CREATE, so a lost server
      // response still triggers guarded cleanup rather than orphaning a database.
      databaseCreated = true;
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
      for (const purpose of purposes) {
        await admin.query(
          `GRANT CONNECT ON DATABASE ${identifier(name)} TO ${identifier(roles[purpose])}`,
        );
      }
    });
    await connected(
      urls.migrate,
      "initial schema isolation",
      async (migration) => {
        await migration.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
        await migration.query(
          "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
        );
      },
    );
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Spike creation AND partial-creation cleanup failed for ${name}; inspect only this run's marked objects. No forced cleanup was attempted.`,
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
    async grantRuntimePrivileges() {
      if (disposed || !databaseCreated || created.get(name) !== marker)
        throw new Error("Spike database is not live and owned by this run.");
      await connected(urls.migrate, "runtime grants", async (migration) => {
        await migration.query("BEGIN");
        try {
          // Fail if any expected schema is missing; never create substitute schemas.
          for (const schema of ["public", "identity", "staff", "audit"]) {
            await migration.query(
              `REVOKE ALL ON SCHEMA "${schema}" FROM PUBLIC`,
            );
            await migration.query(
              `REVOKE ALL ON ALL TABLES IN SCHEMA "${schema}" FROM PUBLIC`,
            );
            await migration.query(
              `REVOKE ALL ON ALL SEQUENCES IN SCHEMA "${schema}" FROM PUBLIC`,
            );
            await migration.query(
              `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "${schema}" FROM PUBLIC`,
            );
            for (const purpose of ["reader", "auth", "staff"] as const) {
              const role = identifier(roles[purpose]);
              await migration.query(
                `REVOKE ALL ON SCHEMA "${schema}" FROM ${role}`,
              );
              await migration.query(
                `REVOKE ALL ON ALL TABLES IN SCHEMA "${schema}" FROM ${role}`,
              );
              await migration.query(
                `REVOKE ALL ON ALL SEQUENCES IN SCHEMA "${schema}" FROM ${role}`,
              );
              await migration.query(
                `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "${schema}" FROM ${role}`,
              );
            }
          }
          const reader = identifier(roles.reader),
            auth = identifier(roles.auth),
            staff = identifier(roles.staff);
          await migration.query(`GRANT USAGE ON SCHEMA public TO ${reader}`);
          await migration.query(
            `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${reader}`,
          );
          await migration.query(`GRANT USAGE ON SCHEMA identity TO ${auth}`);
          await migration.query(
            `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO ${auth}`,
          );
          await migration.query(
            `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity TO ${auth}`,
          );
          await migration.query(
            `GRANT USAGE ON SCHEMA staff, audit TO ${staff}`,
          );
          await migration.query(
            `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA staff TO ${staff}`,
          );
          await migration.query(
            `GRANT INSERT, SELECT ON ALL TABLES IN SCHEMA audit TO ${staff}`,
          );
          await migration.query(
            `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA staff, audit TO ${staff}`,
          );
          await migration.query("COMMIT");
        } catch (error) {
          try {
            await migration.query("ROLLBACK");
          } catch (rollback) {
            throw new AggregateError(
              [
                safeError("runtime grants", error),
                safeError("grant rollback", rollback),
              ],
              "Spike privilege transaction failed.",
            );
          }
          throw error;
        }
      });
    },
    dispose: cleanup,
  };
}
