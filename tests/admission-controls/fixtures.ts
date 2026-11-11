import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { twoFactor } from "better-auth/plugins";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { vi } from "vitest";
import { PrismaClient } from "../../src/generated/security/client";
import { runSecurityMigrations } from "../../scripts/security-database";
import {
  assertFoundationBaseUrl,
  assertFoundationUrl,
} from "../../src/server/security/database-config";
import {
  createFoundationDatabase,
  type FoundationDatabase,
} from "../security-foundation/database";
import {
  createDormantAdmissionControls,
  type DormantAdmissionControls,
} from "../../src/server/security/provider-proof";
import { pinOfflineGeneration } from "./offline-fixture";

class FixtureStageError extends Error {}
async function stage<T>(phase: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FixtureStageError) throw error;
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    const aliases: Record<string, string> = {
      metadataUnavailable: "authority-metadata",
      "invalid dormant authority configuration": "authority-config",
      "Dormant native provider unavailable.": "native-constructor",
      "Unmounted provider purpose credentials unavailable.": "native-purpose",
    };
    const alias = error instanceof Error ? aliases[error.message] : undefined;
    throw new FixtureStageError(
      `Synthetic fixture phase ${phase}${/^[A-Z0-9]{5}$/.test(code) ? ` SQLSTATE ${code}` : ""}${alias ? ` (${alias})` : ""}; details suppressed.`,
    );
  }
}

/** Every dynamic credential stays in memory/private headers, never assertion text. */
export async function secretSafe<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof FixtureStageError ||
      (error instanceof Error && error.name === "AssertionError")
    )
      throw error;
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    throw new Error(
      `Synthetic admission scenario unavailable${/^[A-Z0-9]{5}$/.test(code) ? ` (${code})` : ""}; details suppressed.`,
    );
  }
}

export class HeaderJar {
  private values = new Map<string, string>();
  get header(): string {
    return [...this.values].map(([key, value]) => `${key}=${value}`).join("; ");
  }
  get canonical(): string {
    return [...this.values]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
  absorb(response: Response): void {
    for (const entry of response.headers.getSetCookie()) {
      const first = entry.split(";", 1)[0],
        split = first.indexOf("=");
      if (split < 1) throw new Error("Invalid private fixture cookie.");
      const name = first.slice(0, split),
        value = first.slice(split + 1);
      if (!value || /max-age=0(?:;|$)/i.test(entry)) this.values.delete(name);
      else this.values.set(name, value);
    }
  }
  clone(): HeaderJar {
    const copy = new HeaderJar();
    copy.values = new Map(this.values);
    return copy;
  }
}

export interface SyntheticPrincipal {
  userId: string;
  email: string;
  password: string;
  secret: string;
  setupJar: HeaderJar;
  generationId: string;
}

export class ControlFixtures {
  owned!: FoundationDatabase;
  migration!: Client;
  auth!: Client;
  worker!: Client;
  staff!: Client;
  verifier!: Client;
  identity!: PrismaClient;
  subject!: DormantAdmissionControls;
  readonly secret = randomBytes(48).toString("base64url");
  private clients = new Set<Client>();
  private subjects = new Set<DormantAdmissionControls>();
  private fixtureProvider!: ReturnType<typeof this.buildOfflineProvider>;
  get config() {
    return {
      authUrl: this.owned.authUrl,
      staffUrl: this.owned.staffUrl,
      verifierUrl: this.owned.verifierUrl,
      secret: this.secret,
    };
  }
  async client(url: string): Promise<Client> {
    const client = new Client({
      connectionString: url,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    this.clients.add(client);
    await client.connect();
    return client;
  }
  async release(client: Client): Promise<void> {
    await client.end();
    this.clients.delete(client);
  }
  async newSubject(): Promise<DormantAdmissionControls> {
    const subject = await stage("subject-authority-constructor", () =>
      createDormantAdmissionControls(this.config),
    );
    this.subjects.add(subject);
    return subject;
  }
  async closeSubject(subject: DormantAdmissionControls): Promise<void> {
    await subject.close();
    this.subjects.delete(subject);
  }
  /** One fixed OFFLINE owned-bootstrap regression, not a reusable admin client.
   * Never calls SDK password/TOTP while the injected AUTH defaults are unsafe.
   */
  async checkDatabaseScopedAuthLoggingRegression(): Promise<
    Readonly<{
      rejected: boolean;
      defaultsRestored: boolean;
      reopened: boolean;
    }>
  > {
    const base = assertFoundationBaseUrl(
      process.env.SECURITY_TEST_DATABASE_URL ?? "",
    );
    const suffix = /^bookstore_security_test_([a-f0-9]{12})$/.exec(
      this.owned.name,
    )?.[1];
    if (!suffix) throw new Error("Owned regression database is invalid.");
    const auth = new URL(assertFoundationUrl(this.owned.authUrl, "auth"));
    const migration = new URL(
      assertFoundationUrl(this.owned.migrationUrl, "migrate"),
    );
    if (
      auth.pathname !== `/${this.owned.name}` ||
      auth.username !== `bf_${suffix}_auth` ||
      migration.username !== `bf_${suffix}_migrate`
    )
      throw new Error("Owned regression role binding is invalid.");
    const target = new URL(base);
    if (target.hostname !== auth.hostname || target.port !== auth.port)
      throw new Error("Owned regression server binding is invalid.");
    target.pathname = `/${this.owned.name}`;
    const admin = new Client({
      connectionString: target.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      options:
        "-c application_name=bookstore-controls-offline-regression -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 -c log_duration=off -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 -c log_transaction_sample_rate=0",
    });
    this.clients.add(admin);
    await admin.connect();
    let verified = false,
      altered = false,
      rejected = false,
      defaultsRestored = false,
      reopened = false;
    try {
      const marker = await admin.query<{ safe: boolean }>(
        `SELECT
        current_database()=$1 AND current_user='bookstore_security_bootstrap'
        AND (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
        AND pg_get_userbyid(d.datdba)=$3
        AND shobj_description(d.oid,'pg_database') ~ $4
        AND shobj_description(a.oid,'pg_authid')=shobj_description(d.oid,'pg_database')
        AND shobj_description(m.oid,'pg_authid')=shobj_description(d.oid,'pg_database') AS safe
        FROM pg_database d JOIN pg_roles a ON a.rolname=$2 JOIN pg_roles m ON m.rolname=$3
        WHERE d.datname=$1`,
        [
          this.owned.name,
          auth.username,
          migration.username,
          `^bookstore-security-foundation:${suffix}:[a-f0-9]{32}$`,
        ],
      );
      if (marker.rowCount !== 1 || marker.rows[0].safe !== true)
        throw new Error("Owned regression marker verification failed.");
      verified = true;
      // Identifiers derive ONLY from verified canonical run-owned bindings.
      const role = `"${auth.username}"`,
        database = `"${this.owned.name}"`;
      altered = true;
      await admin.query(
        `ALTER ROLE ${role} IN DATABASE ${database} SET log_statement='all'`,
      );
      await admin.query(
        `ALTER ROLE ${role} IN DATABASE ${database} SET log_parameter_max_length='-1'`,
      );
      let unsafe: DormantAdmissionControls | undefined;
      try {
        unsafe = await createDormantAdmissionControls(this.config);
      } catch {
        rejected = true;
      } finally {
        await unsafe?.close();
      }
      // Only the non-secret constructor metadata path was exercised. Hardening
      // must remove stronger ROLE-IN-DATABASE overrides, not just set ROLE GUCs.
      await this.owned.hardenPrivileges();
      const defaults = await admin.query<{ safe: boolean }>(
        `SELECT NOT EXISTS(
        SELECT 1 FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) item(value)
        WHERE s.setrole=(SELECT oid FROM pg_roles WHERE rolname=$1)
          AND s.setdatabase=(SELECT oid FROM pg_database WHERE datname=$2)
          AND (split_part(item.value,'=',1)='log_statement' AND split_part(item.value,'=',2)<>'none'
            OR split_part(item.value,'=',1)='log_parameter_max_length' AND split_part(item.value,'=',2)<>'0')) AS safe`,
        [auth.username, this.owned.name],
      );
      defaultsRestored = defaults.rows[0].safe === true;
      const safeSubject = await this.newSubject();
      reopened = true;
      await this.closeSubject(safeSubject);
      return Object.freeze({ rejected, defaultsRestored, reopened });
    } finally {
      if (verified && altered) {
        // Bounded safety restoration even when the hardener/constructor asserts.
        // No other role/database defaults or objects are changed here.
        await admin.query(
          `ALTER ROLE "${auth.username}" IN DATABASE "${this.owned.name}" RESET log_statement`,
        );
        await admin.query(
          `ALTER ROLE "${auth.username}" IN DATABASE "${this.owned.name}" RESET log_parameter_max_length`,
        );
      }
      await this.release(admin);
    }
  }
  async start(): Promise<void> {
    this.owned = await stage("owned-provision", () =>
      createFoundationDatabase(),
    );
    await stage("canonical-migrate", () =>
      runSecurityMigrations(this.owned.migrationUrl),
    );
    await stage("owned-hardener", () => this.owned.hardenPrivileges());
    this.migration = await this.client(this.owned.migrationUrl);
    this.auth = await this.client(this.owned.authUrl);
    this.worker = await this.client(this.owned.workerUrl);
    this.staff = await this.client(this.owned.staffUrl);
    this.verifier = await this.client(this.owned.verifierUrl);
    this.identity = new PrismaClient({
      adapter: new PrismaPg({ connectionString: this.owned.authUrl, max: 3 }),
    });
    this.fixtureProvider = this.buildOfflineProvider();
    this.subject = await this.newSubject();
    const migrations = await this.migration.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    );
    if (migrations.rows[0]?.count !== 6)
      throw new Error("Expected exactly six canonical migrations.");
    await stage("governance-bootstrap", () =>
      this.migration.query(
        "UPDATE staff.governance SET state='bootstrap' WHERE singleton",
      ),
    );
    await stage("keeper-offline-sdk-and-pin", () =>
      this.createPrincipal("Owner"),
    );
    await stage("governance-active", () =>
      this.migration.query(
        "UPDATE staff.governance SET state='active' WHERE singleton",
      ),
    );
  }
  private buildOfflineProvider() {
    // Isolated OFFLINE synthetic setup, never an HTTP handler or application
    // import. Only this setup instance disables rate limiting. Subject does not.
    return betterAuth({
      appName: "Synthetic dormant admission fixtures",
      baseURL: "https://bookstore-provider-proof.invalid",
      basePath: "/api/unmounted-provider-proof",
      secret: this.secret,
      database: prismaAdapter(this.identity, {
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
        disableOriginCheck: false,
        disableCSRFCheck: false,
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
          skipVerificationOnEnable: false,
          trustDeviceMaxAge: 0,
          totpOptions: { period: 30, digits: 6 },
          backupCodeOptions: { storeBackupCodes: "encrypted" },
        }),
      ],
      telemetry: { enabled: false },
      logger: { disabled: true },
      onAPIError: { throw: true },
    });
  }
  async drain(): Promise<void> {
    for (let round = 0; round < 30; round++) {
      const batch = await this.worker.query<{ id: string }>(
        "SELECT * FROM audit.pending_provider_events(100)",
      );
      if (!batch.rowCount) return;
      for (const row of batch.rows)
        await this.worker.query("SELECT audit.reconcile_provider_event($1)", [
          row.id,
        ]);
    }
    throw new Error("Synthetic ledger drain exceeded its fixed bound.");
  }
  async resetScenario(): Promise<void> {
    // Independent scenario boundary ONLY; never inside a budget/race scenario.
    await this.drain();
    await this.migration.query('DELETE FROM identity."RateLimit"');
    await this.migration.query("DELETE FROM control_private.budgets");
  }
  async createPrincipal(
    role: "Owner" | "Analyst" = "Analyst",
  ): Promise<SyntheticPrincipal> {
    const email = `${randomUUID()}@example.invalid`,
      password = randomBytes(32).toString("base64url");
    const setupJar = new HeaderJar();
    const signed = await stage("offline-sdk-signup", async () => {
      const response = await this.fixtureProvider.api.signUpEmail({
        body: { email, password, name: "Synthetic controls fixture" },
        asResponse: true,
      });
      if (!response.ok) throw new Error("Synthetic maintained signup failed.");
      return response;
    });
    setupJar.absorb(signed);
    const signedBody = (await signed.json()) as { user: { id: string } };
    const userId = signedBody.user.id;
    const enabled = await stage("offline-sdk-enroll", async () => {
      const response = await this.fixtureProvider.api.enableTwoFactor({
        body: { password },
        headers: new Headers({ cookie: setupJar.header }),
        asResponse: true,
      });
      if (!response.ok)
        throw new Error("Synthetic maintained enrollment failed.");
      return response;
    });
    setupJar.absorb(enabled);
    const setup = (await enabled.json()) as { totpURI: string };
    const secret = new URL(setup.totpURI).searchParams.get("secret");
    if (!secret)
      throw new Error("Synthetic authenticator material unavailable.");
    const confirmed = await stage("offline-sdk-confirm", async () => {
      const response = await this.fixtureProvider.api.verifyTOTP({
        body: {
          code: await createOTP(base32.decode(secret), {
            period: 30,
            digits: 6,
          }).totp(),
          trustDevice: false,
        },
        headers: new Headers({ cookie: setupJar.header }),
        asResponse: true,
      });
      if (!response.ok)
        throw new Error("Synthetic maintained confirmation failed.");
      return response;
    });
    setupJar.absorb(confirmed);
    await stage("offline-email-verification", () =>
      this.migration.query(
        'UPDATE identity."User" SET "emailVerified"=true WHERE id=$1',
        [userId],
      ),
    );
    await stage("offline-ledger-drain", () => this.drain());
    await stage("offline-principal", () =>
      this.migration.query(
        "INSERT INTO staff.principals(user_id,status) VALUES($1,'active')",
        [userId],
      ),
    );
    await stage("offline-role", () =>
      this.migration.query(
        "INSERT INTO staff.role_grants(user_id,role_name) VALUES($1,$2)",
        [userId, role],
      ),
    );
    const generationId = await stage("offline-generation-pin", () =>
      pinOfflineGeneration(this.migration, userId),
    );
    return { userId, email, password, secret, setupJar, generationId };
  }
  async code(
    principal: SyntheticPrincipal,
    offset: -1 | 0 | 1 = 0,
  ): Promise<string> {
    // Generation ONLY uses the maintained OTP library with a temporary Date.now
    // spy. Restore BEFORE any sampled-clock/native verification flow starts.
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + offset * 30000);
    try {
      return await createOTP(base32.decode(principal.secret), {
        period: 30,
        digits: 6,
      }).totp();
    } finally {
      spy.mockRestore();
    }
  }
  async begin(principal: SyntheticPrincipal, subject = this.subject) {
    const jar = new HeaderJar();
    const operation = await subject.password(
      principal.email,
      principal.password,
    );
    jar.absorb(operation.response);
    return { jar, operation };
  }
  async ready(
    principal: SyntheticPrincipal,
    subject = this.subject,
    suppliedCode?: string,
  ) {
    const { jar, operation: primary } = await this.begin(principal, subject);
    if (!primary.response.ok)
      throw new Error("Synthetic primary preparation failed.");
    const code = suppliedCode ?? (await this.code(principal));
    const operation = await subject.verifyTotp(code, jar.header);
    jar.absorb(operation.response);
    if (!operation.response.ok || !operation.evidenceHandle)
      throw new Error("Synthetic real SDK ready path failed.");
    const row = await this.migration.query<{ final_session_id: string }>(
      "SELECT final_session_id FROM control_private.attempts WHERE evidence_handle=$1",
      [operation.evidenceHandle],
    );
    if (row.rowCount !== 1) throw new Error("Synthetic ready binding missing.");
    return { jar, operation, sessionId: row.rows[0].final_session_id, code };
  }
  async admitted(principal: SyntheticPrincipal, suppliedCode?: string) {
    const ready = await this.ready(principal, this.subject, suppliedCode);
    const finalized = await this.subject.finalize(
      ready.operation.evidenceHandle,
      ready.jar.header,
    );
    if (!finalized.response.ok)
      throw new Error("Synthetic dormant finalization failed.");
    return { ...ready, finalized };
  }
  async stop(): Promise<void> {
    vi.restoreAllMocks();
    const settled = await Promise.allSettled([
      ...[...this.subjects].map((subject) => subject.close()),
      ...[...this.clients].map((client) => client.end()),
      ...(this.identity ? [this.identity.$disconnect()] : []),
    ]);
    if (settled.some((result) => result.status === "rejected"))
      throw new Error(
        "Owned controls cleanup failed; no forced disposal attempted.",
      );
    await this.owned?.dispose();
  }
}

export async function restartProbe(
  mode: "verify-rejected" | "complete-allowed" | "finalize-allowed",
  config: ControlFixtures["config"],
  input: { cookie: string; code?: string; evidenceHandle?: string },
): Promise<number | null> {
  // Minimal OS execution environment: no migration/bootstrap/test URL inheritance.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "test" };
  for (const name of [
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
    if (process.env[name] !== undefined) env[name] = process.env[name];
  env.BOOKSTORE_CONTROL_RESTART = JSON.stringify({ mode, config, ...input });
  env.TSX_DISABLE_CACHE = "1";
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        fileURLToPath(new URL("./restart-worker.ts", import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.once("error", () =>
      reject(new Error("Synthetic restart child unavailable.")),
    );
    child.once("exit", (code) => resolve(code));
  });
}
