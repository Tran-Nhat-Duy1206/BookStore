import { randomUUID, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { hashPassword } from "better-auth/crypto";
import { PrismaClient as CatalogClient } from "../../src/generated/prisma/client";
import { PrismaClient as IdentityClient } from "../../src/generated/security/client";
import { seedCatalog } from "../../prisma/seed";
import { PostgresCatalogRepository } from "../../src/modules/catalog/postgres-repository";
import { books, categories, series } from "../../src/modules/catalog/data";
import { createFoundationDatabase, type FoundationDatabase } from "./database";
import { runSecurityMigrations } from "../../scripts/security-database";
import { seedOfflineAdmissionControls } from "../admission-controls/offline-fixture";
import { assertFoundationUrl } from "../../src/server/security/database-config";
import { createSecurityKernel } from "../../src/server/security/kernel";
import {
  createDurableDenialSpool,
  isValidDenialJournal,
} from "../../src/server/security/denial-spool";
import {
  SECURITY_ROLES,
  PERMISSION_REGISTRY,
  hasPermission,
} from "../../src/server/security/permissions";

type Context = {
  db: FoundationDatabase;
  migration: Client;
  auth: Client;
  staff: Client;
  worker: Client;
  reader: Client;
};
type Fixture = { userId: string; sessionId: string };
let main: Context;
const databases: FoundationDatabase[] = [];
const clients: Client[] = [];
const kernels: ReturnType<typeof createSecurityKernel>[] = [];
let passwordHash: string;
async function connect(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  clients.push(client);
  return client;
}
async function context(): Promise<Context> {
  const db = await createFoundationDatabase();
  databases.push(db);
  await runSecurityMigrations(db.migrationUrl);
  await db.hardenPrivileges();
  return {
    db,
    migration: await connect(db.migrationUrl),
    auth: await connect(db.authUrl),
    staff: await connect(db.staffUrl),
    worker: await connect(db.workerUrl),
    reader: await connect(db.readerUrl),
  };
}
async function drain(c = main) {
  for (let batch = 0; batch < 20; batch++) {
    const rows = await c.worker.query<{ id: string }>(
      "SELECT * FROM audit.pending_provider_events(100)",
    );
    if (!rows.rowCount) return;
    for (const row of rows.rows)
      await c.worker.query(
        "SELECT audit.reconcile_provider_event($1::bigint)",
        [row.id],
      );
  }
  throw new Error("Synthetic transition cleanup exceeded its explicit bound.");
}
async function version(f: Fixture, c = main) {
  return (
    await c.migration.query(
      "SELECT authz_version FROM staff.principals WHERE user_id=$1",
      [f.userId],
    )
  ).rows[0].authz_version as number;
}
async function admitFixture(
  f: Fixture,
  c = main,
  options: {
    mode?: string;
    authAge?: string;
    idleAge?: string;
    mfaAge?: string;
  } = {},
) {
  // MIGRATION-ONLY synthetic state, NOT a provider MFA verifier or runtime admission writer.
  await c.migration.query(
    `INSERT INTO staff.admissions(session_id,user_id,authz_version,mode,authenticated_at,last_seen_at,mfa_at)
 VALUES($1,$2,$3,$4,statement_timestamp()-$5::interval,statement_timestamp()-$6::interval,statement_timestamp()-$7::interval)
 ON CONFLICT(session_id) DO UPDATE SET authz_version=EXCLUDED.authz_version,mode=EXCLUDED.mode,authenticated_at=EXCLUDED.authenticated_at,last_seen_at=EXCLUDED.last_seen_at,mfa_at=EXCLUDED.mfa_at`,
    [
      f.sessionId,
      f.userId,
      await version(f, c),
      options.mode ?? "verified",
      options.authAge ?? "1 second",
      options.idleAge ?? "0 seconds",
      options.mfaAge ?? "0 seconds",
    ],
  );
  // Explicit migration-owner structural fixture for the additive B.2b guard;
  // no runtime approval/admission privilege or genuine SDK-MFA claim.
  await seedOfflineAdmissionControls(c.migration, f);
}
async function fixture(role: string = "Analyst", c = main): Promise<Fixture> {
  const userId = randomUUID(),
    sessionId = randomUUID();
  // Opaque non-operational sentinels are structural fixtures, not usable TOTP material or passwords.
  await c.migration.query(
    'INSERT INTO identity."User"(id,name,email,"emailVerified","twoFactorEnabled","updatedAt") VALUES($1,$2,$3,true,true,now())',
    [userId, "Synthetic database fixture", `${userId}@example.invalid`],
  );
  await c.migration.query(
    'INSERT INTO identity."Account"(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$2,\'credential\',$2,$3,now())',
    [randomUUID(), userId, passwordHash],
  );
  await c.migration.query(
    'INSERT INTO identity."TwoFactor"(id,"userId",secret,"backupCodes",verified) VALUES($1,$2,\'fixture-only-encrypted-placeholder\',\'fixture-only-encrypted-placeholder\',true)',
    [randomUUID(), userId],
  );
  await c.migration.query(
    'INSERT INTO identity."Session"(id,token,"userId","expiresAt","updatedAt") VALUES($1,$2,$3,now()+interval \'8 hours\',now())',
    [sessionId, `fixture-not-a-real-bearer-${sessionId}`, userId],
  );
  await drain(c);
  await c.migration.query(
    "INSERT INTO staff.principals(user_id,status) VALUES($1,'active')",
    [userId],
  );
  await c.migration.query(
    "INSERT INTO staff.role_grants(user_id,role_name) VALUES($1,$2)",
    [userId, role],
  );
  const f = { userId, sessionId };
  await admitFixture(f, c);
  return f;
}
function kernel(f: Fixture | null, c = main, fallback = false) {
  const instance = createSecurityKernel(
    c.db.staffUrl,
    async () => f,
    fallback ? createDurableDenialSpool() : undefined,
  );
  kernels.push(instance);
  return instance;
}
async function decision(
  f: Fixture,
  permission = "security.self.read",
  c = main,
) {
  return (
    await c.staff.query(
      "SELECT staff.check_access($1,$2,$3,NULL::bigint) AS decision",
      [f.userId, f.sessionId, permission],
    )
  ).rows[0].decision;
}
async function failAudit(c = main) {
  await c.migration.query(
    "CREATE FUNCTION public.reject_synthetic_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit outage' USING ERRCODE='P0001'; END $$",
  );
  await c.migration.query(
    "CREATE TRIGGER synthetic_outage BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION public.reject_synthetic_audit()",
  );
}
async function restoreAudit(c = main) {
  await c.migration.query("DROP TRIGGER synthetic_outage ON audit.events");
  await c.migration.query("DROP FUNCTION public.reject_synthetic_audit()");
}
function guardRole(c = main) {
  const role = new URL(c.db.staffUrl).username.replace(/_staff$/, "_guard");
  if (!/^bf_[a-f0-9]{12}_guard$/.test(role))
    throw new Error("Unexpected synthetic guard role");
  return `"${role}"`;
}
async function waitForLock(observer: Client, pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      (
        await observer.query(
          "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",
          [pid],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Expected database lock barrier was not reached.");
}

beforeAll(async () => {
  passwordHash = await hashPassword(
    "Synthetic foundation fixture password only!",
  );
  main = await context();
  await runSecurityMigrations(main.db.migrationUrl);
  const catalog = new CatalogClient({
    adapter: new PrismaPg({
      connectionString: assertFoundationUrl(main.db.migrationUrl, "migrate"),
    }),
  });
  try {
    await seedCatalog(catalog);
  } finally {
    await catalog.$disconnect();
  }
});
afterAll(async () => {
  const closed = await Promise.allSettled([
    ...kernels.map((k) => k.close()),
    ...clients.map((client) => client.end()),
  ]);
  for (const db of databases) await db.dispose();
  for (const result of closed)
    if (result.status === "rejected") throw result.reason;
});

describe("canonical history and dormant initial state", () => {
  it("replays all six canonical migrations with exactly fourteen public catalog tables", async () => {
    const result = await main.migration.query(
      'SELECT migration_name FROM public."_prisma_migrations" ORDER BY migration_name',
    );
    expect(result.rows.map((r) => r.migration_name)).toEqual([
      "001_catalog_base",
      "002_catalog_invariants",
      "003_catalog_identity_checks",
      "004_security_identity",
      "005_security_foundation",
      "006_durable_admission_controls",
    ]);
    expect(
      (
        await main.reader.query(
          'SELECT count(*)::int AS count FROM public."Product"',
        )
      ).rows[0].count,
    ).toBe(12);
    expect(
      (
        await main.migration.query(
          "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations'",
        )
      ).rows[0].count,
    ).toBe(14);
  });
  it("does not seed a real account, eligible Owner, verified admission or active governance", async () => {
    expect(
      (await main.migration.query("SELECT state FROM staff.governance")).rows,
    ).toEqual([{ state: "uninitialized" }]);
    for (const table of [
      'identity."User"',
      "staff.principals",
      "staff.admissions",
    ])
      expect(
        (
          await main.migration.query(
            `SELECT count(*)::int AS count FROM ${table}`,
          )
        ).rows[0].count,
      ).toBe(0);
  });
  it("ignores forged role/MFA/identity claims with no trusted server resolver", async () => {
    const instance = createSecurityKernel(main.db.staffUrl);
    kernels.push(instance);
    expect(
      await instance.authorize("security.self.read", {
        userId: "forged",
        sessionId: "forged",
        role: "Owner",
        mfaVerified: true,
      }),
    ).toMatchObject({ allowed: false, status: 401 });
  });
  it("rejects active/recovery shortcuts and deletion of the singleton", async () => {
    for (const state of ["active", "recovery_locked"])
      await expect(
        main.migration.query("UPDATE staff.governance SET state=$1", [state]),
      ).rejects.toMatchObject({ code: "23514" });
    await expect(
      main.migration.query("DELETE FROM staff.governance"),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("keeps exact catalog DTOs under the genuine SELECT-only profile", async () => {
    const client = new CatalogClient({
      adapter: new PrismaPg({
        connectionString: assertFoundationUrl(main.db.readerUrl, "reader"),
      }),
    });
    const repo = new PostgresCatalogRepository(client);
    try {
      expect(await repo.getSnapshot()).toStrictEqual({
        books,
        series,
        categories,
      });
    } finally {
      await repo.disconnect();
    }
  });
});

let owner: Fixture;
describe("synthetic migration-only state and live authorization", () => {
  beforeAll(async () => {
    await main.migration.query("UPDATE staff.governance SET state='bootstrap'");
    await expect(
      main.migration.query("UPDATE staff.governance SET state='active'"),
    ).rejects.toMatchObject({ code: "23514" });
    owner = await fixture("Owner");
    await main.migration.query("UPDATE staff.governance SET state='active'");
  });
  it("mirrors the explicit versioned permission registry without a wildcard", async () => {
    const data = await main.staff.query(
      "SELECT name,active,definition_version FROM staff.permissions ORDER BY name",
    );
    expect(data.rows).toEqual(
      Object.entries(PERMISSION_REGISTRY)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, p]) => ({
          name,
          active: p.active,
          definition_version: 1,
        })),
    );
  });
  it.each(SECURITY_ROLES)(
    "enforces all active/inert permissions for %s",
    async (role) => {
      const f = await fixture(role);
      const instance = kernel(f);
      for (const action of Object.keys(PERMISSION_REGISTRY))
        expect(
          (
            await instance.authorize(action, {
              role: "Owner",
              permissions: ["*"],
            })
          ).allowed,
        ).toBe(hasPermission(role, action));
      expect((await instance.authorize("*", { role: "Owner" })).allowed).toBe(
        false,
      );
      expect((await instance.authorize("unknown.permission")).allowed).toBe(
        false,
      );
    },
  );
  it.each(["pending", "suspended", "disabled", "recovery"])(
    "denies a live %s principal",
    async (status) => {
      const f = await fixture();
      await main.migration.query(
        "UPDATE staff.principals SET status=$2 WHERE user_id=$1",
        [f.userId, status],
      );
      await admitFixture(f);
      expect((await kernel(f).authorize("security.self.read")).allowed).toBe(
        false,
      );
    },
  );
  it.each(["pending", "recovery", "revoked"])(
    "denies %s admission despite enrolled provider flags",
    async (mode) => {
      const f = await fixture();
      await admitFixture(f, main, { mode });
      expect((await decision(f)).allowed).toBe(false);
    },
  );
  it("rejects stale authorization versions and caller-provided role flags", async () => {
    const f = await fixture();
    await main.migration.query(
      "UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=$1",
      [f.userId],
    );
    expect(
      await kernel(f).authorize("security.self.read", {
        authzVersion: await version(f),
        mfaVerified: true,
      }),
    ).toMatchObject({ allowed: false, reason: "stale" });
  });
  it("binds admission to the same provider user and session using a composite FK", async () => {
    const a = await fixture(),
      b = await fixture();
    expect(
      (
        await kernel({ userId: a.userId, sessionId: b.sessionId }).authorize(
          "security.self.read",
        )
      ).allowed,
    ).toBe(false);
    await main.migration.query(
      "DELETE FROM staff.admissions WHERE session_id=$1",
      [a.sessionId],
    );
    await expect(
      main.migration.query(
        "INSERT INTO staff.admissions(session_id,user_id,authz_version) VALUES($1,$2,0)",
        [a.sessionId, b.userId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("denies the eight-hour absolute candidate even with recent activity", async () => {
    const f = await fixture();
    await admitFixture(f, main, { authAge: "9 hours", idleAge: "0 seconds" });
    expect((await decision(f)).allowed).toBe(false);
  });
  it("denies the thirty-minute idle candidate before any activity update", async () => {
    const f = await fixture();
    await admitFixture(f, main, {
      authAge: "1 hour",
      idleAge: "31 minutes",
      mfaAge: "1 minute",
    });
    expect((await decision(f)).allowed).toBe(false);
  });
  it("requires the five-minute recent-MFA candidate for Owner security changes", async () => {
    await admitFixture(owner, main, {
      authAge: "10 minutes",
      mfaAge: "6 minutes",
    });
    expect((await decision(owner, "security.self.read")).allowed).toBe(true);
    expect((await decision(owner, "security.staff.status")).allowed).toBe(
      false,
    );
    await admitFixture(owner);
  });
  it("rejects provider expiry and live factor loss independently of cached admission", async () => {
    const a = await fixture();
    await main.auth.query(
      'UPDATE identity."Session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',
      [a.sessionId],
    );
    expect((await decision(a)).allowed).toBe(false);
    const b = await fixture();
    await main.auth.query(
      'UPDATE identity."User" SET "twoFactorEnabled"=false WHERE id=$1',
      [b.userId],
    );
    expect((await decision(b)).allowed).toBe(false);
    await drain();
  });
  it("supports the pinned real provider adapter without granting staff access on password success", async () => {
    const client = new IdentityClient({
      adapter: new PrismaPg({
        connectionString: assertFoundationUrl(main.db.authUrl, "auth"),
      }),
    });
    try {
      // Never mounted: synthetic compatibility fixture only, not a runtime provider integration.
      const provider = betterAuth({
        database: prismaAdapter(client, {
          provider: "postgresql",
          transaction: true,
        }),
        secret: randomBytes(48).toString("base64url"),
        baseURL: "https://bookstore-foundation.invalid",
        emailAndPassword: { enabled: true, minPasswordLength: 15 },
        logger: { disabled: true },
        telemetry: { enabled: false },
      });
      const email = `${randomUUID()}@example.invalid`,
        password = "Synthetic SDK-only foundation password!";
      const signed = await provider.api.signUpEmail({
        body: { email, password, name: "Synthetic SDK fixture" },
      });
      const primary = await provider.api.signInEmail({
        body: { email, password },
      });
      expect(primary.user.id).toBe(signed.user.id);
      const row = await client.session.findFirstOrThrow({
        where: { userId: signed.user.id },
      });
      expect(
        (
          await kernel({ userId: signed.user.id, sessionId: row.id }).authorize(
            "security.self.read",
          )
        ).allowed,
      ).toBe(false);
      await drain();
      expect(
        (
          await main.migration.query(
            "SELECT count(*)::int AS count FROM staff.principals WHERE user_id=$1",
            [signed.user.id],
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await client.$disconnect();
    }
  });
});

describe("staff-state audit transactions and bounded denial evidence", () => {
  it("commits a permitted status change and redacted success audit together", async () => {
    const target = await fixture();
    const before = await version(target);
    expect(
      (await kernel(owner).setStatus(target.userId, "suspended")).allowed,
    ).toBe(true);
    expect(await version(target)).toBe(before + 1);
    expect(
      (
        await main.staff.query(
          "SELECT action,outcome,actor_id FROM audit.events WHERE subject_id=$1 AND action='principal.update' ORDER BY occurred_at DESC LIMIT 1",
          [target.userId],
        )
      ).rows[0],
    ).toMatchObject({
      action: "principal.update",
      outcome: "success",
      actor_id: owner.userId,
    });
    expect((await decision(target)).allowed).toBe(false);
  });
  it("denies unauthorized status/role changes without modifying the target", async () => {
    const actor = await fixture("Publisher"),
      target = await fixture("Analyst");
    const before = await version(target);
    expect(
      (await kernel(actor).setStatus(target.userId, "disabled")).allowed,
    ).toBe(false);
    expect(
      (await kernel(actor).replaceRoles(actor.userId, ["Owner"])).allowed,
    ).toBe(false);
    expect(await version(target)).toBe(before);
    expect(
      (
        await main.staff.query(
          "SELECT role_name FROM staff.role_grants WHERE user_id=$1",
          [actor.userId],
        )
      ).rows,
    ).toEqual([{ role_name: "Publisher" }]);
  });
  it("rolls back state/version/success-audit when the required audit insert fails", async () => {
    const target = await fixture();
    const before = await version(target);
    await failAudit();
    try {
      expect(
        await kernel(owner).setStatus(target.userId, "disabled"),
      ).toMatchObject({ allowed: false, status: 503 });
    } finally {
      await restoreAudit();
    }
    expect(await version(target)).toBe(before);
    expect(
      (
        await main.staff.query(
          "SELECT status FROM staff.principals WHERE user_id=$1",
          [target.userId],
        )
      ).rows[0].status,
    ).toBe("active");
    expect(
      (
        await main.migration.query(
          "SELECT count(*)::int AS count FROM audit.denials WHERE outcome='rolled_back'",
        )
      ).rows[0].count,
    ).toBeGreaterThan(0);
  });
  it("revokes only the authenticated actor's own admission", async () => {
    const a = await fixture(),
      b = await fixture();
    const instance = kernel(a);
    expect((await instance.revokeOwnSession(b.sessionId)).allowed).toBe(false);
    expect((await instance.revokeOwnSession(a.sessionId)).allowed).toBe(true);
    expect((await decision(a)).allowed).toBe(false);
    expect((await decision(b)).allowed).toBe(true);
  });
  it("stores no provider row payloads, password hashes, bearer or factor material in audit", async () => {
    const f = await fixture();
    const sentinel = `NOT_A_REAL_SECRET_${randomUUID()}`;
    await main.auth.query(
      'UPDATE identity."TwoFactor" SET secret=$2,"backupCodes"=$2 WHERE "userId"=$1',
      [f.userId, sentinel],
    );
    await drain();
    const serialized = JSON.stringify(
      (
        await main.migration.query(
          "SELECT row_to_json(e) AS data FROM audit.events e UNION ALL SELECT row_to_json(p) FROM audit.provider_events p",
        )
      ).rows,
    );
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain(passwordHash);
    expect(serialized).not.toContain("fixture-not-a-real-bearer-");
  });
  it("uses a durable redacted spool while required denial persistence is unavailable", async () => {
    await main.migration.query(
      `REVOKE INSERT ON audit.denials FROM ${guardRole()}`,
    );
    const instance = kernel(null, main, true);
    try {
      expect(await instance.authorize("security.self.read")).toMatchObject({
        allowed: false,
        status: 503,
      });
    } finally {
      await main.migration.query(
        `GRANT INSERT ON audit.denials TO ${guardRole()}`,
      );
    }
    const data = await readFile(
      ".local/security-foundation-denials/denials.jsonl",
      "utf8",
    );
    const last = JSON.parse(data.trim().split("\n").at(-1)!);
    expect(Object.keys(last).sort()).toEqual([
      "occurredAt",
      "outcome",
      "reason",
      "requestId",
    ]);
    expect(last.reason).toBe("unauthenticated");
    expect(last.outcome).toBe("denied");
  });
  it("rejects partial or malformed journal evidence without silently repairing it", () => {
    const record = {
      requestId: randomUUID(),
      occurredAt: new Date().toISOString(),
      reason: "forbidden",
      outcome: "denied",
    };
    const line = JSON.stringify(record);
    expect(isValidDenialJournal("")).toBe(true);
    expect(isValidDenialJournal(line + "\n")).toBe(true);
    expect(isValidDenialJournal(line)).toBe(false);
    expect(isValidDenialJournal(line + "\n" + line.slice(0, 20))).toBe(false);
    expect(
      isValidDenialJournal(
        JSON.stringify({ ...record, password: "synthetic-not-real" }) + "\n",
      ),
    ).toBe(false);
  });
  it("rejects secret-bearing spool payloads and fails closed on bounded saturation", async () => {
    const spool = createDurableDenialSpool();
    const bad = {
      requestId: randomUUID(),
      occurredAt: new Date().toISOString(),
      reason: "forbidden",
      outcome: "denied",
      password: "not-a-real-secret",
    } as const;
    expect(await spool.append(bad)).toBe(false);
    const small = createDurableDenialSpool({ maxBytes: 1 });
    expect(
      await small.append({
        requestId: randomUUID(),
        occurredAt: new Date().toISOString(),
        reason: "forbidden",
        outcome: "denied",
      }),
    ).toBe(false);
  });
});

describe("durable provider partial-operation reconciliation", () => {
  it("denies access immediately after provider commit and never readmits automatically", async () => {
    const f = await fixture();
    const before = await version(f);
    await main.auth.query('UPDATE identity."User" SET email=$2 WHERE id=$1', [
      f.userId,
      `${randomUUID()}@example.invalid`,
    ]);
    expect((await decision(f)).allowed).toBe(false);
    expect(await version(f)).toBe(before);
    const event = (
      await main.migration.query(
        "SELECT id FROM audit.provider_events WHERE user_id=$1 AND state='pending'",
        [f.userId],
      )
    ).rows[0].id;
    expect(
      (
        await main.worker.query(
          "SELECT audit.reconcile_provider_event($1) AS applied",
          [event],
        )
      ).rows[0].applied,
    ).toBe(true);
    expect(await version(f)).toBe(before + 1);
    expect((await decision(f)).allowed).toBe(false);
    expect(
      (
        await main.worker.query(
          "SELECT audit.reconcile_provider_event($1) AS applied",
          [event],
        )
      ).rows[0].applied,
    ).toBe(false);
    expect(await version(f)).toBe(before + 1);
    expect(
      (
        await main.migration.query(
          "SELECT count(*)::int AS count FROM audit.events WHERE transition_id=$1",
          [event],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("preserves durable pending evidence and retries idempotently after audit rollback", async () => {
    const f = await fixture();
    const before = await version(f);
    await main.auth.query(
      'UPDATE identity."TwoFactor" SET "backupCodes"=\'synthetic-consumption-marker\' WHERE "userId"=$1',
      [f.userId],
    );
    const event = (
      await main.migration.query(
        "SELECT id FROM audit.provider_events WHERE user_id=$1 AND state='pending'",
        [f.userId],
      )
    ).rows[0].id;
    await failAudit();
    try {
      await expect(
        main.worker.query("SELECT audit.reconcile_provider_event($1)", [event]),
      ).rejects.toMatchObject({ code: "P0001" });
    } finally {
      await restoreAudit();
    }
    expect(await version(f)).toBe(before);
    expect(
      (
        await main.migration.query(
          "SELECT state FROM audit.provider_events WHERE id=$1",
          [event],
        )
      ).rows[0].state,
    ).toBe("pending");
    await main.worker.query(
      "SELECT audit.record_reconcile_failure($1,'apply_failed')",
      [event],
    );
    await main.worker.query("SELECT audit.reconcile_provider_event($1)", [
      event,
    ]);
    expect(await version(f)).toBe(before + 1);
    expect((await decision(f)).allowed).toBe(false);
  });
  it("blocks after five failed attempts without dropping evidence or restoring access", async () => {
    const f = await fixture();
    await main.auth.query('UPDATE identity."User" SET email=$2 WHERE id=$1', [
      f.userId,
      `${randomUUID()}@example.invalid`,
    ]);
    const event = (
      await main.migration.query(
        "SELECT id FROM audit.provider_events WHERE user_id=$1 AND state='pending'",
        [f.userId],
      )
    ).rows[0].id;
    for (let i = 0; i < 8; i++)
      await main.worker.query(
        "SELECT audit.record_reconcile_failure($1,'apply_failed')",
        [event],
      );
    expect(
      (
        await main.migration.query(
          "SELECT state,attempts FROM audit.provider_events WHERE id=$1",
          [event],
        )
      ).rows[0],
    ).toEqual({ state: "blocked", attempts: 5 });
    expect(
      (
        await main.worker.query(
          "SELECT audit.reconcile_provider_event($1) AS applied",
          [event],
        )
      ).rows[0].applied,
    ).toBe(false);
    expect((await decision(f)).allowed).toBe(false);
  });
  it("rolls provider writes back instead of losing events when the backlog is full", async () => {
    const marker = `backlog-fixture-${randomUUID()}`;
    const existing = (
      await main.migration.query(
        "SELECT count(*)::int AS count FROM audit.provider_events WHERE state<>'processed'",
      )
    ).rows[0].count;
    await main.migration.query(
      "INSERT INTO audit.provider_events(user_id,kind,invalidates_user) SELECT $1,'identity.changed',true FROM generate_series(1,$2::int)",
      [marker, 1000 - existing],
    );
    const user = randomUUID();
    try {
      await expect(
        main.auth.query(
          'INSERT INTO identity."User"(id,name,email,"updatedAt") VALUES($1,\'Synthetic rejected\',$2,now())',
          [user, `${user}@example.invalid`],
        ),
      ).rejects.toMatchObject({ code: "54000" });
      expect(
        (
          await main.migration.query(
            'SELECT count(*)::int AS count FROM identity."User" WHERE id=$1',
            [user],
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await main.migration.query(
        "DELETE FROM audit.provider_events WHERE user_id=$1",
        [marker],
      );
    }
  });
  it.each([0, 101, -1])("rejects unbounded worker batch %s", async (limit) => {
    await expect(
      main.worker.query("SELECT * FROM audit.pending_provider_events($1)", [
        limit,
      ]),
    ).rejects.toMatchObject({ code: "22023" });
  });
});

let race: Context, first: Fixture, second: Fixture;
async function resetOwners() {
  for (const f of [first, second]) {
    await race.migration.query(
      "UPDATE staff.principals SET status='active' WHERE user_id=$1",
      [f.userId],
    );
    await race.migration.query(
      "INSERT INTO staff.role_grants VALUES($1,'Owner') ON CONFLICT DO NOTHING",
      [f.userId],
    );
  }
  await drain(race);
  await admitFixture(first, race);
  await admitFixture(second, race);
}
describe("deterministic Owner and actor-revocation lock races", () => {
  beforeAll(async () => {
    race = await context();
    await race.migration.query("UPDATE staff.governance SET state='bootstrap'");
    first = await fixture("Owner", race);
    await race.migration.query("UPDATE staff.governance SET state='active'");
    second = await fixture("Owner", race);
  });
  it("serializes two self-disables and rejects the final eligible Owner removal", async () => {
    const a = await connect(race.db.staffUrl),
      b = await connect(race.db.staffUrl);
    const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await a.query("BEGIN");
    await a.query("SELECT staff.set_status($1,$2,$3,$1,'disabled')", [
      first.userId,
      first.sessionId,
      await version(first, race),
    ]);
    const competing = b.query(
      "SELECT staff.set_status($1,$2,$3,$1,'disabled')",
      [second.userId, second.sessionId, await version(second, race)],
    );
    const outcome = competing.then(
      () => ({ code: "unexpected-success" }),
      (error: { code: string }) => ({ code: error.code }),
    );
    await waitForLock(race.migration, pid);
    await a.query("COMMIT");
    expect((await outcome).code).toBe("23514");
    expect(
      (
        await race.migration.query(
          "SELECT status FROM staff.principals WHERE user_id=$1",
          [second.userId],
        )
      ).rows[0].status,
    ).toBe("active");
    await resetOwners();
  });
  it("serializes two Owner-role removals without transient Owner-to-Owner replacement failure", async () => {
    await race.staff.query(
      "SELECT staff.replace_roles($1,$2,$3,$1,ARRAY['Owner'])",
      [first.userId, first.sessionId, await version(first, race)],
    );
    const a = await connect(race.db.staffUrl),
      b = await connect(race.db.staffUrl);
    const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await a.query("BEGIN");
    await a.query("SELECT staff.replace_roles($1,$2,$3,$1,ARRAY['Analyst'])", [
      first.userId,
      first.sessionId,
      await version(first, race),
    ]);
    const pending = b
      .query("SELECT staff.replace_roles($1,$2,$3,$1,ARRAY['Analyst'])", [
        second.userId,
        second.sessionId,
        await version(second, race),
      ])
      .then(
        () => "unexpected-success",
        (e: { code: string }) => e.code,
      );
    await waitForLock(race.migration, pid);
    await a.query("COMMIT");
    expect(await pending).toBe("23514");
    await resetOwners();
  });
  it.each([
    'DELETE FROM identity."User" WHERE id=$1',
    'DELETE FROM identity."TwoFactor" WHERE "userId"=$1',
    'UPDATE identity."User" SET "twoFactorEnabled"=false WHERE id=$1',
    'UPDATE identity."User" SET "emailVerified"=false WHERE id=$1',
    'DELETE FROM identity."Account" WHERE "userId"=$1',
    'UPDATE identity."Account" SET password=NULL WHERE "userId"=$1',
  ])("rejects an indirect provider last-Owner mutation: %s", async (sql) => {
    await race.migration.query(
      "UPDATE staff.principals SET status='disabled' WHERE user_id=$1",
      [first.userId],
    );
    try {
      await expect(race.auth.query(sql, [second.userId])).rejects.toMatchObject(
        { code: "23514" },
      );
    } finally {
      await resetOwners();
    }
  });
  it("shares the lock between provider factor loss and a concurrent staff disable", async () => {
    const a = await connect(race.db.authUrl),
      b = await connect(race.db.staffUrl);
    const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await a.query("BEGIN");
    await a.query(
      'UPDATE identity."User" SET "twoFactorEnabled"=false WHERE id=$1',
      [first.userId],
    );
    const pending = b
      .query("SELECT staff.set_status($1,$2,$3,$1,'disabled')", [
        second.userId,
        second.sessionId,
        await version(second, race),
      ])
      .then(
        () => "unexpected-success",
        (e: { code: string }) => e.code,
      );
    await waitForLock(race.migration, pid);
    await a.query("COMMIT");
    expect(await pending).toBe("23514");
    await race.auth.query(
      'UPDATE identity."User" SET "twoFactorEnabled"=true WHERE id=$1',
      [first.userId],
    );
    await resetOwners();
  });
  it("rejects two stale REPEATABLE READ Owner snapshots before either can mutate", async () => {
    const a = await connect(race.db.staffUrl),
      b = await connect(race.db.staffUrl);
    try {
      for (const client of [a, b]) {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await client.query("SELECT user_id FROM staff.principals");
      }
      await expect(
        a.query("SELECT staff.set_status($1,$2,$3,$1,'disabled')", [
          first.userId,
          first.sessionId,
          await version(first, race),
        ]),
      ).rejects.toMatchObject({ code: "0A000" });
      await expect(
        b.query("SELECT staff.set_status($1,$2,$3,$1,'disabled')", [
          second.userId,
          second.sessionId,
          await version(second, race),
        ]),
      ).rejects.toMatchObject({ code: "0A000" });
    } finally {
      await a.query("ROLLBACK");
      await b.query("ROLLBACK");
    }
    expect(
      (
        await race.staff.query(
          "SELECT count(*)::int AS count FROM staff.principals WHERE status='active'",
        )
      ).rows[0].count,
    ).toBe(2);
  });
  it.each(["REPEATABLE READ", "SERIALIZABLE", "READ UNCOMMITTED"])(
    "denies unsupported %s provider mutation and admission lookup",
    async (isolation) => {
      for (const [url, sql, args] of [
        [
          race.db.authUrl,
          'UPDATE identity."User" SET "updatedAt"=now() WHERE id=$1',
          [first.userId],
        ],
        [
          race.db.staffUrl,
          "SELECT staff.check_access($1,$2,'security.self.read',NULL)",
          [first.userId, first.sessionId],
        ],
        [race.db.workerUrl, "SELECT audit.reconcile_provider_event(1)", []],
      ] as const) {
        const client = await connect(url);
        try {
          await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          await expect(client.query(sql, [...args])).rejects.toMatchObject({
            code: "0A000",
          });
        } finally {
          await client.query("ROLLBACK");
        }
      }
    },
  );
  it.each([
    {
      kind: "provider expiry",
      options: { authAge: "1 hour" },
      expression: 's."expiresAt"',
      provider: true,
    },
    {
      kind: "absolute deadline",
      options: { authAge: "7 hours 59 minutes 57 seconds" },
      expression: "a.authenticated_at+interval '8 hours'",
      provider: false,
    },
    {
      kind: "idle deadline",
      options: { authAge: "1 hour", idleAge: "29 minutes 57 seconds" },
      expression: "a.last_seen_at+interval '30 minutes'",
      provider: false,
    },
    {
      kind: "recent MFA deadline",
      options: { authAge: "1 hour", mfaAge: "4 minutes 57 seconds" },
      expression: "a.mfa_at+interval '5 minutes'",
      provider: false,
    },
  ])(
    "rechecks $kind against wall clock AFTER a governance wait",
    async (testCase) => {
      const target = await fixture("Analyst", race);
      await race.migration.query(
        'UPDATE identity."Session" SET "expiresAt"=clock_timestamp()+interval \'8 hours\' WHERE id=$1',
        [second.sessionId],
      );
      await drain(race);
      if (testCase.provider) {
        await race.migration.query(
          'UPDATE identity."Session" SET "expiresAt"=clock_timestamp()+interval \'3 seconds\' WHERE id=$1',
          [second.sessionId],
        );
        await drain(race);
      }
      await admitFixture(second, race, testCase.options);
      const deadline = (
        await race.migration.query(
          `SELECT ${testCase.expression} AS deadline FROM staff.admissions a JOIN identity."Session" s ON s.id=a.session_id WHERE a.session_id=$1`,
          [second.sessionId],
        )
      ).rows[0].deadline as Date;
      const a = await connect(race.db.migrationUrl),
        b = await connect(race.db.staffUrl);
      let committed = false;
      const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      try {
        await a.query("BEGIN");
        await a.query("SELECT singleton FROM staff.governance FOR UPDATE");
        const pending = b.query(
          "SELECT statement_timestamp() AS started,staff.set_status($1,$2,$3,$4,'disabled') AS decision",
          [
            second.userId,
            second.sessionId,
            await version(second, race),
            target.userId,
          ],
        );
        await waitForLock(race.migration, pid);
        // A precise DB deadline barrier, not an arbitrary retry or sleeping to hide a race.
        await a.query("SELECT pg_sleep_until($1::timestamptz)", [
          new Date(deadline.getTime() + 30),
        ]);
        await a.query("COMMIT");
        committed = true;
        const result = (await pending).rows[0];
        expect((result.started as Date).getTime()).toBeLessThan(
          deadline.getTime(),
        );
        expect(result.decision.allowed).toBe(false);
        expect(
          (
            await race.staff.query(
              "SELECT status FROM staff.principals WHERE user_id=$1",
              [target.userId],
            )
          ).rows[0].status,
        ).toBe("active");
      } finally {
        if (!committed) await a.query("ROLLBACK");
        await race.migration.query(
          'UPDATE identity."Session" SET "expiresAt"=clock_timestamp()+interval \'8 hours\' WHERE id=$1',
          [second.sessionId],
        );
        await drain(race);
        await admitFixture(second, race);
      }
    },
  );
  it("retains an already committed security write when later revocation wins next", async () => {
    const actor = await fixture("Owner", race),
      target = await fixture("Analyst", race);
    const a = await connect(race.db.staffUrl),
      b = await connect(race.db.authUrl);
    const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await a.query("BEGIN");
    try {
      expect(
        (
          await a.query(
            "SELECT staff.set_status($1,$2,$3,$4,'suspended') AS decision",
            [
              actor.userId,
              actor.sessionId,
              await version(actor, race),
              target.userId,
            ],
          )
        ).rows[0].decision.allowed,
      ).toBe(true);
      const pending = b.query('DELETE FROM identity."Session" WHERE id=$1', [
        actor.sessionId,
      ]);
      await waitForLock(race.migration, pid);
      await a.query("COMMIT");
      await pending;
      expect(
        (
          await race.staff.query(
            "SELECT status FROM staff.principals WHERE user_id=$1",
            [target.userId],
          )
        ).rows[0].status,
      ).toBe("suspended");
      expect((await decision(actor, "security.self.read", race)).allowed).toBe(
        false,
      );
    } finally {
      await a.query("ROLLBACK");
    }
  });
  it("denies a security write when provider revocation wins the lock first", async () => {
    const target = await fixture("Analyst", race),
      a = await connect(race.db.authUrl),
      b = await connect(race.db.staffUrl);
    const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await a.query("BEGIN");
    await a.query('DELETE FROM identity."Session" WHERE id=$1', [
      first.sessionId,
    ]);
    const pending = b.query(
      "SELECT staff.set_status($1,$2,$3,$4,'disabled') AS decision",
      [
        first.userId,
        first.sessionId,
        await version(first, race),
        target.userId,
      ],
    );
    await waitForLock(race.migration, pid);
    await a.query("COMMIT");
    expect((await pending).rows[0].decision.allowed).toBe(false);
    expect(
      (
        await race.staff.query(
          "SELECT status FROM staff.principals WHERE user_id=$1",
          [target.userId],
        )
      ).rows[0].status,
    ).toBe("active");
  });
});

describe("upgrade from accepted main without catalog mutation", () => {
  it("upgrades a seeded three-migration database through the canonical additive history", async () => {
    const db = await createFoundationDatabase();
    databases.push(db);
    const sql = await connect(db.migrationUrl);
    for (const name of [
      "001_catalog_base",
      "002_catalog_invariants",
      "003_catalog_identity_checks",
    ])
      await sql.query(
        await readFile(`prisma/migrations/${name}/migration.sql`, "utf8"),
      );
    const client = new CatalogClient({
      adapter: new PrismaPg({
        connectionString: assertFoundationUrl(db.migrationUrl, "migrate"),
      }),
    });
    try {
      await seedCatalog(client);
      const before = await client.product.findMany({ orderBy: { id: "asc" } });
      // Resolve existing reviewed migration checksums through the actual Prisma CLI, then deploy only the additive suffix.
      for (const name of [
        "001_catalog_base",
        "002_catalog_invariants",
        "003_catalog_identity_checks",
      ]) {
        const { spawn } = await import("node:child_process");
        await new Promise<void>((resolveRun, reject) => {
          const child = spawn(
            process.execPath,
            [
              "node_modules/prisma/build/index.js",
              "migrate",
              "resolve",
              "--applied",
              name,
              "--config",
              "prisma.security.config.ts",
            ],
            {
              cwd: process.cwd(),
              stdio: "inherit",
              env: {
                ...process.env,
                SECURITY_MIGRATION_DATABASE_URL: db.migrationUrl,
              },
            },
          );
          child.once("error", () =>
            reject(new Error("Synthetic upgrade resolve unavailable")),
          );
          child.once("exit", (code) =>
            code === 0
              ? resolveRun()
              : reject(new Error("Synthetic upgrade resolve failed")),
          );
        });
      }
      await runSecurityMigrations(db.migrationUrl);
      await runSecurityMigrations(db.migrationUrl);
      expect(
        await client.product.findMany({ orderBy: { id: "asc" } }),
      ).toStrictEqual(before);
      expect(
        (await sql.query("SELECT state FROM staff.governance")).rows,
      ).toEqual([{ state: "uninitialized" }]);
    } finally {
      await client.$disconnect();
    }
  });
});
