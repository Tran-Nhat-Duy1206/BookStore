import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { PrismaClient as IdentityClient } from "./generated/client";
import { PrismaClient as CatalogClient } from "../../src/generated/prisma/client";
import { seedCatalog } from "../../prisma/seed";
import { FixtureCatalogRepository } from "../../src/modules/catalog/fixture-repository";
import { PostgresCatalogRepository } from "../../src/modules/catalog/postgres-repository";
import { assertDatabaseUrl } from "../../src/server/database/config";
import {
  createSpikeDatabase,
  validatePurposeUrl,
  validateSpikeBaseUrl,
  type SpikeDatabase,
} from "./database";
import { AdmissionProof } from "./admission";
import {
  createProvider,
  SyntheticBrowser,
  proposedPolicy,
  type Provider,
} from "./provider";

const base =
  "postgresql://bookstore_spike_bootstrap:synthetic-only@127.0.0.1:55434/bookstore_auth_spike_test";
const suffix = "abcdef123456";
const purposeUrl = `postgresql://bs_${suffix}_auth:synthetic-only@127.0.0.1:55434/bookstore_auth_spike_test_${suffix}`;
describe("experimental URL boundaries (no connections)", () => {
  it("accepts only the explicit spike bootstrap/profile", () => {
    expect(validateSpikeBaseUrl(base) === base).toBe(true);
    expect(validatePurposeUrl(purposeUrl, "auth") === purposeUrl).toBe(true);
  });
  it.each([
    base.replace("127.0.0.1", "remote.invalid"),
    base.replace("55434", "5432"),
    base.replace("55434", "55432"),
    base.replace("55434", "55433"),
    base.replace("bookstore_auth_spike_test", "bookstore_catalog_dev"),
    base.replace("bookstore_spike_bootstrap", "postgres"),
    `${base}?`,
    `${base}#`,
    `${base}?sslmode=disable`,
    ` ${base}`,
    base.replace("synthetic-only", ""),
    base.replace("synthetic-only", "%20"),
    base.replace("bookstore_auth_spike_test", "bookstore_auth_spike_ci"),
  ])("rejects a non-isolated bootstrap URL %#", (url) =>
    expect(() => validateSpikeBaseUrl(url)).toThrow(),
  );
  it.each([
    purposeUrl.replace(`bs_${suffix}_auth`, `bs_${suffix}_migrate`),
    purposeUrl.replace(`bs_${suffix}_auth`, "bs_000000000000_auth"),
    purposeUrl.replace(`test_${suffix}`, "test_000000000000"),
    purposeUrl.replace("55434", "5432"),
    `${purposeUrl}?schema=identity`,
    `${purposeUrl}#`,
  ])("rejects role/database/profile mismatch %#", (url) =>
    expect(() => validatePurposeUrl(url, "auth")).toThrow(),
  );
  it("does not relax or reuse the original catalog guard", () => {
    expect(() => assertDatabaseUrl(base)).toThrow();
    expect(() => assertDatabaseUrl(purposeUrl)).toThrow();
  });
});

let owned: SpikeDatabase;
let migration: Client;
let authSql: Client;
let staffSql: Client;
let readerSql: Client;
let identity: IdentityClient;
let offlineIdentity: IdentityClient;
let catalogMigration: CatalogClient;
let catalogReader: CatalogClient;
let provider: Provider;
let offline: Provider;
let admission: AdmissionProof;
const secret = randomBytes(48).toString("hex");
const closeables: Array<() => Promise<unknown>> = [];
async function connect(url: string) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  await client.connect();
  closeables.push(() => client.end());
  return client;
}
async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}
async function totp(uri: string) {
  const encoded = new URL(uri).searchParams.get("secret");
  if (!encoded)
    throw new Error("Synthetic enrollment did not return a secret.");
  return createOTP(base32.decode(encoded)).totp();
}
async function fixture(options: { enrolled?: boolean; staff?: boolean } = {}) {
  const email = `spike-${randomUUID()}@example.invalid`;
  const password = `Synthetic!${randomBytes(24).toString("hex")}`;
  // The permissive instance is offline-only and uses a disposable migration role.
  // It is NEVER passed to a route adapter or a listening HTTP server.
  const created = await offline.api.signUpEmail({
    body: { email, password, name: "Synthetic staff fixture" },
  });
  const id = created.user.id;
  if (options.staff !== false)
    await migration.query(
      "INSERT INTO staff.principals(user_id,status,role) VALUES($1,'enrollment','Owner')",
      [id],
    );
  const browser = new SyntheticBrowser(provider);
  const signedIn = await browser.call("/sign-in/email", { email, password });
  if (!signedIn.ok) throw new Error("Synthetic password fixture failed.");
  let uri = "",
    backupCodes: string[] = [];
  if (options.enrolled !== false) {
    const enabled = await browser.call("/two-factor/enable", { password });
    const enrollment = await json(enabled);
    if (
      !enabled.ok ||
      typeof enrollment.totpURI !== "string" ||
      !Array.isArray(enrollment.backupCodes)
    )
      throw new Error("Synthetic enrollment failed.");
    uri = enrollment.totpURI;
    backupCodes = enrollment.backupCodes as string[];
    const verified =
      options.staff === false
        ? {
            allowed: (
              await browser.call("/two-factor/verify-totp", {
                code: await totp(uri),
                trustDevice: false,
              })
            ).ok,
          }
        : await admission.verify(browser, await totp(uri));
    if (!verified.allowed) throw new Error("Synthetic MFA fixture failed.");
  }
  return { id, email, password, browser, uri, backupCodes };
}
async function login(email: string, password: string) {
  const browser = new SyntheticBrowser(provider);
  const response = await browser.call("/sign-in/email", { email, password });
  return { browser, response };
}
async function expectDenied(client: Client, sql: string) {
  try {
    await client.query(sql);
  } catch (error) {
    expect((error as { code?: string }).code).toBe("42501");
    return;
  }
  throw new Error("A runtime role unexpectedly had a forbidden SQL privilege.");
}

beforeAll(async () => {
  owned = await createSpikeDatabase();
  migration = await connect(validatePurposeUrl(owned.migrationUrl, "migrate"));
  for (const name of [
    "001_catalog_base",
    "002_catalog_invariants",
    "003_catalog_identity_checks",
  ]) {
    await migration.query(
      await readFile(
        new URL(
          `../../prisma/migrations/${name}/migration.sql`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  await migration.query(
    await readFile(new URL("./identity.sql", import.meta.url), "utf8"),
  );
  await migration.query(
    await readFile(new URL("./foundation.sql", import.meta.url), "utf8"),
  );
  await owned.grantRuntimePrivileges();
  const makeIdentity = (url: string, purpose: "auth" | "migrate") => {
    const client = new IdentityClient({
      adapter: new PrismaPg({
        connectionString: validatePurposeUrl(url, purpose),
        max: 2,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      }),
    });
    closeables.push(() => client.$disconnect());
    return client;
  };
  identity = makeIdentity(owned.authUrl, "auth");
  offlineIdentity = makeIdentity(owned.migrationUrl, "migrate");
  catalogMigration = new CatalogClient({
    adapter: new PrismaPg({
      connectionString: validatePurposeUrl(owned.migrationUrl, "migrate"),
      max: 2,
    }),
  });
  closeables.push(() => catalogMigration.$disconnect());
  catalogReader = new CatalogClient({
    adapter: new PrismaPg({
      connectionString: validatePurposeUrl(owned.readerUrl, "reader"),
      max: 2,
      options: "-c default_transaction_read_only=on",
    }),
  });
  closeables.push(() => catalogReader.$disconnect());
  await seedCatalog(catalogMigration);
  provider = createProvider(identity, secret);
  offline = createProvider(offlineIdentity, secret, true);
  admission = new AdmissionProof(owned.staffUrl);
  closeables.push(() => admission.close());
  authSql = await connect(validatePurposeUrl(owned.authUrl, "auth"));
  staffSql = await connect(validatePurposeUrl(owned.staffUrl, "staff"));
  readerSql = await connect(validatePurposeUrl(owned.readerUrl, "reader"));
});
afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of closeables.reverse())
    try {
      await close();
    } catch {
      failures.push(new Error("Owned spike client cleanup failed."));
    }
  if (owned)
    try {
      await owned.dispose();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Spike cleanup did not complete safely.",
    );
});

describe("real Better Auth1.7.18 / Prisma7 / Next16 adapter", () => {
  it("authenticates a synthetic password but rejects a first-factor-only staff session", async () => {
    const f = await fixture({ enrolled: false });
    expect(Boolean(await f.browser.session())).toBe(true);
    expect((await admission.authorize(f.browser)).allowed).toBe(false);
    const account = await identity.account.findFirstOrThrow({
      where: { userId: f.id },
    });
    expect(Boolean(account.password && account.password !== f.password)).toBe(
      true,
    );
  });
  it("rejects a wrong password without returning credentials", async () => {
    const f = await fixture({ enrolled: false });
    const result = await login(f.email, "Wrong synthetic password!123");
    expect(result.response.ok).toBe(false);
    const text = await result.response.text();
    expect(
      text.includes(f.password) ||
        text.includes(secret) ||
        text.includes("postgresql://"),
    ).toBe(false);
    expect(await result.browser.session()).toBeNull();
  });
  it("requires real TOTP after enrollment and admits only after verification", async () => {
    const f = await fixture();
    const { browser, response } = await login(f.email, f.password);
    expect((await json(response)).twoFactorRedirect).toBe(true);
    expect(await browser.session()).toBeNull();
    expect((await admission.authorize(browser)).allowed).toBe(false);
    const wrong = await browser.call("/two-factor/verify-totp", {
      code: "not-a-code",
      trustDevice: false,
    });
    expect(wrong.ok).toBe(false);
    expect((await admission.verify(browser, await totp(f.uri))).allowed).toBe(
      true,
    );
    expect((await admission.authorize(browser)).allowed).toBe(true);
  });
  it("encrypts TOTP and backup material at rest using the library", async () => {
    const f = await fixture();
    const stored = await identity.twoFactor.findFirstOrThrow({
      where: { userId: f.id },
    });
    const encoded = new URL(f.uri).searchParams.get("secret")!;
    const raw = new TextDecoder().decode(base32.decode(encoded));
    expect(stored.secret.includes(encoded) || stored.secret === raw).toBe(
      false,
    );
    expect(
      f.backupCodes.some((code) => stored.backupCodes.includes(code)),
    ).toBe(false);
    expect(stored.verified).toBe(true);
  });
  it("does not admit an unapproved identity even after provider MFA", async () => {
    const f = await fixture({ staff: false });
    expect(Boolean(await f.browser.session())).toBe(true);
    expect((await admission.authorize(f.browser)).allowed).toBe(false);
  });
  it.each(["suspended", "disabled"])(
    "denies live %s staff despite a valid provider session",
    async (status) => {
      const f = await fixture();
      await staffSql.query(
        "UPDATE staff.principals SET status=$2,authz_version=authz_version+1 WHERE user_id=$1",
        [f.id, status],
      );
      expect(Boolean(await f.browser.session())).toBe(true);
      expect((await admission.authorize(f.browser)).allowed).toBe(false);
    },
  );
  it("invalidates admission on access-version changes, not cached role claims", async () => {
    const f = await fixture();
    await staffSql.query(
      "UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=$1",
      [f.id],
    );
    expect((await admission.authorize(f.browser)).reason).toBe("mfa_required");
  });
  it("revokes the real provider session and rejects replayed old cookies", async () => {
    const f = await fixture();
    const stolen = new SyntheticBrowser(provider);
    stolen.copyCookiesFrom(f.browser);
    expect((await f.browser.call("/sign-out", {})).ok).toBe(true);
    expect(await stolen.session()).toBeNull();
    expect((await admission.authorize(stolen)).allowed).toBe(false);
  });
  it("expires a provider session in the database", async () => {
    const f = await fixture();
    const session = await f.browser.session();
    await identity.session.update({
      where: { id: session!.session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await f.browser.session()).toBeNull();
    expect((await admission.authorize(f.browser)).allowed).toBe(false);
  });
  it("uses the proposed8h candidate without sliding refresh or cookie cache", async () => {
    const f = await fixture();
    const session = await f.browser.session();
    const seconds =
      (session!.session.expiresAt.getTime() -
        session!.session.createdAt.getTime()) /
      1000;
    expect(Math.abs(seconds - proposedPolicy.absoluteSeconds) < 2).toBe(true);
    expect(provider.options.session?.cookieCache?.enabled).toBe(false);
    expect(provider.options.session?.disableSessionRefresh).toBe(true);
  });
  it("simulates idle expiry and recent-MFA policy without changing application settings", async () => {
    const f = await fixture();
    const future = new AdmissionProof(
      owned.staffUrl,
      () => new Date(Date.now() + 6 * 60 * 1000),
    );
    const idle = new AdmissionProof(
      owned.staffUrl,
      () => new Date(Date.now() + 31 * 60 * 1000),
    );
    try {
      expect((await future.authorize(f.browser, "sensitive")).reason).toBe(
        "step_up_required",
      );
      expect((await idle.authorize(f.browser)).reason).toBe("session_expired");
    } finally {
      await future.close();
      await idle.close();
    }
  });
  it("accepts a backup code only into recovery state and refuses reuse", async () => {
    const f = await fixture();
    const code = f.backupCodes[0];
    const first = await login(f.email, f.password);
    expect(
      (await admission.verify(first.browser, code, "recovery")).allowed,
    ).toBe(true);
    expect((await admission.authorize(first.browser)).reason).toBe(
      "recovery_only",
    );
    expect((await admission.authorize(first.browser, "recovery")).allowed).toBe(
      true,
    );
    expect((await admission.authorize(f.browser)).allowed).toBe(false);
    const replay = await login(f.email, f.password);
    expect(
      (
        await replay.browser.call("/two-factor/verify-backup-code", {
          code,
          trustDevice: false,
        })
      ).ok,
    ).toBe(false);
  });
  it("does not upgrade a provider-only MFA session into admission automatically", async () => {
    const f = await fixture();
    const raw = await login(f.email, f.password);
    expect(
      (
        await raw.browser.call("/two-factor/verify-totp", {
          code: await totp(f.uri),
          trustDevice: false,
        })
      ).ok,
    ).toBe(true);
    expect(Boolean(await raw.browser.session())).toBe(true);
    expect((await admission.authorize(raw.browser)).reason).toBe(
      "mfa_required",
    );
  });
  it("rolls back admission on an audit insert failure and fails closed", async () => {
    const f = await fixture();
    const fresh = await login(f.email, f.password);
    const role = new URL(owned.staffUrl).username;
    await migration.query(`REVOKE INSERT ON audit.events FROM "${role}"`);
    try {
      const result = await admission.verify(fresh.browser, await totp(f.uri));
      expect(result.status).toBe(503);
      expect(Boolean(await fresh.browser.session())).toBe(true);
      expect((await admission.authorize(fresh.browser)).allowed).toBe(false);
    } finally {
      await migration.query(`GRANT INSERT ON audit.events TO "${role}"`);
    }
  });
  it("does not log credential/token fields in its admission audit DTO", async () => {
    const f = await fixture();
    const events = await staffSql.query(
      "SELECT action,details FROM audit.events WHERE actor_id=$1",
      [f.id],
    );
    expect(events.rows.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events.rows);
    expect(
      [f.password, secret, ...f.backupCodes].some((value) =>
        serialized.includes(value),
      ),
    ).toBe(false);
    expect(
      events.rows.every((row) => Object.keys(row.details).join(",") === "mode"),
    ).toBe(true);
  });
  it("preserves secure HTTP-only SameSite cookies without cache/remember cookies", async () => {
    const f = await fixture({ enrolled: false });
    const response = (await login(f.email, f.password)).response;
    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some(
        (value) =>
          /session_token=/.test(value) &&
          /HttpOnly/i.test(value) &&
          /Secure/i.test(value) &&
          /SameSite=Strict/i.test(value),
      ),
    ).toBe(true);
    expect(
      cookies.some((value) => /session_data=|trust_device=/.test(value)),
    ).toBe(false);
  });
  it("rejects a foreign origin at the real handler boundary", async () => {
    const f = await fixture({ enrolled: false });
    const response = await new SyntheticBrowser(provider).call(
      "/sign-in/email",
      { email: f.email, password: f.password },
      { origin: "https://attacker.invalid" },
    );
    expect(response.status).toBe(403);
  });
  it.each([
    "/sign-up/email",
    "//sign-up/email",
    "/sign-up//email",
    "/sign-in/social",
    "/sign-in/magic-link",
    "/sign-in/email-otp",
    "/sign-in/anonymous",
    "/link-social",
    "/two-factor/disable",
    "/totp/generate",
    "/admin/create-user",
  ])("closes unintended provider endpoint %s", async (path) => {
    const count = await identity.user.count();
    const response = await new SyntheticBrowser(provider).call(path, {
      email: `closed-${randomUUID()}@example.invalid`,
      password: "Synthetic closed signup!123",
      name: "Synthetic unauthorized",
      secret: "unused",
    });
    expect(response.ok).toBe(false);
    expect(await identity.user.count()).toBe(count);
  });
  it("rejects unauthenticated verification/enrollment", async () => {
    const browser = new SyntheticBrowser(provider);
    expect(
      (
        await browser.call("/two-factor/enable", {
          password: "Synthetic unused password!",
        })
      ).ok,
    ).toBe(false);
    expect(
      (await browser.call("/two-factor/verify-totp", { code: "000000" })).ok,
    ).toBe(false);
  });
  it("consumes a backup code at most once across concurrent independent challenges", async () => {
    const f = await fixture();
    const a = await login(f.email, f.password),
      b = await login(f.email, f.password);
    const responses = await Promise.all(
      [a.browser, b.browser].map((browser) =>
        browser.call("/two-factor/verify-backup-code", {
          code: f.backupCodes[0],
          trustDevice: false,
        }),
      ),
    );
    expect(responses.filter((response) => response.ok).length).toBe(1);
    expect(
      responses.every((response) => [200, 401, 409].includes(response.status)),
    ).toBe(true);
    expect(
      (await admission.authorize(a.browser)).allowed ||
        (await admission.authorize(b.browser)).allowed,
    ).toBe(false);
  });
  it("requires fresh TOTP even when a caller requests a trusted-device cookie", async () => {
    const f = await fixture();
    const flow = await login(f.email, f.password);
    const verified = await flow.browser.call("/two-factor/verify-totp", {
      code: await totp(f.uri),
      trustDevice: true,
    });
    expect(verified.ok).toBe(true);
    // Deliberately replay even expired Set-Cookie values; server TTL must hold.
    const replayCookie = verified.headers
      .getSetCookie()
      .map((header) => header.split(";", 1)[0])
      .join("; ");
    const retry = new SyntheticBrowser(provider);
    const response = await retry.call(
      "/sign-in/email",
      { email: f.email, password: f.password },
      { cookie: replayCookie },
    );
    expect((await json(response)).twoFactorRedirect).toBe(true);
    expect(await retry.session()).toBeNull();
    expect((await admission.authorize(retry)).allowed).toBe(false);
  });
  it("enforces the real PostgreSQL handler rate budget under concurrent requests", async () => {
    const browser = new SyntheticBrowser(provider, "192.0.2.240");
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        browser.call("/two-factor/enable", {
          password: "Synthetic never authenticated!",
        }),
      ),
    );
    expect(
      responses.every((response) => [401, 429].includes(response.status)),
    ).toBe(true);
    expect(
      responses.filter((response) => response.status !== 429).length,
    ).toBeLessThanOrEqual(3);
  });
  it("applies account-level failed-MFA lockout across new challenges and IPs", async () => {
    const f = await fixture();
    for (let attempt = 0; attempt < 10; attempt++) {
      const flow = await login(f.email, f.password);
      expect(
        (
          await flow.browser.call("/two-factor/verify-totp", {
            code: "invalid",
            trustDevice: false,
          })
        ).ok,
      ).toBe(false);
    }
    const factor = await identity.twoFactor.findFirstOrThrow({
      where: { userId: f.id },
    });
    expect(
      factor.failedVerificationCount >= 10 &&
        Boolean(
          factor.lockedUntil && factor.lockedUntil.getTime() > Date.now(),
        ),
    ).toBe(true);
    const locked = await login(f.email, f.password);
    expect(
      (
        await locked.browser.call("/two-factor/verify-totp", {
          code: await totp(f.uri),
          trustDevice: false,
        })
      ).ok,
    ).toBe(false);
    expect((await admission.authorize(locked.browser)).allowed).toBe(false);
  });
  it("rejects fabricated cookies and cannot self-promote through provider profile fields", async () => {
    const f = await fixture({ enrolled: false });
    const forged = await new SyntheticBrowser(provider).call(
      "/get-session",
      undefined,
      { cookie: "__Secure-better-auth.session_token=forged" },
    );
    expect(await forged.json()).toBeNull();
    expect(
      (
        await f.browser.call("/update-user", {
          role: "Owner",
          twoFactorEnabled: true,
          authzVersion: 999,
        })
      ).ok,
    ).toBe(false);
    expect((await admission.authorize(f.browser)).allowed).toBe(false);
  });
  it("projects admission results rather than the provider's raw bearer-token session DTO", async () => {
    const f = await fixture();
    const raw = await json(await f.browser.call("/get-session"));
    expect(
      Boolean((raw.session as Record<string, unknown> | undefined)?.token),
    ).toBe(true);
    expect(Object.keys(await admission.authorize(f.browser)).sort()).toEqual([
      "allowed",
      "reason",
      "status",
    ]);
  });
  it("fails closed with a sanitized result when staff persistence is unavailable", async () => {
    const f = await fixture();
    const unavailable = new AdmissionProof(owned.staffUrl);
    await unavailable.close();
    expect(await unavailable.authorize(f.browser)).toEqual({
      allowed: false,
      status: 503,
      reason: "security_unavailable",
    });
  });
  it("keeps exact fictional catalog DTO parity under the dedicated SELECT-only role", async () => {
    expect(
      await new PostgresCatalogRepository(catalogReader).getSnapshot(),
    ).toEqual(await new FixtureCatalogRepository().getSnapshot());
  });
});

describe("database privilege boundaries", () => {
  it.each(["reader", "auth", "staff"] as const)(
    "%s is not superuser, migration owner or a member of another role",
    async (purpose) => {
      const client = { reader: readerSql, auth: authSql, staff: staffSql }[
        purpose
      ];
      const row = (
        await client.query(
          "SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0];
      expect(Object.values(row).every((value) => value === false)).toBe(true);
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)",
          )
        ).rows[0].n,
      ).toBe(0);
    },
  );
  it.each([
    ["reader", 'SELECT * FROM identity."Account"'],
    ["reader", "SELECT * FROM staff.principals"],
    [
      "reader",
      'UPDATE public."Product" SET "merchandisingTitle"="merchandisingTitle"',
    ],
    ["reader", "CREATE TABLE public.forbidden(id int)"],
    ["auth", 'SELECT * FROM public."Product"'],
    ["auth", "UPDATE staff.principals SET role='Owner'"],
    ["auth", "INSERT INTO audit.events(action) VALUES('ACCESS_CHANGED')"],
    ["auth", "CREATE TABLE identity.forbidden(id int)"],
    ["staff", 'SELECT * FROM identity."Session"'],
    [
      "staff",
      'UPDATE public."Product" SET "merchandisingTitle"="merchandisingTitle"',
    ],
    ["staff", "UPDATE audit.events SET action='ACCESS_CHANGED'"],
    ["staff", "DELETE FROM audit.events"],
    ["staff", "TRUNCATE audit.events"],
    ["staff", "CREATE TABLE staff.forbidden(id int)"],
  ])("denies %s forbidden privilege %#", async (purpose, sql) => {
    await expectDenied(
      { reader: readerSql, auth: authSql, staff: staffSql }[
        purpose as "reader" | "auth" | "staff"
      ],
      sql,
    );
  });
  it("cannot make the catalog reader writable by changing a session setting", async () => {
    await readerSql.query("SET default_transaction_read_only=off");
    await expectDenied(
      readerSql,
      'UPDATE public."Product" SET "merchandisingTitle"="merchandisingTitle"',
    );
  });
  it("rejects cross-account admission association with a composite FK", async () => {
    const a = await fixture(),
      b = await fixture();
    const session = await a.browser.session();
    await expect(
      staffSql.query(
        "UPDATE staff.admissions SET user_id=$2 WHERE session_id=$1",
        [session!.session.id, b.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
