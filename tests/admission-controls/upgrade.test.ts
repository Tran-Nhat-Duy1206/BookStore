import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient as CatalogClient } from "../../src/generated/prisma/client";
import { seedCatalog } from "../../prisma/seed";
import { assertFoundationUrl } from "../../src/server/security/database-config";
import { runSecurityMigrations } from "../../scripts/security-database";
import {
  createFoundationDatabase,
  type FoundationDatabase,
} from "../security-foundation/database";

const root = fileURLToPath(new URL("../../", import.meta.url));
const prefix = [
  "001_catalog_base",
  "002_catalog_invariants",
  "003_catalog_identity_checks",
  "004_security_identity",
  "005_security_foundation",
] as const;
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
] as const;
// These are the actual canonical names, not an alternate Prisma/schema history.
const securityTables = [
  'identity."User"',
  'identity."Session"',
  'identity."Account"',
  'identity."Verification"',
  'identity."TwoFactor"',
  'identity."RateLimit"',
  "staff.roles",
  "staff.permissions",
  "staff.role_permissions",
  "staff.principals",
  "staff.role_grants",
  "staff.admissions",
  "staff.governance",
  "audit.events",
  "audit.provider_events",
  "audit.denials",
] as const;
let owned: FoundationDatabase | undefined;
const clients = new Set<Client>();
let catalog: CatalogClient | undefined;
let baseline: Map<string, string>;
let originalLedger: { migration_name: string; checksum: string }[];
const canonicalChecksums = new Map<string, string>();
let fixtureUser: string;
let fixtureSession: string;

async function safe<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && error.name === "AssertionError") throw error;
    const states = new Set<string>();
    const transport = new Set<string>();
    let missingConfiguration = false;
    function collect(value: unknown, depth = 0): void {
      if (depth > 5) return;
      const code =
        typeof value === "object" && value !== null && "code" in value
          ? String(value.code)
          : "";
      if (/^[A-Z0-9]{5}$/.test(code)) states.add(code);
      if (value instanceof Error) {
        const state = /SQLSTATE ([A-Z0-9]{5})/.exec(value.message);
        if (state) states.add(state[1]);
        const connection =
          /\(invariant (connection_refused|connection_reset|connection_timeout)\)/.exec(
            value.message,
          );
        if (connection) transport.add(connection[1]);
        if (
          value.message ===
          "SECURITY_TEST_DATABASE_URL is required for the security foundation."
        )
          missingConfiguration = true;
      }
      if (value instanceof AggregateError)
        for (const child of value.errors.slice(0, 8)) collect(child, depth + 1);
    }
    collect(error);
    throw new Error(
      `Owned historical upgrade unavailable${states.size ? ` (SQLSTATE ${[...states].join(",")})` : ""}${missingConfiguration ? " (missing_test_configuration)" : ""}${transport.size ? ` (transport ${[...transport].join(",")})` : ""}; details suppressed.`,
    );
  }
}
async function connect(url: string): Promise<Client> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  clients.add(client);
  await client.connect();
  return client;
}
async function close(client: Client): Promise<void> {
  await client.end();
  clients.delete(client);
}

async function resolveApplied(
  url: string,
  migration: (typeof prefix)[number],
): Promise<void> {
  assertFoundationUrl(url, "migrate");
  // Actual pinned Prisma CLI records the normal public._prisma_migrations
  // checksum/metadata. No manual ledger DDL/inserts, migration copy, shadow DB,
  // migrate-dev/reset, second config/history or credentials on argv.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "test" };
  for (const key of [
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
    if (process.env[key] !== undefined) env[key] = process.env[key];
  env.SECURITY_MIGRATION_DATABASE_URL = url;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../node_modules/prisma/build/index.js", import.meta.url),
        ),
        "migrate",
        "resolve",
        "--applied",
        migration,
        "--config",
        "prisma.security.config.ts",
      ],
      { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.once("error", () =>
      reject(new Error("Pinned historical ledger CLI unavailable.")),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Pinned historical ledger CLI failed.")),
    );
  });
}
async function ledger(client: Client) {
  const result = await client.query<{
    migration_name: string;
    checksum: string;
  }>(
    "SELECT migration_name,checksum FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name",
  );
  return result.rows;
}
async function dataSnapshot(client: Client): Promise<Map<string, string>> {
  const fingerprints = new Map<string, string>();
  for (const table of [
    ...catalogTables.map((name) => `public."${name}"`),
    ...securityTables,
  ]) {
    // Complete row images compared privately. Never send tokens, password/factor
    // placeholders, user IDs or hashes to assertion diffs/output/artifacts.
    const result = await client.query<{ data: unknown }>(
      `SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY to_jsonb(item)::text COLLATE "C"),'[]'::jsonb) AS data FROM ${table} item`,
    );
    fingerprints.set(
      table,
      createHash("sha256")
        .update(JSON.stringify(result.rows[0].data))
        .digest("hex"),
    );
  }
  return fingerprints;
}
function sameSnapshot(
  first: Map<string, string>,
  second: Map<string, string>,
): boolean {
  return (
    first.size === second.size &&
    [...first].every(([table, hash]) => second.get(table) === hash)
  );
}
async function syntheticHistoricalRows(client: Client): Promise<void> {
  fixtureUser = randomUUID();
  fixtureSession = randomUUID();
  // B.1 migration-only placeholders; deliberately NOT valid provider credentials,
  // completed MFA or any newly approved generation/verified admission.
  await client.query(
    'INSERT INTO identity."User"(id,name,email,"emailVerified","updatedAt","twoFactorEnabled") VALUES($1,\'Synthetic historical fixture\',$2,false,clock_timestamp(),false)',
    [fixtureUser, `${randomUUID()}@example.invalid`],
  );
  await client.query(
    'INSERT INTO identity."Account"(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$2,\'credential\',$2,$3,clock_timestamp())',
    [
      randomUUID(),
      fixtureUser,
      `synthetic-unverified-${randomBytes(32).toString("hex")}`,
    ],
  );
  await client.query(
    'INSERT INTO identity."TwoFactor"(id,"userId",secret,"backupCodes",verified) VALUES($1,$2,$3,$4,false)',
    [
      randomUUID(),
      fixtureUser,
      randomBytes(40).toString("base64url"),
      randomBytes(40).toString("base64url"),
    ],
  );
  await client.query(
    'INSERT INTO identity."Session"(id,token,"userId","expiresAt","updatedAt") VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\',clock_timestamp())',
    [fixtureSession, randomBytes(40).toString("base64url"), fixtureUser],
  );
  await client.query(
    "INSERT INTO staff.principals(user_id,status) VALUES($1,'active')",
    [fixtureUser],
  );
  await client.query(
    "INSERT INTO staff.role_grants(user_id,role_name) VALUES($1,'Analyst')",
    [fixtureUser],
  );
  await client.query(
    `INSERT INTO staff.admissions(session_id,user_id,authz_version,mode)
    SELECT $1,user_id,authz_version,'pending' FROM staff.principals WHERE user_id=$2`,
    [fixtureSession, fixtureUser],
  );
}

beforeAll(() =>
  safe(async () => {
    owned = await createFoundationDatabase();
    const migration = await connect(owned.migrationUrl);
    try {
      // Historical replay fixture of the EXACT canonical001..005 bytes. The
      // existing canonical006 directory/config remains untouched and is deployed
      // later through normal migrate deploy, not through a fabricated second chain.
      for (const name of prefix) {
        const bytes = await readFile(
          new URL(
            `../../prisma/migrations/${name}/migration.sql`,
            import.meta.url,
          ),
        );
        canonicalChecksums.set(
          name,
          createHash("sha256").update(bytes).digest("hex"),
        );
        await migration.query(bytes.toString("utf8"));
        await resolveApplied(owned.migrationUrl, name);
      }
      catalog = new CatalogClient({
        adapter: new PrismaPg({
          connectionString: assertFoundationUrl(owned.migrationUrl, "migrate"),
          max: 2,
        }),
      });
      await seedCatalog(catalog);
      await catalog.$disconnect();
      catalog = undefined;
      await syntheticHistoricalRows(migration);
      originalLedger = await ledger(migration);
      expect(originalLedger.length).toBe(5);
      expect(
        originalLedger.every(
          (row, index) =>
            row.migration_name === prefix[index] &&
            row.checksum === canonicalChecksums.get(row.migration_name),
        ),
      ).toBe(true);
      baseline = await dataSnapshot(migration);
    } finally {
      await close(migration);
    }
    // Exercises the real005-only hardener BEFORE maintenance. No caller-owned
    // clients/pools remain alive when prepareControlUpgrade is invoked later.
    await owned.hardenPrivileges();
  }),
);

afterAll(() =>
  safe(async () => {
    const results = await Promise.allSettled([
      ...[...clients].map((client) => client.end()),
      ...(catalog ? [catalog.$disconnect()] : []),
    ]);
    if (results.some((result) => result.status === "rejected"))
      throw new Error(
        "Historical fixture close failed; no forced cleanup attempted.",
      );
    await owned?.dispose();
  }),
);

// Deliberately one serialized historical005 -> maintenance ->006 trajectory.
// No skipped/retried tests or alternate historical migration directory.
describe("owned additive upgrade from genuinely hardened005", () => {
  it("refuses maintenance while another client is connected without revoking its capabilities", () =>
    safe(async () => {
      const staff = await connect(owned!.staffUrl);
      try {
        let rejected = false;
        try {
          await owned!.prepareControlUpgrade();
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
        const unchanged = await staff.query<{ safe: boolean }>(
          `SELECT
        has_database_privilege(current_database(),'CONNECT')
        AND has_function_privilege('staff.check_access(text,text,text,bigint)','EXECUTE')
        AND pg_get_userbyid(p.proowner)=$1 AS safe
        FROM pg_proc p WHERE p.oid='staff.check_access(text,text,text,bigint)'::regprocedure`,
          [new URL(owned!.staffUrl).username.replace(/_staff$/, "_guard")],
        );
        expect(unchanged.rowCount).toBe(1);
        expect(unchanged.rows[0].safe).toBe(true);
      } finally {
        await close(staff);
      }
    }));

  it("upgrades the same canonical ledger preserving all catalog and existing security rows", () =>
    safe(async () => {
      await owned!.prepareControlUpgrade();
      await runSecurityMigrations(owned!.migrationUrl);
      await owned!.hardenPrivileges();
      const migration = await connect(owned!.migrationUrl);
      try {
        const afterLedger = await ledger(migration);
        expect(afterLedger.length).toBe(7);
        expect(
          afterLedger
            .slice(0, 5)
            .every(
              (row, index) =>
                row.migration_name === originalLedger[index].migration_name &&
                row.checksum === originalLedger[index].checksum,
            ),
        ).toBe(true);
        expect(
          afterLedger[5].migration_name === "006_durable_admission_controls",
        ).toBe(true);
        expect(afterLedger[6].migration_name).toBe(
          "007_restricted_https_transport",
        );
        expect(sameSnapshot(baseline, await dataSnapshot(migration))).toBe(
          true,
        );
        const dormant = await migration.query<{ safe: boolean }>(
          `SELECT
        (SELECT count(*)=0 FROM control_private.approved_generations)
        AND (SELECT count(*)=0 FROM control_private.session_controls)
        AND (SELECT count(*)=0 FROM staff.admissions WHERE mode='verified')
        AND (SELECT count(*)=1 FROM staff.admissions WHERE session_id=$1 AND user_id=$2 AND mode='pending')
        AND (SELECT count(*)=1 FROM control_private.session_observations o JOIN identity."Session" s ON s.id=o.session_id
          WHERE o.session_id=$1 AND o.user_id=$2 AND NOT o.retired AND o.token_mac=control_private.mac('session-token',s.token))
        AND (SELECT state='uninitialized' FROM staff.governance WHERE singleton)
        AND (SELECT octet_length(key_bytes)=32 AND sha256(key_bytes)=key_checksum FROM control_private.secrets WHERE singleton)
        AS safe`,
          [fixtureSession, fixtureUser],
        );
        expect(dormant.rows[0].safe).toBe(true);
        for (const url of [
          owned!.readerUrl,
          owned!.authUrl,
          owned!.staffUrl,
          owned!.workerUrl,
          owned!.verifierUrl,
        ]) {
          const role = new URL(url).username;
          const runtime = await migration.query<{ safe: boolean }>(
            `SELECT
          r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
          AND NOT r.rolbypassrls AND NOT r.rolinherit
          AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
          AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
          AND NOT has_database_privilege(r.oid,current_database(),'TEMP')
          AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege(r.oid,n.oid,'CREATE'))
          AND NOT has_function_privilege(r.oid,'staff.check_access_b1(text,text,text,bigint)'::regprocedure,'EXECUTE') AS safe
          FROM pg_roles r WHERE r.rolname=$1`,
            [role],
          );
          expect(runtime.rowCount).toBe(1);
          expect(runtime.rows[0].safe).toBe(true);
        }
        const owners = await migration.query<{ safe: boolean }>(
          `SELECT bool_and(
        pg_get_userbyid(p.proowner)=$1 AND NOT r.rolcanlogin AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]) AS safe
        FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
        WHERE p.oid IN ('staff.check_access(text,text,text,bigint)'::regprocedure,'staff.check_access_b1(text,text,text,bigint)'::regprocedure,'audit.staff_change()'::regprocedure)`,
          [new URL(owned!.staffUrl).username.replace(/_staff$/, "_guard")],
        );
        expect(owners.rows[0].safe).toBe(true);
      } finally {
        await close(migration);
      }
      const staff = await connect(owned!.staffUrl);
      try {
        const check = await staff.query<{ decision: { allowed: boolean } }>(
          "SELECT staff.check_access($1::text,$2::text,'security.self.read'::text,NULL::bigint) AS decision",
          [fixtureUser, fixtureSession],
        );
        expect(check.rows[0].decision.allowed).toBe(false);
      } finally {
        await close(staff);
      }
    }));

  it("refuses an already-completed006 maintenance request without changing runtime grants", () =>
    safe(async () => {
      let rejected = false;
      try {
        await owned!.prepareControlUpgrade();
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      const verifier = await connect(owned!.verifierUrl);
      try {
        const result = await verifier.query<{ safe: boolean }>(`SELECT
        has_database_privilege(current_database(),'CONNECT')
        AND has_function_privilege('control_private.clock_probe()','EXECUTE') AS safe`);
        expect(result.rows[0].safe).toBe(true);
      } finally {
        await close(verifier);
      }
    }));
});
