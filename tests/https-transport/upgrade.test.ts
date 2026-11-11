import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient as CatalogClient } from "../../src/generated/prisma/client";
import { seedCatalog } from "../../prisma/seed";
import { runSecurityMigrations } from "../../scripts/security-database";
import { createAdmissionAuthority } from "../../src/server/security/admission-authority";
import {
  createFoundationDatabase,
  type FoundationDatabase,
} from "../security-foundation/database";
import { seedOfflineAdmissionControls } from "../admission-controls/offline-fixture";
import { secretSafe } from "../admission-controls/fixtures";

const root = fileURLToPath(new URL("../../", import.meta.url));
const original = [
  "001_catalog_base",
  "002_catalog_invariants",
  "003_catalog_identity_checks",
  "004_security_identity",
  "005_security_foundation",
  "006_durable_admission_controls",
];
const catalogs = [
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
const tables = [
  ...catalogs.map((name) => `public."${name}"`),
  ...[
    "User",
    "Session",
    "Account",
    "Verification",
    "TwoFactor",
    "RateLimit",
  ].map((name) => `identity."${name}"`),
  ...[
    "roles",
    "permissions",
    "role_permissions",
    "principals",
    "role_grants",
    "admissions",
    "governance",
  ].map((name) => `staff.${name}`),
  ...["events", "provider_events", "denials"].map((name) => `audit.${name}`),
  ...[
    "secrets",
    "clock_state",
    "configuration_witness",
    "approved_generations",
    "retired_users",
    "session_observations",
    "session_controls",
    "budgets",
    "replay_burns",
    "attempts",
  ].map((name) => `control_private.${name}`),
];
let owned: FoundationDatabase | undefined;
const clients = new Set<Client>();
const user = randomUUID(),
  sid = randomUUID();
// Structural preservation fixtures ONLY: not SDK authentication/MFA/approval.
const cookie = "__Secure-bookstore-provider-proof.two_factor=structural-only";
const attempt = randomBytes(32).toString("hex");
let ledgerBefore: { migration_name: string; checksum: string }[];
async function connect(url: string) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    options: "-c application_name=bookstore-transport-offline-upgrade",
  });
  clients.add(client);
  await client.connect();
  return client;
}
async function close(client: Client) {
  await client.end();
  clients.delete(client);
}
async function markApplied(url: string, name: string) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
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
        name,
        "--config",
        "prisma.security.config.ts",
      ],
      { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.once("error", () =>
      reject(new Error("Canonical transport upgrade ledger unavailable.")),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Canonical transport upgrade ledger failed.")),
    );
  });
}
async function ledger(client: Client) {
  return (
    await client.query<{ migration_name: string; checksum: string }>(
      "SELECT migration_name,checksum FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name",
    )
  ).rows;
}
async function snapshot(client: Client) {
  const images = new Map<string, string>();
  for (const table of tables) {
    const row = await client.query<{ data: unknown }>(
      `SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY to_jsonb(item)::text COLLATE "C"),'[]'::jsonb) AS data FROM ${table} item`,
    );
    images.set(
      table,
      createHash("sha256")
        .update(JSON.stringify(row.rows[0].data))
        .digest("hex"),
    );
  }
  return images;
}
function same(a: Map<string, string>, b: Map<string, string>) {
  return (
    a.size === b.size && [...a].every(([key, value]) => b.get(key) === value)
  );
}

beforeAll(
  () =>
    secretSafe(async () => {
      owned = await createFoundationDatabase();
      const migration = await connect(owned.migrationUrl);
      try {
        for (const name of original) {
          // Exact historical canonical bytes, same actual Prisma ledger/config.
          // No migration copies, second history, manual ledger or schema reset.
          const bytes = await readFile(
            new URL(
              `../../prisma/migrations/${name}/migration.sql`,
              import.meta.url,
            ),
          );
          await migration.query(bytes.toString("utf8"));
          await markApplied(owned.migrationUrl, name);
          const recorded = await ledger(migration);
          expect(
            recorded.at(-1)?.checksum ===
              createHash("sha256").update(bytes).digest("hex"),
          ).toBe(true);
        }
        const catalog = new CatalogClient({
          adapter: new PrismaPg({
            connectionString: owned.migrationUrl,
            max: 2,
          }),
        });
        try {
          await seedCatalog(catalog);
        } finally {
          await catalog.$disconnect();
        }
        await migration.query(
          'INSERT INTO identity."User"(id,name,email,"emailVerified","twoFactorEnabled","updatedAt") VALUES($1,\'Synthetic transport upgrade\',$2,true,false,clock_timestamp())',
          [user, `${user}@example.invalid`],
        );
        await migration.query(
          'INSERT INTO identity."Account"(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$2,\'credential\',$2,$3,clock_timestamp())',
          [randomUUID(), user, randomBytes(40).toString("base64url")],
        );
        await migration.query(
          'INSERT INTO identity."TwoFactor"(id,"userId",secret,"backupCodes",verified) VALUES($1,$2,$3,$4,false)',
          [
            randomUUID(),
            user,
            randomBytes(40).toString("base64url"),
            randomBytes(40).toString("base64url"),
          ],
        );
        await migration.query(
          'INSERT INTO identity."Session"(id,token,"userId","expiresAt","updatedAt") VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\',clock_timestamp())',
          [sid, randomBytes(40).toString("base64url"), user],
        );
        await migration.query(
          "INSERT INTO staff.principals(user_id,status) VALUES($1,'active')",
          [user],
        );
        await migration.query(
          "INSERT INTO staff.role_grants(user_id,role_name) VALUES($1,'Analyst')",
          [user],
        );
        await migration.query(
          "INSERT INTO staff.admissions(session_id,user_id,authz_version,mode) SELECT $1,user_id,authz_version,'pending' FROM staff.principals WHERE user_id=$2",
          [sid, user],
        );
      } finally {
        await close(migration);
      }
      await owned.hardenPrivileges();
      const client = await connect(owned.migrationUrl);
      try {
        await seedOfflineAdmissionControls(client, {
          userId: user,
          sessionId: sid,
        });
        await client.query(
          "UPDATE control_private.session_controls SET cookie_mac=control_private.mac('cookie',$1) WHERE session_id=$2",
          [cookie, sid],
        );
        await client.query(
          `INSERT INTO control_private.attempts(challenge_handle,user_id,generation_id,fingerprint,authz_version,permission_version,purpose,state,authenticated_at,primary_deadline,ip_scope,primary_cookie_mac,final_session_id)
      SELECT $1,c.user_id,c.generation_id,c.fingerprint,c.authz_version,c.permission_version,'login','bound',c.authenticated_at,c.authenticated_at+interval '120 seconds','unknown',control_private.mac('cookie',$2),c.session_id FROM control_private.session_controls c WHERE c.session_id=$3`,
          [attempt, cookie, sid],
        );
        await client.query(
          "INSERT INTO control_private.replay_burns(code_mac,reserved_at,expires_at) SELECT control_private.mac('user-code','structural-retained-burn'),n,n+interval '180 seconds' FROM (SELECT clock_timestamp() AS n) t",
        );
        await client.query(
          "INSERT INTO control_private.budgets(key_mac,window_start,window_end,used) SELECT control_private.mac('fixture-upgrade-budget','structural-retained-budget'),n,n+interval '15 minutes',4 FROM (SELECT clock_timestamp() AS n) t",
        );
        ledgerBefore = await ledger(client);
        expect(ledgerBefore.length).toBe(6);
      } finally {
        await close(client);
      }
    }),
  180000,
);
afterAll(() =>
  secretSafe(async () => {
    const settled = await Promise.allSettled(
      [...clients].map((client) => client.end()),
    );
    if (settled.some((result) => result.status === "rejected"))
      throw new Error("Transport upgrade cleanup failed; no force attempted.");
    await owned?.dispose();
  }),
);

describe("exact hardened006 to deny-only007 upgrade", () => {
  it("keeps legacy006 authority explicitly transport-disabled", () =>
    secretSafe(async () => {
      const authority = await createAdmissionAuthority({
        staffUrl: owned!.staffUrl,
        verifierUrl: owned!.verifierUrl,
      });
      try {
        expect(authority.transportSupported).toBe(false);
      } finally {
        await authority.close();
      }
    }));
  it("preserves every existing catalog/security/control row and original six checksums", () =>
    secretSafe(async () => {
      const beforeClient = await connect(owned!.migrationUrl);
      let before: Map<string, string>;
      try {
        before = await snapshot(beforeClient);
      } finally {
        await close(beforeClient);
      }
      await runSecurityMigrations(owned!.migrationUrl);
      await owned!.hardenPrivileges();
      const afterClient = await connect(owned!.migrationUrl);
      try {
        const after = await ledger(afterClient);
        expect(after.length).toBe(7);
        expect(
          after
            .slice(0, 6)
            .every(
              (row, index) =>
                row.migration_name === ledgerBefore[index].migration_name &&
                row.checksum === ledgerBefore[index].checksum,
            ),
        ).toBe(true);
        expect(after[6].migration_name).toBe("007_restricted_https_transport");
        expect(same(before!, await snapshot(afterClient))).toBe(true);
      } finally {
        await close(afterClient);
      }
      const authority = await createAdmissionAuthority({
        staffUrl: owned!.staffUrl,
        verifierUrl: owned!.verifierUrl,
      });
      try {
        expect(authority.transportSupported).toBe(true);
      } finally {
        await authority.close();
      }
    }));
  it("grants only exact STAFF denial calls with no issuer or direct private rights", () =>
    secretSafe(async () => {
      for (const [kind, url] of [
        ["auth", owned!.authUrl],
        ["reader", owned!.readerUrl],
        ["worker", owned!.workerUrl],
        ["verifier", owned!.verifierUrl],
        ["staff", owned!.staffUrl],
      ] as const) {
        const client = await connect(url);
        try {
          const actual = await client.query<{
            granted: boolean;
            private_usage: boolean;
            direct_private: boolean;
          }>(`SELECT
          count(*) FILTER(WHERE has_function_privilege(p.oid,'EXECUTE'))=2 AS granted,
          has_schema_privilege((SELECT oid FROM pg_namespace WHERE nspname='control_private'),'USAGE') AS private_usage,
          EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='control_private' AND (has_any_column_privilege(c.oid,'SELECT,INSERT,UPDATE,REFERENCES') OR has_table_privilege(c.oid,'DELETE,TRUNCATE,TRIGGER'))) AS direct_private
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='staff' AND p.proname IN ('reserve_transport_request','cancel_transport_context')`);
          expect(actual.rows[0].granted === (kind === "staff")).toBe(true);
          expect(actual.rows[0].direct_private).toBe(false);
          expect(actual.rows[0].private_usage === (kind === "verifier")).toBe(
            true,
          );
        } finally {
          await close(client);
        }
      }
    }));
  it("charges exactly120 across independent clients without extending denied cooldown", () =>
    secretSafe(async () => {
      const workers = await Promise.all(
        Array.from({ length: 4 }, () => connect(owned!.staffUrl)),
      );
      try {
        const lists = await Promise.all(
          workers.map(async (client) => {
            const allowed: boolean[] = [];
            for (let n = 0; n < 30; n++)
              allowed.push(
                (
                  await client.query<{ decision: { allowed: boolean } }>(
                    "SELECT staff.reserve_transport_request() AS decision",
                  )
                ).rows[0].decision.allowed,
              );
            return allowed;
          }),
        );
        expect(lists.flat().filter(Boolean).length).toBe(120);
        const migration = await connect(owned!.migrationUrl);
        try {
          const before = (
            await migration.query<{ end: string }>(
              "SELECT window_end::text AS end FROM control_private.budgets WHERE key_mac=control_private.mac('transport-ingress-v1','common-loopback')",
            )
          ).rows[0].end;
          const denied = (
            await workers[0].query<{
              decision: { allowed: boolean; reason: string };
            }>("SELECT staff.reserve_transport_request() AS decision")
          ).rows[0].decision;
          expect(!denied.allowed && denied.reason === "rate_limited").toBe(
            true,
          );
          const after = (
            await migration.query<{ end: string }>(
              "SELECT window_end::text AS end FROM control_private.budgets WHERE key_mac=control_private.mac('transport-ingress-v1','common-loopback')",
            )
          ).rows[0].end;
          expect(before === after).toBe(true);
        } finally {
          await close(migration);
        }
      } finally {
        await Promise.all(workers.map(close));
      }
    }));
  it("cancels only cookie-derived original context and retains key/replay/approval/budgets", () =>
    secretSafe(async () => {
      const client = await connect(owned!.migrationUrl),
        staff = await connect(owned!.staffUrl);
      try {
        const before = await client.query<{ image: string }>(
          "SELECT concat((SELECT key_checksum::text FROM control_private.secrets),(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.code_mac)::text FROM control_private.replay_burns r),(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.generation_id)::text FROM control_private.approved_generations g),(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.key_mac)::text FROM control_private.budgets b)) AS image",
        );
        const result = (
          await staff.query<{ decision: { allowed: boolean } }>(
            "SELECT staff.cancel_transport_context($1) AS decision",
            [cookie],
          )
        ).rows[0].decision;
        expect(result.allowed).toBe(true);
        const state = await client.query<{ safe: boolean }>(
          `SELECT
        (SELECT state='revoked' FROM control_private.attempts WHERE challenge_handle=$1)
        AND (SELECT revoked FROM control_private.session_controls WHERE session_id=$2)
        AND (SELECT retired FROM control_private.session_observations WHERE session_id=$2)
        AND (SELECT mode='revoked' FROM staff.admissions WHERE session_id=$2)
        AND (SELECT count(*)=1 FROM audit.events WHERE action='transport.cancel') AS safe`,
          [attempt, sid],
        );
        expect(state.rows[0].safe).toBe(true);
        const after = await client.query<{ image: string }>(
          "SELECT concat((SELECT key_checksum::text FROM control_private.secrets),(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.code_mac)::text FROM control_private.replay_burns r),(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.generation_id)::text FROM control_private.approved_generations g),(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.key_mac)::text FROM control_private.budgets b)) AS image",
        );
        expect(before.rows[0].image === after.rows[0].image).toBe(true);
        const empty = (
          await staff.query<{ decision: { allowed: boolean } }>(
            "SELECT staff.cancel_transport_context('') AS decision",
          )
        ).rows[0].decision;
        expect(empty.allowed).toBe(false);
      } finally {
        await close(staff);
        await close(client);
      }
    }));
  it("rolls denial mutations back on audit failure and never reports committed cancellation", () =>
    secretSafe(async () => {
      const migration = await connect(owned!.migrationUrl),
        staff = await connect(owned!.staffUrl);
      const handle = randomBytes(32).toString("hex"),
        other =
          "__Secure-bookstore-provider-proof.two_factor=second-structural-only";
      let installed = false;
      try {
        await migration.query(
          `INSERT INTO control_private.attempts(challenge_handle,user_id,generation_id,fingerprint,authz_version,permission_version,purpose,state,authenticated_at,primary_deadline,ip_scope,primary_cookie_mac)
        SELECT $1,c.user_id,c.generation_id,c.fingerprint,c.authz_version,c.permission_version,'login','bound',c.authenticated_at,c.authenticated_at+interval '120 seconds','unknown',control_private.mac('cookie',$2) FROM control_private.session_controls c WHERE c.session_id=$3`,
          [handle, other, sid],
        );
        await migration.query(
          "CREATE FUNCTION audit.transport_upgrade_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='transport.cancel' THEN RAISE EXCEPTION 'Synthetic transport audit unavailable' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$",
        );
        await migration.query(
          "CREATE TRIGGER transport_upgrade_fault BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION audit.transport_upgrade_fault()",
        );
        installed = true;
        let code = "";
        try {
          await staff.query("SELECT staff.cancel_transport_context($1)", [
            other,
          ]);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string"
          )
            code = error.code;
        }
        expect(code === "P0001").toBe(true);
        expect(
          (
            await migration.query<{ state: string }>(
              "SELECT state FROM control_private.attempts WHERE challenge_handle=$1",
              [handle],
            )
          ).rows[0].state === "bound",
        ).toBe(true);
      } finally {
        if (installed) {
          await migration.query(
            "DROP TRIGGER transport_upgrade_fault ON audit.events",
          );
          await migration.query(
            "DROP FUNCTION audit.transport_upgrade_fault()",
          );
        }
        await close(staff);
        await close(migration);
      }
    }));
});
