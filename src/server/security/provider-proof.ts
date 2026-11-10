import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAdmissionAuthority } from "./admission-authority";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { twoFactor } from "better-auth/plugins";
import { toNextJsHandler } from "better-auth/next-js";
import { PrismaClient } from "../../generated/security/client";
import { assertFoundationUrl } from "./database-config";
import {
  assessProposedMfaBinding,
  type ProviderMfaObservation,
} from "./provider-proof-contract";

export const UNMOUNTED_PROVIDER_ORIGIN =
  "https://bookstore-provider-proof.invalid";
const basePath = "/api/unmounted-provider-proof";
const notAdmitted = "not-established" as const;
export type ProviderSessionResolution =
  | {
      readonly state: "provider-authenticated";
      readonly userId: string;
      readonly sessionId: string;
      readonly expiresAt: string;
      readonly staffAdmission: typeof notAdmitted;
    }
  | {
      readonly state: "unauthenticated" | "unavailable";
      readonly staffAdmission: typeof notAdmitted;
    };
export type PrimaryObservation = Readonly<{
  kind: "sdk-password-observation";
  observationId: string;
  staffAdmission: typeof notAdmitted;
}>;
/** Private credential HEADER channel for an in-memory investigation, never a public route/JSON DTO.
 * Set-Cookie is needed to investigate SDK rotation. No bearer/secret is in the body or observation.
 * B.2c must supply an independently reviewed browser transport; do not export methods as handlers.
 */
export interface UnmountedOperation {
  readonly response: Response;
  readonly primary: PrimaryObservation | null;
  readonly observation: ProviderMfaObservation | null;
  readonly diagnostics: Readonly<{
    jsonTokenMatchesFinalSession: boolean | null;
    rotated: boolean;
  }>;
}
interface Config {
  authUrl: string;
  staffUrl: string;
  secret: string;
}
interface State {
  version: number | null;
  status: string | null;
  ids: string[];
  verified: boolean;
  enabled: boolean;
  fingerprint: string;
}
interface PrimaryState {
  userId: string;
  before: State;
  cookieFingerprint: string;
  challenge: boolean;
}
const opaque = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function clock() {
  return new Date().toISOString();
}
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function staticResponse(
  status: number,
  state: string,
  cookies: readonly string[] = [],
): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "private, no-store",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({ state, staffAdmission: notAdmitted }), {
    status,
    headers,
  });
}
function result(
  response: Response,
  primary: PrimaryObservation | null = null,
  observation: ProviderMfaObservation | null = null,
  diagnostics = {
    jsonTokenMatchesFinalSession: null as boolean | null,
    rotated: false,
  },
): UnmountedOperation {
  return Object.freeze({
    response,
    primary,
    observation,
    diagnostics: Object.freeze(diagnostics),
  });
}
function bad(status = 400, state = "invalid-input") {
  return result(staticResponse(status, state));
}

interface NativeCorrelation {
  userId: string;
  authorizationVersion: number;
  factorIds: readonly string[];
  purpose: "login" | "step_up";
}
/** Private native engine. The correlation source is constructed ONLY by the
 * fixed durable factory below; it is not an SDK verifier hook or proof authority.
 * Real maintained verification and independent committed-cookie lookup remain
 * mandatory. The B.2a export has no durable correlation source or grant power.
 */
async function createProviderCore(
  config: Config,
  correlation?: () => NativeCorrelation | undefined,
) {
  let authUrl: string, staffUrl: string;
  try {
    if (
      Object.keys(config).sort().join(",") !== "authUrl,secret,staffUrl" ||
      typeof config.secret !== "string" ||
      Buffer.byteLength(config.secret) < 32 ||
      config.secret.length > 1024 ||
      /\s/.test(config.secret)
    )
      throw new Error();
    authUrl = assertFoundationUrl(config.authUrl, "auth");
    staffUrl = assertFoundationUrl(config.staffUrl, "staff");
    const a = new URL(authUrl),
      s = new URL(staffUrl);
    if (
      a.pathname !== s.pathname ||
      a.port !== s.port ||
      a.hostname !== s.hostname
    )
      throw new Error();
  } catch {
    throw new Error("Unmounted provider configuration rejected.");
  }
  const authPool = new Pool({
    connectionString: authUrl,
    options: "-c application_name=bookstore-unmounted-provider",
    max: 3,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  const staffPool = new Pool({
    connectionString: staffUrl,
    options: "-c application_name=bookstore-unmounted-provider",
    max: 2,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  authPool.on("error", () => {});
  staffPool.on("error", () => {});
  const identity = new PrismaClient({
    adapter: new PrismaPg(authPool, { disposeExternalPool: false }),
  });
  let closed = false;
  async function check(pool: Pool, url: string) {
    if (closed) throw new Error("Unavailable");
    const c = await pool.connect();
    try {
      const row = (
        await c.query(`SELECT current_user AS current_name,session_user AS session_name,current_database() AS database_name,
    r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolinherit,r.rolcanlogin,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS membership,
    has_database_privilege(current_database(),'CREATE') AS db_create,
    has_database_privilege(current_database(),'TEMP') AS db_temp,
    (has_schema_privilege('public','CREATE') OR has_schema_privilege('identity','CREATE') OR has_schema_privilege('staff','CREATE') OR has_schema_privilege('audit','CREATE')) AS schema_create,
    has_schema_privilege('staff','USAGE') AS staff_usage,
    has_schema_privilege('audit','USAGE') AS audit_usage,
    has_any_column_privilege((SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='identity' AND c.relname='Session'),'SELECT') AS session_secret_read,
    has_any_column_privilege((SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='identity' AND c.relname='Account'),'SELECT') AS password_read,
    has_any_column_privilege((SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='identity' AND c.relname='TwoFactor'),'SELECT') AS factor_secret_read,
    (current_setting('log_statement')='none' AND current_setting('log_min_error_statement')='panic'
     AND current_setting('log_parameter_max_length')='0' AND current_setting('log_parameter_max_length_on_error')='0'
     AND current_setting('log_duration')='off' AND current_setting('log_min_duration_statement')='-1'
     AND current_setting('log_min_duration_sample')='-1' AND current_setting('log_transaction_sample_rate')::numeric=0
     AND NOT EXISTS(SELECT 1 FROM pg_settings WHERE name LIKE 'pgaudit.%' OR name LIKE 'auto_explain.%')) AS logging_safe
    FROM pg_roles r WHERE r.rolname=current_user`)
      ).rows[0];
      const parsed = new URL(url);
      if (
        !row ||
        row.current_name !== parsed.username ||
        row.session_name !== parsed.username ||
        row.database_name !== parsed.pathname.slice(1) ||
        !row.rolcanlogin ||
        row.rolsuper ||
        row.rolcreatedb ||
        row.rolcreaterole ||
        row.rolbypassrls ||
        row.rolinherit ||
        row.membership ||
        row.db_create ||
        row.db_temp ||
        row.schema_create ||
        !row.logging_safe ||
        (url === authUrl && (row.staff_usage || row.audit_usage)) ||
        (url === staffUrl &&
          (row.session_secret_read ||
            row.password_read ||
            row.factor_secret_read))
      )
        throw new Error("Unavailable");
    } finally {
      c.release();
    }
  }
  async function checkProfiles() {
    await Promise.all([check(authPool, authUrl), check(staffPool, staffUrl)]);
  }
  const provider = betterAuth({
    appName: "BookStore unmounted provider-proof investigation",
    baseURL: UNMOUNTED_PROVIDER_ORIGIN,
    basePath,
    secret: config.secret,
    trustedOrigins: [UNMOUNTED_PROVIDER_ORIGIN],
    database: prismaAdapter(identity, {
      provider: "postgresql",
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 15,
      maxPasswordLength: 128,
    },
    account: { accountLinking: { enabled: false } },
    session: {
      expiresIn: 8 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: "database" },
    disabledPaths: [
      "/sign-up/email",
      "/sign-in/social",
      "/sign-in/magic-link",
      "/sign-in/email-otp",
      "/sign-in/anonymous",
      "/link-social",
      "/change-email",
      "/update-user",
      "/delete-user",
      "/two-factor/disable",
      "/two-factor/send-otp",
      "/two-factor/verify-backup-code",
      "/request-password-reset",
      "/reset-password",
    ],
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: [] },
      useSecureCookies: true,
      cookiePrefix: "bookstore-provider-proof",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
      },
    },
    plugins: [
      twoFactor({
        issuer: "BookStore synthetic proof investigation",
        skipVerificationOnEnable: false,
        trustDeviceMaxAge: 0,
        totpOptions: { period: 30, digits: 6 },
        backupCodeOptions: { storeBackupCodes: "encrypted" },
        accountLockout: {
          enabled: true,
          maxFailedAttempts: 10,
          durationSeconds: 900,
        },
      }),
    ],
    telemetry: { enabled: false },
    logger: { disabled: true },
    // Better Call's fallback can console.error raw errors even with this logger
    // disabled. Re-throw to our fixed private sanitizer, never a raw SDK log/DTO.
    onAPIError: { throw: true },
  });
  const handlers = toNextJsHandler(provider);
  let allowedNames: Set<string>;
  try {
    await checkProfiles();
    const context = await provider.$context;
    allowedNames = new Set([
      ...Object.values(context.authCookies).map((cookie) => cookie.name),
      context.createAuthCookie("two_factor").name,
    ]);
  } catch {
    await Promise.allSettled([
      identity.$disconnect(),
      authPool.end(),
      staffPool.end(),
    ]);
    throw new Error("Unmounted provider purpose credentials unavailable.");
  }
  const primaryStates = new WeakMap<PrimaryObservation, PrimaryState>();
  const observed = new WeakMap<
    ProviderMfaObservation,
    { fingerprint: string; lineageStable: boolean }
  >();
  function cookies(value: unknown): Map<string, string> | null {
    if (
      typeof value !== "string" ||
      value.length > 16384 ||
      [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      return null;
    const jar = new Map<string, string>();
    const seen = new Set<string>();
    if (!value) return jar;
    for (const part of value.split(";")) {
      const split = part.indexOf("=");
      if (split < 1) return null;
      const name = part.slice(0, split).trim(),
        token = part.slice(split + 1).trim();
      if (
        !/^[A-Za-z0-9_.-]+$/.test(name) ||
        seen.has(name) ||
        !token ||
        /\s/.test(token)
      )
        return null;
      try {
        decodeURIComponent(token);
      } catch {
        return null;
      }
      seen.add(name);
      if (allowedNames.has(name)) jar.set(name, token);
    }
    return jar;
  }
  const header = (jar: Map<string, string>) =>
    [...jar]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  function setCookies(response: Response): string[] {
    return response.headers.getSetCookie().map((entry) => {
      const first = entry.split(";", 1)[0],
        split = first.indexOf("=");
      if (
        split < 1 ||
        !allowedNames.has(first.slice(0, split)) ||
        /[\r\n]/.test(entry) ||
        /;\s*domain=/i.test(entry) ||
        !/;\s*secure(?:;|$)/i.test(entry) ||
        !/;\s*httponly(?:;|$)/i.test(entry)
      )
        throw new Error("Unavailable");
      return entry;
    });
  }
  function effective(
    jar: Map<string, string>,
    updates: readonly string[],
  ): Map<string, string> {
    const copy = new Map(jar);
    for (const entry of updates) {
      const first = entry.split(";", 1)[0],
        split = first.indexOf("="),
        name = first.slice(0, split),
        token = first.slice(split + 1);
      if (!token || /;\s*max-age=0(?:;|$)/i.test(entry)) copy.delete(name);
      else copy.set(name, token);
    }
    return copy;
  }
  async function rawSession(jar: Map<string, string>) {
    const session = await provider.api.getSession({
      headers: new Headers({ cookie: header(jar) }),
      query: { disableCookieCache: true },
    });
    if (!session) return null;
    if (
      !opaque(session.user.id) ||
      !opaque(session.session.id) ||
      session.session.userId !== session.user.id ||
      !(session.session.expiresAt instanceof Date) ||
      session.session.expiresAt.getTime() <= Date.now()
    )
      return null;
    // Independent SQL visibility check, outside the SDK adapter's transaction
    // context. A successful callback/DTO without committed current token ownership
    // is not accepted. Token appears only in a bound predicate, never a DTO/log.
    const committed = await authPool.query<{ id: string }>(
      'SELECT id FROM identity."Session" WHERE id=$1 AND "userId"=$2 AND token=$3 AND "expiresAt">$4',
      [session.session.id, session.user.id, session.session.token, new Date()],
    );
    return committed.rowCount === 1 ? session : null;
  }
  async function state(userId: string): Promise<State> {
    const [principal, factors, accounts, user] = await Promise.all([
      staffPool.query<{ authz_version: number; status: string }>(
        "SELECT authz_version,status FROM staff.principals WHERE user_id=$1",
        [userId],
      ),
      identity.twoFactor.findMany({
        where: { userId },
        orderBy: { id: "asc" },
        select: { id: true, verified: true, secret: true, backupCodes: true },
      }),
      identity.account.findMany({
        where: { userId, providerId: "credential" },
        orderBy: { id: "asc" },
        select: { id: true, password: true },
      }),
      identity.user.findUnique({
        where: { id: userId },
        select: { twoFactorEnabled: true },
      }),
    ]);
    // Private transient change detector only. No secret/hash/fingerprint leaves this closure.
    const fingerprint = digest(
      JSON.stringify({
        factors,
        accounts,
        enabled: user?.twoFactorEnabled ?? false,
      }),
    );
    return {
      version: principal.rows[0]?.authz_version ?? null,
      status: principal.rows[0]?.status ?? null,
      ids: factors.map((f) => f.id),
      verified: factors.some((f) => f.verified),
      enabled: user?.twoFactorEnabled ?? false,
      fingerprint,
    };
  }
  async function call(
    path: "/sign-in/email" | "/two-factor/verify-totp" | "/sign-out",
    body: Record<string, unknown>,
    jar: Map<string, string>,
  ) {
    // Fixed native operation, fixed logical origin, no caller headers/URL/provider hooks. No listener.
    const req = new Request(`${UNMOUNTED_PROVIDER_ORIGIN}${basePath}${path}`, {
      method: "POST",
      headers: {
        origin: UNMOUNTED_PROVIDER_ORIGIN,
        "content-type": "application/json",
        cookie: header(jar),
      },
      body: JSON.stringify(body),
    });
    const response = await handlers.POST(req);
    const data: unknown = await response.json().catch(() => null);
    const value =
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : {};
    return { response, value, updates: setCookies(response) };
  }
  async function resolveSession(
    cookieHeader: unknown,
  ): Promise<ProviderSessionResolution> {
    const jar = cookies(cookieHeader);
    if (!jar) return { state: "unauthenticated", staffAdmission: notAdmitted };
    try {
      await checkProfiles();
      const session = await rawSession(jar);
      if (!session)
        return { state: "unauthenticated", staffAdmission: notAdmitted };
      return Object.freeze({
        state: "provider-authenticated",
        userId: session.user.id,
        sessionId: session.session.id,
        expiresAt: session.session.expiresAt.toISOString(),
        staffAdmission: notAdmitted,
      });
    } catch {
      return { state: "unavailable", staffAdmission: notAdmitted };
    }
  }
  const api = Object.freeze({
    resolveSession,
    async password(
      email: unknown,
      password: unknown,
      cookieHeader: unknown = "",
    ): Promise<UnmountedOperation> {
      const jar = cookies(cookieHeader);
      if (
        !jar ||
        typeof email !== "string" ||
        !/^[^\s@]+@[^\s@]+\.invalid$/i.test(email) ||
        email.length > 254 ||
        typeof password !== "string" ||
        password.length < 15 ||
        password.length > 128
      )
        return bad();
      try {
        await checkProfiles();
        const normalized = email.toLowerCase();
        const user = await identity.user.findUnique({
          where: { email: normalized },
          select: { id: true },
        });
        const before = user ? await state(user.id) : null;
        const native = await call(
          "/sign-in/email",
          { email: normalized, password },
          jar,
        );
        if (!native.response.ok || !user || !before)
          return result(
            staticResponse(
              native.response.status >= 500 ? 503 : native.response.status,
              "provider-denied",
              native.updates,
            ),
          );
        const challenge = native.value.twoFactorRedirect === true;
        const context: PrimaryObservation = Object.freeze({
          kind: "sdk-password-observation",
          observationId: randomUUID(),
          staffAdmission: notAdmitted,
        });
        primaryStates.set(context, {
          userId: user.id,
          before,
          cookieFingerprint: digest(header(effective(jar, native.updates))),
          challenge,
        });
        return result(
          staticResponse(
            200,
            challenge ? "totp-required" : "password-authenticated",
            native.updates,
          ),
          context,
        );
      } catch {
        return bad(503, "provider-unavailable");
      }
    },
    async verifyTotp(
      code: unknown,
      cookieHeader: unknown,
      primaryContext?: unknown,
    ): Promise<UnmountedOperation> {
      const jar = cookies(cookieHeader);
      if (!jar || typeof code !== "string" || !/^[0-9]{6}$/.test(code))
        return bad();
      let primary =
        typeof primaryContext === "object" && primaryContext !== null
          ? primaryStates.get(primaryContext as PrimaryObservation)
          : undefined;
      if (primaryContext !== undefined && !primary)
        return bad(403, "context-denied");
      if (primary && digest(header(jar)) !== primary.cookieFingerprint)
        return bad(403, "context-denied");
      try {
        await checkProfiles();
        // B.2b correlation is a private, one-call ALS value loaded from protected
        // DB state BEFORE the durable claim. It neither certifies MFA nor skips
        // native verification. Default B.2a callers cannot supply this source.
        const restored =
          !primary && primaryContext === undefined
            ? correlation?.()
            : undefined;
        if (restored) {
          if (
            !opaque(restored.userId) ||
            !Number.isSafeInteger(restored.authorizationVersion) ||
            restored.authorizationVersion < 0 ||
            !restored.factorIds.every(opaque)
          )
            return bad(403, "context-denied");
          const current = await state(restored.userId);
          primary = {
            userId: restored.userId,
            before: {
              ...current,
              version: restored.authorizationVersion,
              ids: [...restored.factorIds],
            },
            cookieFingerprint: digest(header(jar)),
            challenge: restored.purpose === "login",
          };
        }
        const prior = await rawSession(jar);
        if (!primary && !prior) return bad(401, "provider-denied");
        const userId = primary?.userId ?? prior!.user.id;
        if (prior && prior.user.id !== userId)
          return bad(403, "context-denied");
        const before = primary?.before ?? (await state(userId));
        const purpose: ProviderMfaObservation["purpose"] =
          prior && (!before.enabled || !before.verified)
            ? "enrollment-investigation"
            : primary?.challenge && !prior
              ? "login-investigation"
              : "active-session-investigation";
        const started = clock();
        const native = await call(
          "/two-factor/verify-totp",
          { code, trustDevice: false },
          jar,
        );
        if (!native.response.ok)
          return result(
            staticResponse(
              native.response.status >= 500 ? 503 : native.response.status,
              "provider-denied",
              native.updates,
            ),
          );
        const finalSession = await rawSession(effective(jar, native.updates));
        const returnedUser = native.value.user;
        if (
          !finalSession ||
          finalSession.user.id !== userId ||
          typeof returnedUser !== "object" ||
          returnedUser === null ||
          !("id" in returnedUser) ||
          returnedUser.id !== userId
        )
          return bad(503, "verification-boundary-unavailable");
        const after = await state(userId);
        const observation: ProviderMfaObservation = Object.freeze({
          kind: "sdk-totp-observation",
          observationId: randomUUID(),
          userId,
          sessionId: finalSession.session.id,
          purpose,
          operationStartedAt: started,
          operationCompletedAt: clock(),
          authorizationVersionBefore: before.version,
          authorizationVersionAfter: after.version,
          priorSessionId: prior?.session.id ?? null,
          factorIdsBefore: Object.freeze([...before.ids]),
          factorIdsAfter: Object.freeze([...after.ids]),
          staffAdmission: notAdmitted,
          durable: false,
        });
        observed.set(observation, {
          fingerprint: after.fingerprint,
          lineageStable: before.fingerprint === after.fingerprint,
        });
        return result(
          staticResponse(200, "sdk-totp-observed-not-admitted", native.updates),
          null,
          observation,
          {
            jsonTokenMatchesFinalSession:
              typeof native.value.token === "string"
                ? native.value.token === finalSession.session.token
                : null,
            rotated: !!prior && prior.session.id !== finalSession.session.id,
          },
        );
      } catch {
        return bad(503, "provider-unavailable");
      }
    },
    async assessObservation(observation: unknown, cookieHeader: unknown) {
      const denied = (
        reason:
          | "malformed"
          | "identity-mismatch"
          | "session-mismatch"
          | "version-mismatch"
          | "factor-lineage-mismatch"
          | "revoked",
      ) =>
        Object.freeze({
          bindingsMatch: false,
          admissionAllowed: false as const,
          reason,
        });
      if (
        typeof observation !== "object" ||
        observation === null ||
        !observed.has(observation as ProviderMfaObservation)
      )
        return denied("malformed");
      const accepted = observation as ProviderMfaObservation,
        jar = cookies(cookieHeader);
      if (!jar) return denied("malformed");
      try {
        await checkProfiles();
        const session = await rawSession(jar);
        if (!session) return denied("revoked");
        if (session.user.id !== accepted.userId)
          return denied("identity-mismatch");
        if (session.session.id !== accepted.sessionId)
          return denied("session-mismatch");
        const current = await state(session.user.id);
        const original = observed.get(accepted)!;
        if (
          current.fingerprint !== original.fingerprint ||
          (!original.lineageStable &&
            accepted.purpose !== "enrollment-investigation")
        )
          return denied("factor-lineage-mismatch");
        const admission = await staffPool.query<{ mode: string }>(
          "SELECT mode FROM staff.admissions WHERE session_id=$1 AND user_id=$2",
          [session.session.id, session.user.id],
        );
        if (current.version === null) return denied("version-mismatch");
        return assessProposedMfaBinding(accepted, {
          userId: session.user.id,
          sessionId: session.session.id,
          authorizationVersion: current.version,
          purpose: accepted.purpose,
          factorIds: current.ids,
          revoked:
            current.status !== "active" ||
            admission.rows[0]?.mode === "revoked",
        });
      } catch {
        return denied("malformed");
      }
    },
    async signOut(cookieHeader: unknown): Promise<UnmountedOperation> {
      const jar = cookies(cookieHeader);
      if (!jar) return bad();
      try {
        await checkProfiles();
        const native = await call("/sign-out", {}, jar);
        return result(
          staticResponse(
            native.response.status >= 500 ? 503 : native.response.status,
            native.response.ok ? "provider-signed-out" : "provider-denied",
            native.updates,
          ),
        );
      } catch {
        return bad(503, "provider-unavailable");
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const done = await Promise.allSettled([
        identity.$disconnect(),
        authPool.end(),
        staffPool.end(),
      ]);
      if (done.some((entry) => entry.status === "rejected"))
        throw new Error("Unmounted provider close failed.");
    },
  });
  return {
    api,
    canonicalCookie(value: unknown): string | null {
      const jar = cookies(value);
      return jar ? header(jar) : null;
    },
    effectiveCookie(value: unknown, response: Response): string | null {
      const jar = cookies(value);
      return jar
        ? header(effective(jar, response.headers.getSetCookie()))
        : null;
    },
  };
}
/** Accepted B.2a surface remains non-authorizing and has no durable authority. */
export async function createUnmountedProvider(config: Config) {
  return (await createProviderCore(config)).api;
}
export type UnmountedProvider = Awaited<
  ReturnType<typeof createUnmountedProvider>
>;

/** SERVER-ONLY completion capability; never a public JSON/token DTO. */
export interface DormantControlOperation {
  readonly response: Response;
  readonly evidenceHandle: string | null;
}
function controlOperation(
  allowed: boolean,
  reason: string,
  state: string,
  updates: readonly string[] = [],
  evidenceHandle: string | null = null,
): DormantControlOperation {
  const status = allowed
    ? 200
    : reason === "rate_limited"
      ? 429
      : reason === "unavailable"
        ? 503
        : reason === "unauthenticated"
          ? 401
          : 403;
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "private, no-store",
  });
  for (const update of updates) headers.append("set-cookie", update);
  return Object.freeze({
    response: new Response(
      JSON.stringify({
        allowed,
        reason,
        state,
        applicationAdmission: "disabled",
      }),
      { status, headers },
    ),
    evidenceHandle,
  });
}

/** B.2b dormant composition ONLY. No application, HTTP or default-kernel wiring.
 * The verifier credential is an explicit trusted positive issuer, not a claim
 * that PostgreSQL independently ran the SDK. This closure alone owns both real
 * native calls and durable issuance. No observation/claims/callback input mints
 * evidence. DB state, one-shot burns, approvals and deadlines are authoritative.
 */
export async function createDormantAdmissionControls(
  config: Config & { verifierUrl: string },
) {
  try {
    if (
      Object.keys(config).sort().join(",") !==
      "authUrl,secret,staffUrl,verifierUrl"
    )
      throw new Error();
    const a = new URL(assertFoundationUrl(config.authUrl, "auth"));
    const s = new URL(assertFoundationUrl(config.staffUrl, "staff"));
    const v = new URL(assertFoundationUrl(config.verifierUrl, "verifier"));
    if (
      [s, v].some(
        (u) =>
          u.hostname !== a.hostname ||
          u.port !== a.port ||
          u.pathname !== a.pathname,
      )
    )
      throw new Error();
    if (
      typeof config.secret !== "string" ||
      Buffer.byteLength(config.secret) < 32 ||
      config.secret.length > 1024 ||
      /\s/.test(config.secret)
    )
      throw new Error();
  } catch {
    throw new Error("Invalid dormant provider configuration.");
  }
  const authority = await createAdmissionAuthority({
    verifierUrl: config.verifierUrl,
    staffUrl: config.staffUrl,
  });
  const slot = new AsyncLocalStorage<NativeCorrelation>();
  let core: Awaited<ReturnType<typeof createProviderCore>>;
  try {
    core = await createProviderCore(
      {
        authUrl: config.authUrl,
        staffUrl: config.staffUrl,
        secret: config.secret,
      },
      () => slot.getStore(),
    );
  } catch {
    await authority.close();
    throw new Error("Dormant native provider unavailable.");
  }
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const unavailable = () =>
    controlOperation(false, "unavailable", "dormant-denied");
  const denied = (reason: string) =>
    controlOperation(false, reason, "dormant-denied");
  type Context = {
    challengeHandle: string;
    userId: string;
    authorizationVersion: number;
    factorIds: readonly string[];
    purpose: "login" | "step_up";
  };
  function context(
    value: Awaited<ReturnType<typeof authority.resumePrimary>>,
  ): Context | null {
    if (
      !value.allowed ||
      !value.challengeHandle ||
      !value.userId ||
      value.authorizationVersion === undefined ||
      !value.factorIds ||
      !value.purpose
    )
      return null;
    return {
      challengeHandle: value.challengeHandle,
      userId: value.userId,
      authorizationVersion: value.authorizationVersion,
      factorIds: value.factorIds,
      purpose: value.purpose,
    };
  }
  async function verifyReserved(
    ctx: Context,
    code: unknown,
    cookie: string,
  ): Promise<DormantControlOperation> {
    if (closed || typeof code !== "string" || !/^[0-9]{6}$/.test(code))
      return denied("forbidden");
    // This independently commits challenge CAS, account/IP charge and global
    // user/code burn BEFORE native verification. No SDK timeout/rollback unburns it.
    const reserved = await authority.reserveMfa(
      ctx.challengeHandle,
      cookie,
      code,
    );
    if (!reserved.allowed || !reserved.operationHandle || !reserved.deadline)
      return denied(reserved.reason);
    if (Date.now() >= Date.parse(reserved.deadline)) return denied("expired");
    const begun = performance.now();
    const native = await slot.run(ctx, () => core.api.verifyTotp(code, cookie));
    if (
      !native.response.ok ||
      !native.observation ||
      native.observation.purpose === "enrollment-investigation" ||
      native.observation.userId !== ctx.userId
    )
      return denied(
        native.response.status >= 500 ? "unavailable" : "forbidden",
      );
    if (performance.now() - begun > 30000) return denied("expired");
    const finalCookie = core.effectiveCookie(cookie, native.response);
    if (!finalCookie) return unavailable();
    const actual = await core.api.resolveSession(finalCookie);
    if (
      actual.state !== "provider-authenticated" ||
      actual.userId !== ctx.userId ||
      actual.sessionId !== native.observation.sessionId
    )
      return denied("stale");
    // NOT an assessment of WeakMap/metadata! This is the private result of our
    // immediately awaited native operation. SQL independently enforces its
    // reserved operation, original pin/version, final binding and hard deadline.
    const ready = await authority.issueEvidence(
      reserved.operationHandle,
      actual.sessionId,
      finalCookie,
    );
    if (!ready.allowed || !ready.evidenceHandle) return denied(ready.reason);
    return controlOperation(
      true,
      "allowed",
      "dormant-evidence-ready",
      native.response.headers.getSetCookie(),
      ready.evidenceHandle,
    );
  }
  return Object.freeze({
    async password(
      email: unknown,
      password: unknown,
    ): Promise<DormantControlOperation> {
      if (closed) return unavailable();
      const prepared = await authority.preparePassword(email);
      if (!prepared.allowed || !prepared.challengeHandle)
        return denied(prepared.reason);
      const native = await core.api.password(email, password);
      if (!native.response.ok || !native.primary)
        return denied(
          native.response.status >= 500 ? "unavailable" : "forbidden",
        );
      const state: unknown = await native.response.clone().json();
      if (
        !state ||
        typeof state !== "object" ||
        !("state" in state) ||
        state.state !== "totp-required"
      )
        return denied("forbidden");
      const cookie = core.effectiveCookie("", native.response);
      if (!cookie) return unavailable();
      const bound = await authority.bindPrimary(
        prepared.challengeHandle,
        cookie,
      );
      if (!bound.allowed) return denied(bound.reason);
      return controlOperation(
        true,
        "allowed",
        "dormant-primary-bound",
        native.response.headers.getSetCookie(),
      );
    },
    async verifyTotp(
      code: unknown,
      cookieHeader: unknown,
    ): Promise<DormantControlOperation> {
      if (closed) return unavailable();
      const cookie = core.canonicalCookie(cookieHeader);
      if (!cookie) return denied("unauthenticated");
      const original = await authority.resumePrimary(cookie);
      const ctx = context(original);
      return ctx ? verifyReserved(ctx, code, cookie) : denied(original.reason);
    },
    async stepUp(
      code: unknown,
      cookieHeader: unknown,
    ): Promise<DormantControlOperation> {
      if (closed) return unavailable();
      const cookie = core.canonicalCookie(cookieHeader);
      if (!cookie) return denied("unauthenticated");
      const actual = await core.api.resolveSession(cookie);
      if (actual.state !== "provider-authenticated")
        return denied(
          actual.state === "unavailable" ? "unavailable" : "unauthenticated",
        );
      const prepared = await authority.prepareStepUp(
        actual.userId,
        actual.sessionId,
        cookie,
      );
      const ctx = context(prepared);
      return ctx ? verifyReserved(ctx, code, cookie) : denied(prepared.reason);
    },
    async finalize(
      evidenceHandle: unknown,
      cookieHeader: unknown,
    ): Promise<DormantControlOperation> {
      if (closed) return unavailable();
      const cookie = core.canonicalCookie(cookieHeader);
      if (!cookie) return denied("unauthenticated");
      const actual = await core.api.resolveSession(cookie);
      if (actual.state !== "provider-authenticated")
        return denied(
          actual.state === "unavailable" ? "unavailable" : "unauthenticated",
        );
      const decision = await authority.finalize(
        evidenceHandle,
        actual.sessionId,
        cookie,
      );
      return controlOperation(
        decision.allowed,
        decision.reason,
        decision.allowed ? "dormant-finalized" : "dormant-denied",
      );
    },
    async check(cookieHeader: unknown) {
      const cookie = core.canonicalCookie(cookieHeader);
      if (closed || !cookie)
        return Object.freeze({ allowed: false, reason: "unavailable" });
      const actual = await core.api.resolveSession(cookie);
      if (actual.state !== "provider-authenticated")
        return Object.freeze({
          allowed: false,
          reason:
            actual.state === "unavailable" ? "unavailable" : "unauthenticated",
        });
      return authority.checkAccess(actual.userId, actual.sessionId);
    },
    async touch(cookieHeader: unknown) {
      if (closed) return unavailable();
      const actual = await core.api.resolveSession(cookieHeader);
      if (actual.state !== "provider-authenticated")
        return denied("unauthenticated");
      const live = await authority.checkAccess(actual.userId, actual.sessionId);
      if (!live.allowed || live.authorizationVersion === undefined)
        return denied(live.reason);
      const decision = await authority.touch(
        actual.userId,
        actual.sessionId,
        live.authorizationVersion,
      );
      return controlOperation(
        decision.allowed,
        decision.reason,
        "dormant-touch",
      );
    },
    async revoke(cookieHeader: unknown, targetSession?: unknown) {
      if (closed) return unavailable();
      const actual = await core.api.resolveSession(cookieHeader);
      if (actual.state !== "provider-authenticated")
        return denied("unauthenticated");
      const live = await authority.checkAccess(actual.userId, actual.sessionId);
      if (!live.allowed || live.authorizationVersion === undefined)
        return denied(live.reason);
      const decision = await authority.revoke(
        actual.userId,
        actual.sessionId,
        live.authorizationVersion,
        targetSession ?? actual.sessionId,
      );
      return controlOperation(
        decision.allowed,
        decision.reason,
        "dormant-revoke",
      );
    },
    async close() {
      if (!closePromise) {
        closed = true;
        closePromise = (async () => {
          const results = await Promise.allSettled([
            core.api.close(),
            authority.close(),
          ]);
          if (results.some((entry) => entry.status === "rejected"))
            throw new Error("Dormant controls close failed.");
        })();
      }
      return closePromise;
    },
  });
}
export type DormantAdmissionControls = Awaited<
  ReturnType<typeof createDormantAdmissionControls>
>;
