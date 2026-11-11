import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { twoFactor } from "better-auth/plugins";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { PrismaClient } from "../../src/generated/security/client";
import {
  createFoundationDatabase,
  type FoundationDatabase,
} from "../security-foundation/database";
import { runSecurityMigrations } from "../../scripts/security-database";
import { seedOfflineAdmissionControls } from "../admission-controls/offline-fixture";
import { createSecurityKernel } from "../../src/server/security/kernel";
import {
  createUnmountedProvider,
  UNMOUNTED_PROVIDER_ORIGIN,
  type UnmountedProvider,
} from "../../src/server/security/provider-proof";

class Jar {
  private values = new Map<string, string>();
  get header() {
    return [...this.values].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(response: Response) {
    for (const entry of response.headers.getSetCookie()) {
      const first = entry.split(";", 1)[0],
        at = first.indexOf("="),
        key = first.slice(0, at),
        value = first.slice(at + 1);
      if (!value || /max-age=0(?:;|$)/i.test(entry)) this.values.delete(key);
      else this.values.set(key, value);
    }
  }
  clone() {
    const result = new Jar();
    result.values = new Map(this.values);
    return result;
  }
}
let owned: FoundationDatabase,
  migration: Client,
  authSql: Client,
  worker: Client;
let identity: PrismaClient,
  fixtureProvider: ReturnType<typeof buildFixtureProvider>,
  subject: UnmountedProvider;
const secret = randomBytes(48).toString("base64url");
const closers: Array<() => Promise<unknown>> = [];
const password = randomBytes(32).toString("base64url");
function buildFixtureProvider(client: PrismaClient) {
  // NEVER imported into integration/application code. Offline synthetic setup only.
  // This fixture uses maintained signup/enrollment APIs; it is not the subject's policy.
  return betterAuth({
    appName: "Synthetic canonical proof fixtures",
    baseURL: UNMOUNTED_PROVIDER_ORIGIN,
    basePath: "/api/unmounted-provider-proof",
    secret,
    database: prismaAdapter(client, {
      provider: "postgresql",
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 15,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 8 * 3600,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: "bookstore-provider-proof",
      defaultCookieAttributes: {
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      },
    },
    plugins: [
      twoFactor({
        issuer: "Synthetic proof fixture",
        skipVerificationOnEnable: false,
        trustDeviceMaxAge: 0,
        backupCodeOptions: { storeBackupCodes: "encrypted" },
      }),
    ],
    telemetry: { enabled: false },
    logger: { disabled: true },
  });
}
async function sql(url: string) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  await client.connect();
  closers.push(() => client.end());
  return client;
}
async function drain() {
  for (let i = 0; i < 20; i++) {
    const batch = await worker.query<{ id: string }>(
      "SELECT * FROM audit.pending_provider_events(100)",
    );
    if (!batch.rowCount) return;
    for (const row of batch.rows)
      await worker.query("SELECT audit.reconcile_provider_event($1)", [row.id]);
  }
  throw new Error("Synthetic reconciliation bound exceeded");
}
async function code(secretBase32: string) {
  return createOTP(base32.decode(secretBase32)).totp();
}
interface Fixture {
  userId: string;
  email: string;
  password: string;
  secret: string | null;
  jar: Jar;
}
async function fixture(
  options: { mfa?: boolean | "pending"; staff?: boolean } = {},
): Promise<Fixture> {
  const email = `${randomUUID()}@example.invalid`,
    jar = new Jar();
  const signed = await fixtureProvider.api.signUpEmail({
    body: { email, password, name: "Synthetic provider fixture" },
    asResponse: true,
  });
  expect(signed.status).toBe(200);
  jar.absorb(signed);
  const data = (await signed.json()) as { user: { id: string } };
  let factor: string | null = null;
  if (options.mfa !== false) {
    const enable = await fixtureProvider.api.enableTwoFactor({
      body: { password },
      headers: new Headers({ cookie: jar.header }),
      asResponse: true,
    });
    expect(enable.status).toBe(200);
    jar.absorb(enable);
    const setup = (await enable.json()) as { totpURI: string };
    factor = new URL(setup.totpURI).searchParams.get("secret");
    if (!factor)
      throw new Error("Synthetic setup missing authenticator material");
    if (options.mfa !== "pending") {
      const verified = await fixtureProvider.api.verifyTOTP({
        body: { code: await code(factor), trustDevice: false },
        headers: new Headers({ cookie: jar.header }),
        asResponse: true,
      });
      expect(verified.status).toBe(200);
      jar.absorb(verified);
    }
  }
  await drain();
  if (options.staff !== false) {
    await migration.query(
      "INSERT INTO staff.principals(user_id,status) VALUES($1,'active')",
      [data.user.id],
    );
    await migration.query(
      "INSERT INTO staff.role_grants(user_id,role_name) VALUES($1,'Analyst')",
      [data.user.id],
    );
  }
  return { userId: data.user.id, email, password, secret: factor, jar };
}
async function begin(f: Fixture) {
  const jar = new Jar();
  const operation = await subject.password(f.email, f.password);
  jar.absorb(operation.response);
  return { jar, operation };
}
async function login(f: Fixture) {
  const { jar, operation } = await begin(f);
  expect(operation.response.status).toBe(200);
  const verified = await subject.verifyTotp(
    await code(f.secret!),
    jar.header,
    operation.primary,
  );
  jar.absorb(verified.response);
  return { jar, verified, primary: operation };
}
async function faultSessionInsert() {
  await migration.query(
    "CREATE FUNCTION public.proof_session_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic provider persistence fault' USING ERRCODE='P0001'; END $$",
  );
  await migration.query(
    'CREATE TRIGGER proof_session_fault BEFORE INSERT ON identity."Session" FOR EACH ROW EXECUTE FUNCTION public.proof_session_fault()',
  );
}
async function restoreSessionInsert() {
  await migration.query(
    'DROP TRIGGER proof_session_fault ON identity."Session"',
  );
  await migration.query("DROP FUNCTION public.proof_session_fault()");
}
beforeAll(async () => {
  owned = await createFoundationDatabase();
  await runSecurityMigrations(owned.migrationUrl);
  await owned.hardenPrivileges();
  migration = await sql(owned.migrationUrl);
  authSql = await sql(owned.authUrl);
  worker = await sql(owned.workerUrl);
  identity = new PrismaClient({
    adapter: new PrismaPg({ connectionString: owned.authUrl, max: 3 }),
  });
  closers.push(() => identity.$disconnect());
  fixtureProvider = buildFixtureProvider(identity);
  subject = await createUnmountedProvider({
    authUrl: owned.authUrl,
    staffUrl: owned.staffUrl,
    secret,
  });
  closers.push(() => subject.close());
});
beforeEach(async () => {
  // Independent scenario setup ONLY. No reset/retry occurs inside a throttle test.
  await migration.query('DELETE FROM identity."RateLimit"');
  await drain();
});
afterAll(async () => {
  vi.restoreAllMocks();
  const closed = await Promise.allSettled(closers.map((close) => close()));
  await owned?.dispose();
  for (const item of closed) if (item.status === "rejected") throw item.reason;
});

describe("canonical unmounted provider and trusted resolver", () => {
  it("uses exactly seven canonical migrations and no staff/admission seed", async () => {
    expect(
      (
        await migration.query(
          'SELECT count(*)::int AS count FROM public."_prisma_migrations"',
        )
      ).rows[0].count,
    ).toBe(7);
    expect(
      (await migration.query("SELECT state FROM staff.governance")).rows[0]
        .state,
    ).toBe("uninitialized");
    expect(
      (
        await migration.query(
          "SELECT count(*)::int AS count FROM staff.admissions",
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("authenticates maintained-library password sessions but never infers MFA/admission", async () => {
    const f = await fixture({ mfa: false });
    const { jar, operation } = await begin(f);
    expect((await operation.response.json()).state).toBe(
      "password-authenticated",
    );
    const resolved = await subject.resolveSession(jar.header);
    expect(resolved).toMatchObject({
      state: "provider-authenticated",
      userId: f.userId,
      staffAdmission: "not-established",
    });
    expect(operation.observation).toBeNull();
    const kernel = createSecurityKernel(owned.staffUrl);
    try {
      expect(
        (await kernel.authorize("security.self.read", resolved)).allowed,
      ).toBe(false);
    } finally {
      await kernel.close();
    }
  });
  it("has no provider session before a mandatory-TOTP challenge completes", async () => {
    const f = await fixture();
    const { jar, operation } = await begin(f);
    expect((await operation.response.json()).state).toBe("totp-required");
    expect((await subject.resolveSession(jar.header)).state).toBe(
      "unauthenticated",
    );
    expect(operation.primary).not.toBeNull();
  });
  it.each([
    null,
    {},
    "",
    123,
    "cookie\r\nforged=1",
    "x=%zz",
    "x=one; x=two",
    "x=with space",
  ])(
    "fails closed for malformed/missing credential case %#",
    async (cookie) => {
      expect((await subject.resolveSession(cookie)).state).toBe(
        "unauthenticated",
      );
    },
  );
  it("rejects a tampered cookie and never trusts identity/role cookie claims", async () => {
    const f = await fixture({ mfa: false });
    const { jar } = await begin(f);
    const forged = jar.header.replace(/(session_token=)[^;]/, "$1X");
    expect((await subject.resolveSession(forged)).state).toBe(
      "unauthenticated",
    );
    expect(
      (
        await subject.resolveSession(
          "userId=Owner; role=Owner; mfaVerified=true",
        )
      ).state,
    ).toBe("unauthenticated");
  });
  it("checks current database expiry without cookie cache or sliding renewal", async () => {
    const f = await fixture({ mfa: false });
    const { jar } = await begin(f);
    const before = await subject.resolveSession(jar.header);
    if (before.state !== "provider-authenticated")
      throw new Error("Synthetic session missing");
    await subject.resolveSession(jar.header);
    const row = await identity.session.findUniqueOrThrow({
      where: { id: before.sessionId },
    });
    expect(row.expiresAt.toISOString()).toBe(before.expiresAt);
    await authSql.query(
      'UPDATE identity."Session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',
      [before.sessionId],
    );
    expect((await subject.resolveSession(jar.header)).state).toBe(
      "unauthenticated",
    );
  });
  it("rejects retained credentials after native SDK sign-out revokes the provider session", async () => {
    const f = await fixture({ mfa: false });
    const { jar } = await begin(f);
    const old = jar.header;
    const out = await subject.signOut(old);
    expect(out.response.status).toBe(200);
    jar.absorb(out.response);
    expect((await subject.resolveSession(old)).state).toBe("unauthenticated");
    expect(out.response.headers.getSetCookie().length).toBeGreaterThan(0);
  });
  it("returns unavailable rather than anonymous after a credential table permission outage", async () => {
    const f = await fixture({ mfa: false });
    const { jar } = await begin(f);
    const role = new URL(owned.authUrl).username;
    if (!/^bf_[a-f0-9]{12}_auth$/.test(role))
      throw new Error("Synthetic role mismatch");
    await migration.query(`REVOKE SELECT ON identity."Session" FROM "${role}"`);
    try {
      expect((await subject.resolveSession(jar.header)).state).toBe(
        "unavailable",
      );
    } finally {
      await migration.query(`GRANT SELECT ON identity."Session" TO "${role}"`);
    }
  });
  it("rejects privilege drift before another SDK lookup", async () => {
    const role = new URL(owned.authUrl).username;
    await migration.query(`GRANT USAGE ON SCHEMA staff TO "${role}"`);
    try {
      expect((await subject.resolveSession("")).state).toBe("unavailable");
    } finally {
      await migration.query(`REVOKE USAGE ON SCHEMA staff FROM "${role}"`);
    }
  });
  it("exports only sanitized resolver bodies and opaque observation DTOs", async () => {
    const f = await fixture();
    const { jar, verified } = await login(f);
    expect(verified.response.status).toBe(200);
    const resolved = await subject.resolveSession(jar.header);
    if (resolved.state !== "provider-authenticated")
      throw new Error("Synthetic final session missing");
    expect(Object.keys(resolved).sort()).toEqual([
      "expiresAt",
      "sessionId",
      "staffAdmission",
      "state",
      "userId",
    ]);
    const token = (
      await identity.session.findUniqueOrThrow({
        where: { id: resolved.sessionId },
        select: { token: true },
      })
    ).token;
    const exposed = JSON.stringify({
      resolved,
      observation: verified.observation,
      diagnostics: verified.diagnostics,
      body: await verified.response.json(),
    });
    for (const sensitive of [token, f.password, f.secret!])
      expect(exposed.includes(sensitive)).toBe(false);
    expect(/backupCodes|otpauth:|twoFactorEnabled|cookie/i.test(exposed)).toBe(
      false,
    );
  });
});

describe("SDK cookie and non-admission evidence", () => {
  it("emits multiple scoped Secure HttpOnly Strict cookies, never body tokens", async () => {
    const f = await fixture();
    const { jar, operation } = await begin(f);
    const verified = await subject.verifyTotp(
      await code(f.secret!),
      jar.header,
      operation.primary,
    );
    expect(verified.response.status).toBe(200);
    expect(verified.response.headers.getSetCookie().length).toBeGreaterThan(1);
    for (const response of [operation.response, verified.response])
      for (const cookie of response.headers.getSetCookie()) {
        expect(cookie.startsWith("__Secure-bookstore-provider-proof.")).toBe(
          true,
        );
        expect(/;\s*Secure(?:;|$)/i.test(cookie)).toBe(true);
        expect(/;\s*HttpOnly(?:;|$)/i.test(cookie)).toBe(true);
        expect(/;\s*SameSite=Strict(?:;|$)/i.test(cookie)).toBe(true);
        expect(/;\s*Path=\/(?:;|$)/i.test(cookie)).toBe(true);
        expect(/;\s*Domain=/i.test(cookie)).toBe(false);
      }
    expect(Object.keys(await verified.response.json()).sort()).toEqual([
      "staffAdmission",
      "state",
    ]);
  });
  it("does not infer TOTP from an enabled flag without a maintained verified factor", async () => {
    const f = await fixture({ mfa: false });
    await authSql.query(
      'UPDATE identity."User" SET "twoFactorEnabled"=true WHERE id=$1',
      [f.userId],
    );
    const { jar, operation } = await begin(f);
    expect(operation.observation).toBeNull();
    const absent = await subject.verifyTotp(
      "123456",
      jar.header,
      operation.primary,
    );
    expect(absent.response.status).toBe(400);
    expect(absent.observation).toBeNull();
  });
  it("keeps a successful SDK factor verification non-admitted without a staff principal", async () => {
    const f = await fixture({ staff: false });
    const { jar, verified } = await login(f);
    expect(verified.response.status).toBe(200);
    expect(verified.observation!.authorizationVersionBefore).toBeNull();
    expect(
      await subject.assessObservation(verified.observation, jar.header),
    ).toMatchObject({
      bindingsMatch: false,
      admissionAllowed: false,
      reason: "version-mismatch",
    });
  });
});

describe("real SDK TOTP observation, not a positive admission proof", () => {
  it("observes actual TOTP success, final cookie ownership and an ordered time interval", async () => {
    const f = await fixture();
    const { jar, verified } = await login(f);
    expect(verified.response.status).toBe(200);
    expect(verified.observation).toMatchObject({
      kind: "sdk-totp-observation",
      userId: f.userId,
      purpose: "login-investigation",
      staffAdmission: "not-established",
      durable: false,
      priorSessionId: null,
    });
    const obs = verified.observation!;
    expect(Date.parse(obs.operationCompletedAt)).toBeGreaterThanOrEqual(
      Date.parse(obs.operationStartedAt),
    );
    expect(await subject.assessObservation(obs, jar.header)).toMatchObject({
      bindingsMatch: true,
      admissionAllowed: false,
      reason: "bindings-match-not-authorizing",
    });
    expect(verified.diagnostics.jsonTokenMatchesFinalSession).toBe(true);
    expect(
      (
        await migration.query(
          "SELECT count(*)::int AS count FROM staff.admissions WHERE user_id=$1",
          [f.userId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("rejects incorrect TOTP without minting an observation", async () => {
    const f = await fixture();
    const { jar, operation } = await begin(f);
    const current = await code(f.secret!);
    const wrong = current === "000000" ? "111111" : "000000";
    const denied = await subject.verifyTotp(
      wrong,
      jar.header,
      operation.primary,
    );
    expect(denied.response.status).toBe(401);
    expect(denied.observation).toBeNull();
  });
  it("rejects an expired real-library TOTP outside the supported time window", async () => {
    const f = await fixture();
    const { jar, operation } = await begin(f);
    const now = Date.now();
    let expired: string;
    const spy = vi.spyOn(Date, "now").mockReturnValue(now - 120000);
    try {
      expired = await code(f.secret!);
    } finally {
      spy.mockRestore();
    }
    if (expired === (await code(f.secret!)))
      throw new Error("Synthetic OTP collision; no retry hides it");
    const denied = await subject.verifyTotp(
      expired,
      jar.header,
      operation.primary,
    );
    expect(denied.response.status).toBe(401);
    expect(denied.observation).toBeNull();
  });
  it("consumes one SDK sign-in challenge and rejects old-challenge replay", async () => {
    const f = await fixture();
    const { jar, operation } = await begin(f);
    const old = jar.header,
      otp = await code(f.secret!);
    const first = await subject.verifyTotp(otp, old, operation.primary);
    expect(first.response.status).toBe(200);
    const again = await subject.verifyTotp(otp, old, operation.primary);
    expect(again.response.status).toBe(401);
    expect(again.observation).toBeNull();
  });
  it("allows at most one final session from concurrent use of the same native challenge", async () => {
    const f = await fixture();
    const { jar, operation } = await begin(f);
    const otp = await code(f.secret!);
    const before = await identity.session.count({
      where: { userId: f.userId },
    });
    const attempts = await Promise.all([
      subject.verifyTotp(otp, jar.header, operation.primary),
      subject.verifyTotp(otp, jar.header, operation.primary),
    ]);
    expect(attempts.map((value) => value.response.status).sort()).toEqual([
      200, 401,
    ]);
    expect(attempts.filter((value) => value.observation !== null).length).toBe(
      1,
    );
    expect(await identity.session.count({ where: { userId: f.userId } })).toBe(
      before + 1,
    );
  });
  it("refuses forged or serialized primary/observation references", async () => {
    const f = await fixture();
    const { jar, operation } = await begin(f);
    const denied = await subject.verifyTotp(
      await code(f.secret!),
      jar.header,
      structuredClone(operation.primary),
    );
    expect(denied.response.status).toBe(403);
    const good = await subject.verifyTotp(
      await code(f.secret!),
      jar.header,
      operation.primary,
    );
    jar.absorb(good.response);
    expect(
      await subject.assessObservation(
        structuredClone(good.observation),
        jar.header,
      ),
    ).toMatchObject({
      bindingsMatch: false,
      admissionAllowed: false,
      reason: "malformed",
    });
  });
  it("rejects cross-account and cross-session substitution", async () => {
    const a = await fixture(),
      b = await fixture();
    const aa = await login(a),
      bb = await login(b);
    expect(
      await subject.assessObservation(aa.verified.observation, bb.jar.header),
    ).toMatchObject({
      bindingsMatch: false,
      admissionAllowed: false,
      reason: "identity-mismatch",
    });
    expect(
      await subject.assessObservation(aa.verified.observation, a.jar.header),
    ).toMatchObject({
      bindingsMatch: false,
      admissionAllowed: false,
      reason: "session-mismatch",
    });
  });
  it("binds private primary context to its actual challenge cookie", async () => {
    const a = await fixture(),
      b = await fixture();
    const aa = await begin(a),
      bb = await begin(b);
    const mismatch = await subject.verifyTotp(
      await code(a.secret!),
      bb.jar.header,
      aa.operation.primary,
    );
    expect(mismatch.response.status).toBe(403);
    expect(mismatch.observation).toBeNull();
  });
  it("observes separate simultaneous challenges accepting the same time-step code: SDK replay gap", async () => {
    const f = await fixture();
    const a = await begin(f),
      b = await begin(f),
      otp = await code(f.secret!);
    const [one, two] = await Promise.all([
      subject.verifyTotp(otp, a.jar.header, a.operation.primary),
      subject.verifyTotp(otp, b.jar.header, b.operation.primary),
    ]);
    expect([one.response.status, two.response.status]).toEqual([200, 200]);
    expect(one.observation!.sessionId === two.observation!.sessionId).toBe(
      false,
    );
    expect(one.observation!.durable).toBe(false);
    expect(two.observation!.staffAdmission).toBe("not-established");
  });
  it("observes active-session TOTP reuse without SDK one-use challenge consumption", async () => {
    const f = await fixture();
    const otp = await code(f.secret!);
    const first = await subject.verifyTotp(otp, f.jar.header),
      second = await subject.verifyTotp(otp, f.jar.header);
    expect([first.response.status, second.response.status]).toEqual([200, 200]);
    expect(first.observation!.sessionId).toBe(second.observation!.sessionId);
    expect(first.observation!.purpose).toBe("active-session-investigation");
    expect(
      (await subject.assessObservation(second.observation, f.jar.header))
        .admissionAllowed,
    ).toBe(false);
  });
  it("rejects stale authorization versions rather than adopting latest state", async () => {
    const f = await fixture();
    const { jar, verified } = await login(f);
    await migration.query(
      "UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=$1",
      [f.userId],
    );
    expect(
      await subject.assessObservation(verified.observation, jar.header),
    ).toMatchObject({
      bindingsMatch: false,
      admissionAllowed: false,
      reason: "version-mismatch",
    });
  });
  it("rejects factor removal even when a provider cookie still authenticates", async () => {
    const f = await fixture();
    const { jar, verified } = await login(f);
    await authSql.query('DELETE FROM identity."TwoFactor" WHERE "userId"=$1', [
      f.userId,
    ]);
    expect((await subject.resolveSession(jar.header)).state).toBe(
      "provider-authenticated",
    );
    expect(
      await subject.assessObservation(verified.observation, jar.header),
    ).toMatchObject({
      bindingsMatch: false,
      admissionAllowed: false,
      reason: "factor-lineage-mismatch",
    });
    const absent = await subject.verifyTotp(await code(f.secret!), jar.header);
    expect(absent.response.status).toBe(400);
    expect(absent.observation).toBeNull();
  });
  it("keeps the pinned native two-factor three-per-ten-second rule enabled", async () => {
    const f = await fixture();
    const otp = await code(f.secret!);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push(
        (await subject.verifyTotp(otp, f.jar.header)).response.status,
      );
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe("original context and provider lineage", () => {
  it("does not rebase a password context to a version changed before TOTP completion", async () => {
    const f = await fixture();
    const { jar, operation } = await begin(f);
    await migration.query(
      "UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=$1",
      [f.userId],
    );
    const completed = await subject.verifyTotp(
      await code(f.secret!),
      jar.header,
      operation.primary,
    );
    jar.absorb(completed.response);
    expect(completed.response.status).toBe(200);
    expect(
      completed.observation!.authorizationVersionBefore ===
        completed.observation!.authorizationVersionAfter,
    ).toBe(false);
    expect(
      await subject.assessObservation(completed.observation, jar.header),
    ).toMatchObject({
      bindingsMatch: false,
      admissionAllowed: false,
      reason: "version-mismatch",
    });
  });
  it("rejects an old observation after maintained-library factor replacement", async () => {
    const f = await fixture();
    const { jar, verified } = await login(f);
    const alreadyEnabled = await fixtureProvider.api.enableTwoFactor({
      body: { password: f.password },
      headers: new Headers({ cookie: jar.header }),
      asResponse: true,
    });
    expect(alreadyEnabled.status).toBe(400);
    // Maintained SDK requires disable then re-enroll, not overwriting a verified
    // factor. This is a NON-Owner offline fixture; no such endpoint is exposed.
    const disabled = await fixtureProvider.api.disableTwoFactor({
      body: { password: f.password },
      headers: new Headers({ cookie: jar.header }),
      asResponse: true,
    });
    expect(disabled.status).toBe(200);
    jar.absorb(disabled);
    const replaced = await fixtureProvider.api.enableTwoFactor({
      body: { password: f.password },
      headers: new Headers({ cookie: jar.header }),
      asResponse: true,
    });
    expect(replaced.status).toBe(200);
    jar.absorb(replaced);
    const setup = (await replaced.json()) as { totpURI: string };
    expect(new URL(setup.totpURI).searchParams.get("secret") === f.secret).toBe(
      false,
    );
    expect(
      await subject.assessObservation(verified.observation, jar.header),
    ).toMatchObject({
      bindingsMatch: false,
      admissionAllowed: false,
      reason: "session-mismatch",
    });
  });
  it("rejects an old observation after SDK revocation even while its object remains in memory", async () => {
    const f = await fixture();
    const { jar, verified } = await login(f);
    const retained = jar.header;
    expect((await subject.signOut(retained)).response.status).toBe(200);
    expect(
      await subject.assessObservation(verified.observation, retained),
    ).toMatchObject({
      bindingsMatch: false,
      admissionAllowed: false,
      reason: "revoked",
    });
  });
  it("returns an observation only after an independent client sees the committed session", async () => {
    const f = await fixture();
    const { verified } = await login(f);
    expect(verified.response.status).toBe(200);
    const committed = await authSql.query(
      'SELECT id,"userId" FROM identity."Session" WHERE id=$1',
      [verified.observation!.sessionId],
    );
    expect(committed.rowCount).toBe(1);
    expect(committed.rows[0].userId).toBe(f.userId);
  });
});

describe("provider persistence and cookie ordering", () => {
  it("uses the new enrollment cookie/session even though SDK JSON refers to the old token", async () => {
    const f = await fixture({ mfa: "pending" });
    const oldCookie = f.jar.header;
    const prior = await subject.resolveSession(oldCookie);
    expect(prior.state).toBe("provider-authenticated");
    const observed = await subject.verifyTotp(
      await code(f.secret!),
      f.jar.header,
    );
    expect(observed.response.status).toBe(200);
    f.jar.absorb(observed.response);
    expect(observed.diagnostics).toEqual({
      jsonTokenMatchesFinalSession: false,
      rotated: true,
    });
    expect(observed.observation!.purpose).toBe("enrollment-investigation");
    const final = await subject.resolveSession(f.jar.header);
    if (
      final.state !== "provider-authenticated" ||
      prior.state !== "provider-authenticated"
    )
      throw new Error("Synthetic rotation missing");
    expect(final.sessionId === prior.sessionId).toBe(false);
    expect((await subject.resolveSession(oldCookie)).state).toBe(
      "unauthenticated",
    );
    expect(
      (await subject.assessObservation(observed.observation, f.jar.header))
        .admissionAllowed,
    ).toBe(false);
    expect(
      (await identity.session.findUnique({
        where: { id: prior.sessionId },
      })) === null,
    ).toBe(true);
  });
  it("observes SDK enrollment ordering across multiple committed transactions", async () => {
    const f = await fixture({ mfa: "pending" });
    await migration.query(
      "CREATE TABLE public.proof_order(id bigserial PRIMARY KEY,kind text NOT NULL,tx text NOT NULL)",
    );
    await migration.query(`CREATE FUNCTION public.capture_proof_order() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
   IF TG_TABLE_NAME='User' THEN IF NEW."twoFactorEnabled" IS DISTINCT FROM OLD."twoFactorEnabled" THEN INSERT INTO public.proof_order(kind,tx) VALUES('user.enabled',pg_current_xact_id()::text); END IF;
   ELSIF TG_TABLE_NAME='Session' THEN INSERT INTO public.proof_order(kind,tx) VALUES(CASE TG_OP WHEN 'INSERT' THEN 'session.insert' ELSE 'session.delete' END,pg_current_xact_id()::text);
   ELSE IF NEW.verified IS DISTINCT FROM OLD.verified THEN INSERT INTO public.proof_order(kind,tx) VALUES('factor.verified',pg_current_xact_id()::text); END IF; END IF; RETURN NULL; END $$`);
    for (const [table, operations] of [
      ["User", "UPDATE"],
      ["Session", "INSERT OR DELETE"],
      ["TwoFactor", "UPDATE"],
    ])
      await migration.query(
        `CREATE TRIGGER capture_proof_order AFTER ${operations} ON identity."${table}" FOR EACH ROW EXECUTE FUNCTION public.capture_proof_order()`,
      );
    try {
      const operation = await subject.verifyTotp(
        await code(f.secret!),
        f.jar.header,
      );
      expect(operation.response.status).toBe(200);
      const rows = (
        await migration.query(
          "SELECT kind,tx FROM public.proof_order ORDER BY id",
        )
      ).rows;
      expect(rows.map((r) => r.kind)).toEqual([
        "user.enabled",
        "session.insert",
        "session.delete",
        "factor.verified",
      ]);
      expect(new Set(rows.map((r) => r.tx)).size).toBeGreaterThan(1);
    } finally {
      for (const table of ["User", "Session", "TwoFactor"])
        await migration.query(
          `DROP TRIGGER capture_proof_order ON identity."${table}"`,
        );
      await migration.query(
        "DROP FUNCTION public.capture_proof_order(); DROP TABLE public.proof_order",
      );
    }
  });
  it("returns no observation when challenge consumption precedes a failed session commit", async () => {
    const f = await fixture();
    const { jar, operation } = await begin(f);
    expect(
      (
        await migration.query(
          'SELECT count(*)::int AS count FROM identity."Verification" WHERE value=$1',
          [f.userId],
        )
      ).rows[0].count,
    ).toBeGreaterThan(0);
    await faultSessionInsert();
    const logged = vi.spyOn(console, "error");
    try {
      const failure = await subject.verifyTotp(
        await code(f.secret!),
        jar.header,
        operation.primary,
      );
      expect(failure.response.status).toBe(503);
      expect(failure.observation).toBeNull();
      expect(logged.mock.calls.length).toBe(0);
    } finally {
      await restoreSessionInsert();
      logged.mockRestore();
    }
    expect(
      (
        await migration.query(
          'SELECT count(*)::int AS count FROM identity."Verification" WHERE value=$1',
          [f.userId],
        )
      ).rows[0].count,
    ).toBe(0);
    const retry = await subject.verifyTotp(
      await code(f.secret!),
      jar.header,
      operation.primary,
    );
    expect(retry.response.status).toBe(401);
    expect(retry.observation).toBeNull();
  });
  it("retains partial enrollment state and durable invalidation after later persistence failure", async () => {
    const f = await fixture({ mfa: "pending" });
    await faultSessionInsert();
    const logged = vi.spyOn(console, "error");
    try {
      const failure = await subject.verifyTotp(
        await code(f.secret!),
        f.jar.header,
      );
      expect(failure.response.status).toBe(503);
      expect(failure.observation).toBeNull();
      expect(logged.mock.calls.length).toBe(0);
    } finally {
      await restoreSessionInsert();
      logged.mockRestore();
    }
    expect(
      (
        await identity.user.findUniqueOrThrow({
          where: { id: f.userId },
          select: { twoFactorEnabled: true },
        })
      ).twoFactorEnabled,
    ).toBe(true);
    expect(
      (
        await identity.twoFactor.findFirstOrThrow({
          where: { userId: f.userId },
          select: { verified: true },
        })
      ).verified,
    ).toBe(false);
    expect(
      (
        await migration.query(
          "SELECT count(*)::int AS count FROM audit.provider_events WHERE user_id=$1 AND state='pending' AND invalidates_user",
          [f.userId],
        )
      ).rows[0].count,
    ).toBeGreaterThan(0);
  });
  it("rejects changed password lineage before pending events have reconciled", async () => {
    const f = await fixture();
    const { jar, verified } = await login(f);
    const changed = await fixtureProvider.api.changePassword({
      body: {
        currentPassword: f.password,
        newPassword: randomBytes(32).toString("base64url"),
        revokeOtherSessions: false,
      },
      headers: new Headers({ cookie: jar.header }),
      asResponse: true,
    });
    expect(changed.status).toBe(200);
    jar.absorb(changed);
    expect((await subject.resolveSession(jar.header)).state).toBe(
      "provider-authenticated",
    );
    expect(
      await subject.assessObservation(verified.observation, jar.header),
    ).toMatchObject({
      bindingsMatch: false,
      admissionAllowed: false,
      reason: "factor-lineage-mismatch",
    });
  });
});

describe("private factory lifetime and late provider failures", () => {
  it("rejects cross-factory observation and primary-context references", async () => {
    const f = await fixture();
    const { jar, operation } = await begin(f);
    const originalCookie = jar.header;
    const verified = await subject.verifyTotp(
      await code(f.secret!),
      jar.header,
      operation.primary,
    );
    jar.absorb(verified.response);
    expect(verified.response.status).toBe(200);
    const second = await createUnmountedProvider({
      authUrl: owned.authUrl,
      staffUrl: owned.staffUrl,
      secret,
    });
    try {
      expect(
        await second.assessObservation(verified.observation, jar.header),
      ).toMatchObject({
        bindingsMatch: false,
        admissionAllowed: false,
        reason: "malformed",
      });
      expect(
        (
          await second.verifyTotp(
            await code(f.secret!),
            originalCookie,
            operation.primary,
          )
        ).response.status,
      ).toBe(403);
    } finally {
      await second.close();
    }
  });
  it("denies every operation after close and closes idempotently", async () => {
    const f = await fixture();
    const second = await createUnmountedProvider({
      authUrl: owned.authUrl,
      staffUrl: owned.staffUrl,
      secret,
    });
    const observed = await second.verifyTotp(
      await code(f.secret!),
      f.jar.header,
    );
    expect(observed.response.status).toBe(200);
    await second.close();
    await second.close();
    expect((await second.resolveSession(f.jar.header)).state).toBe(
      "unavailable",
    );
    expect((await second.password(f.email, f.password)).response.status).toBe(
      503,
    );
    expect(
      (await second.verifyTotp(await code(f.secret!), f.jar.header)).response
        .status,
    ).toBe(503);
    expect((await second.signOut(f.jar.header)).response.status).toBe(503);
    expect(
      await second.assessObservation(observed.observation, f.jar.header),
    ).toMatchObject({ bindingsMatch: false, admissionAllowed: false });
  });
  it("does not deliver constructed cookies or evidence after late factor-commit failure", async () => {
    const f = await fixture({ mfa: "pending" }),
      oldCookie = f.jar.header;
    const prior = await subject.resolveSession(oldCookie);
    if (prior.state !== "provider-authenticated")
      throw new Error("Synthetic prior session missing");
    await migration.query(
      "CREATE FUNCTION public.proof_factor_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic late factor commit fault' USING ERRCODE='P0001'; END $$",
    );
    await migration.query(
      'CREATE TRIGGER proof_factor_fault BEFORE UPDATE OF verified ON identity."TwoFactor" FOR EACH ROW WHEN (NEW.verified AND NOT OLD.verified) EXECUTE FUNCTION public.proof_factor_fault()',
    );
    const logged = vi.spyOn(console, "error");
    try {
      const failure = await subject.verifyTotp(
        await code(f.secret!),
        oldCookie,
      );
      expect(failure.response.status).toBe(503);
      expect(failure.observation).toBeNull();
      expect(failure.response.headers.getSetCookie().length).toBe(0);
      expect(logged.mock.calls.length).toBe(0);
    } finally {
      await migration.query(
        'DROP TRIGGER proof_factor_fault ON identity."TwoFactor"',
      );
      await migration.query("DROP FUNCTION public.proof_factor_fault()");
      logged.mockRestore();
    }
    expect(
      (
        await identity.user.findUniqueOrThrow({
          where: { id: f.userId },
          select: { twoFactorEnabled: true },
        })
      ).twoFactorEnabled,
    ).toBe(true);
    expect(
      (
        await identity.twoFactor.findFirstOrThrow({
          where: { userId: f.userId },
          select: { verified: true },
        })
      ).verified,
    ).toBe(false);
    expect(
      (await identity.session.findUnique({
        where: { id: prior.sessionId },
      })) === null,
    ).toBe(true);
    expect(await identity.session.count({ where: { userId: f.userId } })).toBe(
      1,
    );
    expect((await subject.resolveSession(oldCookie)).state).toBe(
      "unauthenticated",
    );
    expect(
      (
        await migration.query(
          "SELECT count(*)::int AS count FROM audit.provider_events WHERE user_id=$1 AND state='pending' AND invalidates_user",
          [f.userId],
        )
      ).rows[0].count,
    ).toBeGreaterThan(0);
    expect(
      (
        await migration.query(
          "SELECT count(*)::int AS count FROM staff.admissions WHERE user_id=$1",
          [f.userId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
});

describe("B.1 boundaries stay closed", () => {
  it.each([
    ["Session", "token"],
    ["Account", "password"],
    ["TwoFactor", "secret"],
  ] as const)(
    "rejects staff column-level %s credential reads at startup and checkout",
    async (table, column) => {
      const role = new URL(owned.staffUrl).username;
      if (!/^bf_[a-f0-9]{12}_staff$/.test(role))
        throw new Error("Synthetic staff role mismatch");
      await migration.query(`GRANT USAGE ON SCHEMA identity TO "${role}"`);
      await migration.query(
        `GRANT SELECT ("${column}") ON identity."${table}" TO "${role}"`,
      );
      try {
        expect((await subject.resolveSession("")).state).toBe("unavailable");
        await expect(
          createUnmountedProvider({
            authUrl: owned.authUrl,
            staffUrl: owned.staffUrl,
            secret,
          }),
        ).rejects.toThrow("purpose credentials unavailable");
      } finally {
        await migration.query(
          `REVOKE SELECT ("${column}") ON identity."${table}" FROM "${role}"`,
        );
        await migration.query(`REVOKE USAGE ON SCHEMA identity FROM "${role}"`);
      }
    },
  );
  it.each(["migrate", "reader", "worker", "staff"] as const)(
    "rejects %s credentials in the auth slot",
    async (purpose) => {
      const url =
        purpose === "migrate"
          ? owned.migrationUrl
          : purpose === "reader"
            ? owned.readerUrl
            : purpose === "worker"
              ? owned.workerUrl
              : owned.staffUrl;
      await expect(
        createUnmountedProvider({
          authUrl: url,
          staffUrl: owned.staffUrl,
          secret,
        }),
      ).rejects.toThrow("configuration rejected");
    },
  );
  it("rejects credentials from a different owned database/suffix and external/provider authority options", async () => {
    await expect(
      createUnmountedProvider({
        authUrl: owned.authUrl,
        staffUrl: owned.staffUrl.replace(
          /test_[a-f0-9]{12}/,
          "test_000000000000",
        ),
        secret,
      }),
    ).rejects.toThrow("configuration rejected");
    const supplied = {
      authUrl: owned.authUrl,
      staffUrl: owned.staffUrl,
      secret,
      offline: true,
    };
    await expect(createUnmountedProvider(supplied)).rejects.toThrow(
      "configuration rejected",
    );
  });
  it("has no auth-purpose admission, staff permission, audit mutation or DDL authority", async () => {
    for (const query of [
      "INSERT INTO staff.admissions(session_id,user_id,authz_version,mode,mfa_at) VALUES('forged','forged',0,'verified',now())",
      "INSERT INTO staff.role_grants VALUES('forged','Owner')",
      "UPDATE audit.events SET action='principal.update'",
      "CREATE TABLE identity.forged(id int)",
    ])
      await expect(authSql.query(query)).rejects.toMatchObject({
        code: "42501",
      });
  });
  it("does not mount/import an auth route or wire the closed kernel resolver", async () => {
    async function files(path: string): Promise<string[]> {
      const entries = await readdir(path, { withFileTypes: true });
      const groups = await Promise.all(
        entries.map((entry) =>
          entry.isDirectory()
            ? files(`${path}/${entry.name}`)
            : Promise.resolve([`${path}/${entry.name}`]),
        ),
      );
      return groups.flat();
    }
    for (const path of await files("src/app")) {
      if (/\.[jt]sx?$/.test(path))
        expect((await readFile(path, "utf8")).includes("provider-proof")).toBe(
          false,
        );
      expect(/\/api\/(auth|staff-auth)|\/admin\//.test(path)).toBe(false);
    }
    const kernel = createSecurityKernel(owned.staffUrl);
    try {
      expect(
        (
          await kernel.authorize("security.self.read", {
            role: "Owner",
            mfaVerified: true,
          })
        ).allowed,
      ).toBe(false);
    } finally {
      await kernel.close();
    }
    expect(
      (
        await migration.query(
          "SELECT count(*)::int AS count FROM staff.admissions",
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("pending credential reconciliation denies a previously admitted synthetic fixture", async () => {
    // Migration-only fixture state, just as B.1 tests. Never a live proof writer or real bootstrap.
    const keeper = await fixture();
    await migration.query(
      'UPDATE identity."User" SET "emailVerified"=true WHERE id=$1',
      [keeper.userId],
    );
    await drain();
    await migration.query(
      "INSERT INTO staff.role_grants(user_id,role_name) VALUES($1,'Owner')",
      [keeper.userId],
    );
    await migration.query("UPDATE staff.governance SET state='bootstrap'");
    await migration.query("UPDATE staff.governance SET state='active'");
    const f = await fixture();
    await migration.query(
      'UPDATE identity."User" SET "emailVerified"=true WHERE id=$1',
      [f.userId],
    );
    await drain();
    const resolved = await subject.resolveSession(f.jar.header);
    if (resolved.state !== "provider-authenticated")
      throw new Error("Synthetic provider session missing");
    const version = (
      await migration.query(
        "SELECT authz_version FROM staff.principals WHERE user_id=$1",
        [f.userId],
      )
    ).rows[0].authz_version;
    await migration.query(
      "INSERT INTO staff.admissions(session_id,user_id,authz_version,mode,authenticated_at,last_seen_at,mfa_at) VALUES($1,$2,$3,'verified',now(),now(),now())",
      [resolved.sessionId, f.userId, version],
    );
    await seedOfflineAdmissionControls(migration, {
      userId: f.userId,
      sessionId: resolved.sessionId,
    });
    const kernel = createSecurityKernel(owned.staffUrl, async () => {
      const current = await subject.resolveSession(f.jar.header);
      return current.state === "provider-authenticated"
        ? { userId: current.userId, sessionId: current.sessionId }
        : null;
    });
    try {
      expect((await kernel.authorize("security.self.read")).allowed).toBe(true);
      const changed = await fixtureProvider.api.changePassword({
        body: {
          currentPassword: f.password,
          newPassword: randomBytes(32).toString("base64url"),
          revokeOtherSessions: false,
        },
        headers: new Headers({ cookie: f.jar.header }),
        asResponse: true,
      });
      expect(changed.status).toBe(200);
      f.jar.absorb(changed);
      expect((await subject.resolveSession(f.jar.header)).state).toBe(
        "provider-authenticated",
      );
      expect(await kernel.authorize("security.self.read")).toMatchObject({
        allowed: false,
        reason: "stale",
      });
      await drain();
      expect((await kernel.authorize("security.self.read")).allowed).toBe(
        false,
      );
    } finally {
      await kernel.close();
      await migration.query("DELETE FROM staff.admissions WHERE user_id=$1", [
        f.userId,
      ]);
    }
  });
});
