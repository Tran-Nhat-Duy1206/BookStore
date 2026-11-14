import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedCatalog, catalogSeedId } from "../../prisma/seed";
import { books } from "../../src/modules/catalog/data";
import { PrismaClient as CatalogClient } from "../../src/generated/prisma/client";
import { runSecurityMigrations } from "../../scripts/security-database";
import { assertFoundationUrl } from "../../src/server/security/database-config";
import {
  ControlFixtures,
  secretSafe,
  type SyntheticPrincipal,
} from "../admission-controls/fixtures";

// ADR020: accepted-main aefabf65f1b66d1ece5c7e5729e98a4c617c2669 already
// contains exactly001–007. This is seeded SAME-HISTORY no-op upgrade evidence,
// NOT a005→006 upgrade, physical backup/restore, OS rollback or safe rotation.
// The parent Git immutability gate separately binds these source bytes to main;
// source/ledger equality here does not independently attest Git ancestry.
const migrations = [
  "001_catalog_base",
  "002_catalog_invariants",
  "003_catalog_identity_checks",
  "004_security_identity",
  "005_security_foundation",
  "006_durable_admission_controls",
  "007_restricted_https_transport",
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
  "control_private.secrets",
  "control_private.clock_state",
  "control_private.configuration_witness",
  "control_private.approved_generations",
  "control_private.retired_users",
  "control_private.session_observations",
  "control_private.session_controls",
  "control_private.budgets",
  "control_private.replay_burns",
  "control_private.attempts",
] as const;
const fx = new ControlFixtures();
const scenario = (name: string, run: () => Promise<void>) =>
  it(name, () => secretSafe(run));
beforeAll(() => secretSafe(() => fx.start()));
beforeEach(() => secretSafe(() => fx.resetScenario()));
afterAll(() => secretSafe(() => fx.stop()));

async function assertOwnedOfflineFixture(): Promise<void> {
  const url = new URL(assertFoundationUrl(fx.owned.migrationUrl, "migrate"));
  const suffix = /^bookstore_security_test_([a-f0-9]{12})$/.exec(
    fx.owned.name,
  )?.[1];
  if (!suffix || url.pathname !== `/${fx.owned.name}`)
    throw new Error("Continuity fixture binding rejected.");
  const result = await fx.migration.query<{ owned: boolean }>(
    `SELECT current_database()=$1 AND current_user=$2 AND session_user=$2
      AND pg_get_userbyid(d.datdba)=$2
      AND shobj_description(d.oid,'pg_database') ~ $3
      AND shobj_description(r.oid,'pg_authid')=shobj_description(d.oid,'pg_database') AS owned
     FROM pg_database d JOIN pg_roles r ON r.rolname=$2 WHERE d.datname=$1`,
    [
      fx.owned.name,
      url.username,
      `^bookstore-security-foundation:${suffix}:[a-f0-9]{32}$`,
    ],
  );
  if (result.rowCount !== 1 || result.rows[0]?.owned !== true)
    throw new Error("Continuity fixture ownership rejected.");
}

async function actualCode(principal: SyntheticPrincipal): Promise<string> {
  // Actual maintained current-window generation; no Date.now spy or time shift.
  return createOTP(base32.decode(principal.secret), {
    period: 30,
    digits: 6,
  }).totp();
}

async function sourceChecksums(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const name of migrations) {
    const bytes = await readFile(
      new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url),
    );
    result.set(name, createHash("sha256").update(bytes).digest("hex"));
  }
  return result;
}

async function ledgerMatches(checksums: Map<string, string>): Promise<boolean> {
  const result = await fx.migration.query<{
    migration_name: string;
    checksum: string;
  }>(
    `SELECT migration_name,checksum FROM public._prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
  );
  return (
    result.rows.length === migrations.length &&
    result.rows.every(
      (row, index) =>
        row.migration_name === migrations[index] &&
        row.checksum === checksums.get(row.migration_name),
    )
  );
}

async function tableSnapshot(
  tables: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  // Only compile-time table lists reach SQL identifiers. Raw key/credential rows
  // never leave PG: hash complete canonical row images INSIDE the offline query.
  // Neither these hashes nor any dynamic identifier enter assertion output.
  for (const table of tables) {
    const row = await fx.migration.query<{ fingerprint: string }>(
      `SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(item)
        ORDER BY to_jsonb(item)::text COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') AS fingerprint
       FROM ${table} item`,
    );
    if (row.rowCount !== 1) throw new Error("Continuity row witness missing.");
    result.set(table, row.rows[0].fingerprint);
  }
  return result;
}
function unchanged(
  first: Map<string, string>,
  second: Map<string, string>,
): boolean {
  return (
    first.size === second.size &&
    [...first].every(([name, hash]) => second.get(name) === hash)
  );
}

async function aclSnapshot(): Promise<string> {
  const schemas = [
    "public",
    "identity",
    "staff",
    "audit",
    "control_private",
    "control_crypto",
  ];
  const result = await fx.migration.query<{ data: unknown }>(
    `SELECT jsonb_build_object(
      'schemas',(SELECT jsonb_agg(jsonb_build_array(nspname,nspowner,nspacl) ORDER BY nspname)
        FROM pg_namespace WHERE nspname=ANY($1::text[])),
      'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl) ORDER BY n.nspname,c.relname)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])),
      'columns',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attnum,a.attacl) ORDER BY n.nspname,c.relname,a.attnum)
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped),
      'functions',(SELECT jsonb_agg(jsonb_build_array(n.nspname,p.proname,p.proargtypes::text,p.proowner,p.proacl,p.prosecdef,p.proconfig) ORDER BY p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1::text[])),
      'defaults',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.oid) FROM pg_default_acl a
        WHERE a.defaclnamespace IN (SELECT oid FROM pg_namespace WHERE nspname=ANY($1::text[]))),
      'roles',(SELECT jsonb_agg(jsonb_build_array(r.oid,r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolbypassrls,r.rolconfig) ORDER BY r.oid)
        FROM pg_roles r WHERE r.rolname=ANY($2::text[])),
      'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member) FROM pg_auth_members m
        WHERE m.member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($2::text[]))),
      'database',(SELECT jsonb_build_array(datdba,datacl) FROM pg_database WHERE datname=current_database())
     ) AS data`,
    [
      schemas,
      ["migrate", "reader", "auth", "staff", "worker", "verifier", "guard"].map(
        (purpose) =>
          new URL(fx.owned.migrationUrl).username.replace(
            /_migrate$/,
            `_${purpose}`,
          ),
      ),
    ],
  );
  return createHash("sha256")
    .update(JSON.stringify(result.rows[0].data))
    .digest("hex");
}

async function catalogIdentityMatches(): Promise<boolean> {
  for (const book of books) {
    const result = await fx.migration.query<{ matches: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM public."Product" p JOIN public."Sku" s ON s."productId"=p.id
        JOIN public."Edition" e ON e.id=s."editionId" WHERE p.id=$1 AND p."publicId"=$4 AND p.slug=$5
        AND s.id=$2 AND s."publicId"=$4 AND e.id=$3 AND e."publicId"=$4) AS matches`,
      [
        catalogSeedId("product", book.id),
        catalogSeedId("sku", book.id),
        catalogSeedId("edition", book.id),
        book.id,
        book.slug,
      ],
    );
    if (result.rows[0]?.matches !== true) return false;
  }
  return true;
}

describe("integrated accepted-main no-op upgrade and OFFLINE replay-history rollback SIMULATION", () => {
  scenario(
    "preserves seeded accepted-main001–007 catalog IDs, real proof/burn/epoch and exact role ACLs on canonical no-op deploy",
    async () => {
      await assertOwnedOfflineFixture();
      const catalog = new CatalogClient({
        adapter: new PrismaPg({
          connectionString: assertFoundationUrl(
            fx.owned.migrationUrl,
            "migrate",
          ),
          max: 2,
        }),
      });
      try {
        await seedCatalog(catalog);
      } finally {
        await catalog.$disconnect();
      }
      const principal = await fx.createPrincipal();
      const admission = await fx.admitted(
        principal,
        await actualCode(principal),
      );
      expect((await fx.subject.check(admission.jar.header)).allowed).toBe(true);
      const sourceBefore = await sourceChecksums();
      expect(await ledgerMatches(sourceBefore)).toBe(true);
      expect(await catalogIdentityMatches()).toBe(true);
      const tables = [
        ...catalogTables.map((name) => `public."${name}"`),
        ...securityTables,
        "public._prisma_migrations",
      ];
      const before = await tableSnapshot(tables);
      const aclBefore = await aclSnapshot();
      // Existing pinned CLI deploy only. No manual ledger DDL/resolve/INSERT,
      // alternate history, ownership transfer, re-hardening or state repair.
      await runSecurityMigrations(fx.owned.migrationUrl);
      expect(unchanged(sourceBefore, await sourceChecksums())).toBe(true);
      expect(await ledgerMatches(sourceBefore)).toBe(true);
      expect(unchanged(before, await tableSnapshot(tables))).toBe(true);
      expect((await aclSnapshot()) === aclBefore).toBe(true);
      expect(await catalogIdentityMatches()).toBe(true);
      expect((await fx.subject.check(admission.jar.header)).allowed).toBe(true);
    },
  );

  scenario(
    "demonstrates lost replay continuity after OFFLINE removal of ONLY a new fixture user's burn, NOT safe restore",
    async () => {
      const principal = await fx.createPrincipal();
      const code = await actualCode(principal);
      const first = await fx.admitted(principal, code);
      expect((await fx.subject.check(first.jar.header)).allowed).toBe(true);
      const second = await fx.begin(principal);
      expect(second.operation.response.ok).toBe(true);
      const rejected = await fx.subject.verifyTotp(code, second.jar.header);
      expect(!rejected.response.ok && rejected.evidenceHandle === null).toBe(
        true,
      );
      const deniedBeforeNative = await fx.migration.query<{ matches: boolean }>(
        `SELECT (SELECT count(*)=1 FROM staff.admissions WHERE user_id=$1 AND mode='verified')
        AND (SELECT count(*)=1 FROM control_private.attempts WHERE user_id=$1 AND operation_handle IS NOT NULL)
        AND EXISTS(SELECT 1 FROM control_private.attempts WHERE user_id=$1 AND state='denied' AND operation_handle IS NULL)
        AND (SELECT count(*)=1 FROM audit.events WHERE subject_id=$1 AND action='control.reserved') AS matches`,
        [principal.userId],
      );
      // Source-correlated pre-SDK reservation witness; no fake native-call hook.
      expect(deniedBeforeNative.rows[0].matches).toBe(true);
      await assertOwnedOfflineFixture();
      const retainedTables = securityTables.filter(
        (table) => table !== "control_private.replay_burns",
      );
      const retainedBefore = await tableSnapshot(retainedTables);
      const aclBefore = await aclSnapshot();
      const removed = await fx.migration.query(
        `DELETE FROM control_private.replay_burns b WHERE b.code_mac IN
        (SELECT a.code_mac FROM control_private.attempts a
         WHERE a.user_id=$1 AND a.final_session_id=$2 AND a.state='consumed'
           AND a.code_mac IS NOT NULL AND a.reserved_at=b.reserved_at)
        AND b.expires_at>clock_timestamp()`,
        [principal.userId, first.sessionId],
      );
      expect(removed.rowCount === 1).toBe(true);
      expect(
        unchanged(retainedBefore, await tableSnapshot(retainedTables)),
      ).toBe(true);
      expect((await aclSnapshot()) === aclBefore).toBe(true);
      // Model ONLY replay-row absence in an older snapshot. No budget/native
      // limiter/account/key/generation/clock/old-proof reset, retry or time shift.
      // Three password ceremonies and TWO actual native MFA calls remain bounded
      // by the unchanged existing limits. If the actual code ages out, fail honestly.
      const third = await fx.admitted(principal, code);
      const observed = await fx.migration.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM staff.admissions WHERE user_id=$1 AND mode='verified'",
        [principal.userId],
      );
      expect(observed.rows[0].count).toBe(2);
      expect(third.sessionId !== first.sessionId).toBe(true);
      expect((await fx.subject.check(first.jar.header)).allowed).toBe(true);
      expect((await fx.subject.check(third.jar.header)).allowed).toBe(true);
      // This expected second admission proves an EXTERNAL HISTORY ASSUMPTION,
      // never a supported reset API, physical restore, safe rotation or safe recovery.
    },
  );
});
