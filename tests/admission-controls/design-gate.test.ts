import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { twoFactor } from "better-auth/plugins";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/security/client";
import { runSecurityMigrations } from "../../scripts/security-database";
import {
  createFoundationDatabase,
  type FoundationDatabase,
} from "../security-foundation/database";

// Feasibility ONLY. This file installs no application migration, verifier,
// admission writer, receipt or proof. All DDL below is disposable fixture DDL.
let owned: FoundationDatabase | undefined;
let migration: Client;
let identity: PrismaClient | undefined;
const clients = new Set<Client>();
let cryptoSchema: '"gate_crypto"' | '"control_crypto"';

async function connect(url: string) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  clients.add(client);
  await client.connect();
  return client;
}

// SQL/SDK faults must not print bound secrets, connection strings or provider
// records. Assertions below expose only statuses, counts and safe booleans.
let setupStage = "initial";
async function sanitized<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // All assertions in this file compare safe booleans/statuses/counts only.
    if (error instanceof Error && error.name === "AssertionError") throw error;
    const states = new Set<string>();
    function codes(value: unknown, depth = 0) {
      if (depth > 5) return;
      if (
        value &&
        typeof value === "object" &&
        "code" in value &&
        typeof value.code === "string" &&
        /^[A-Z0-9]{5}$/.test(value.code)
      )
        states.add(value.code);
      if (value instanceof Error) {
        const match = /SQLSTATE ([A-Z0-9]{5})/.exec(value.message);
        if (match) states.add(match[1]);
      }
      if (value instanceof AggregateError)
        for (const child of value.errors.slice(0, 8)) codes(child, depth + 1);
    }
    codes(error);
    throw new Error(
      `Admission design feasibility operation failed at ${setupStage}${states.size ? ` (SQLSTATE ${[...states].join(",")})` : ""}; details suppressed.`,
    );
  }
}

beforeAll(async () => {
  await sanitized(async () => {
    setupStage = "database_create";
    owned = await createFoundationDatabase();
    setupStage = "canonical_deploy";
    await runSecurityMigrations(owned.migrationUrl);
    setupStage = "privilege_hardening";
    await owned.hardenPrivileges();
    setupStage = "migration_connect";
    migration = await connect(owned.migrationUrl);
    setupStage = "prisma_constructor";
    identity = new PrismaClient({
      adapter: new PrismaPg({ connectionString: owned.authUrl, max: 3 }),
    });
    setupStage = "test_operation";
  });
});

afterAll(async () => {
  vi.useRealTimers();
  const results = await Promise.allSettled([
    ...[...clients].map((client) => client.end()),
    ...(identity ? [identity.$disconnect()] : []),
  ]);
  // Never FORCE/drop with connected clients, even when a close failed.
  if (results.some((result) => result.status === "rejected"))
    throw new Error(
      "Feasibility client cleanup failed; no forced disposal attempted.",
    );
  await owned?.dispose();
});

function frame(user: string, code: string): Buffer {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(user) || !/^[0-9]{6}$/.test(code))
    throw new Error("Invalid synthetic replay input.");
  // Fixed domain + NUL delimiters; neither input alphabet includes NUL.
  // Only framing, NOT custom cryptography or TOTP calculation.
  return Buffer.from(`bookstore-b2b-gate-v1\0${user}\0${code}`, "utf8");
}

const frameSql =
  "convert_to('bookstore-b2b-gate-v1','UTF8') || decode('00','hex') || convert_to($1::text,'UTF8') || decode('00','hex') || convert_to($2::text,'UTF8')";

describe("unmounted B2b pre-migration feasibility (not proof/admission)", () => {
  it("discovers trusted pgcrypto and its actual extension/function ownership", async () => {
    await sanitized(async () => {
      const available = await migration.query<{
        trusted: boolean;
        superuser: boolean;
      }>(
        "SELECT trusted, superuser FROM pg_available_extension_versions WHERE name='pgcrypto' AND version=(SELECT default_version FROM pg_available_extensions WHERE name='pgcrypto')",
      );
      expect(available.rowCount).toBe(1);
      expect(available.rows[0].trusted).toBe(true);
      const extension = await migration.query<{ namespace: string }>(
        "SELECT n.nspname AS namespace FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'",
      );
      if (!extension.rowCount) {
        await migration.query("CREATE SCHEMA gate_crypto");
        await migration.query("REVOKE ALL ON SCHEMA gate_crypto FROM PUBLIC");
        // Trusted extension install AS MIGRATE, not bootstrap. Its functions may
        // nevertheless be bootstrap-superuser-owned: do NOT assume ALTER/REVOKE
        // authority over them or silently open a bootstrap connection here.
        await migration.query(
          "CREATE EXTENSION pgcrypto WITH SCHEMA gate_crypto",
        );
      }
      const installed = await migration.query<{
        namespace: string;
        extension_owned_by_migrate: boolean;
      }>(
        "SELECT n.nspname AS namespace, e.extowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS extension_owned_by_migrate FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'",
      );
      expect(installed.rowCount).toBe(1);
      const namespace = installed.rows[0].namespace;
      expect(["gate_crypto", "control_crypto"].includes(namespace)).toBe(true);
      if (namespace !== "gate_crypto" && namespace !== "control_crypto")
        throw new Error("Unexpected crypto namespace.");
      cryptoSchema =
        namespace === "gate_crypto" ? '"gate_crypto"' : '"control_crypto"';
      if (namespace === "gate_crypto")
        expect(installed.rows[0].extension_owned_by_migrate).toBe(true);
      const functions = await migration.query<{
        name: string;
        owner_superuser: boolean;
        owned_by_migrate: boolean;
        definer: boolean;
        extension_member: boolean;
      }>(
        `SELECT p.proname AS name, r.rolsuper AS owner_superuser,
          r.rolname=current_user AS owned_by_migrate, p.prosecdef AS definer,
          EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
            WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid
              AND d.refclassid='pg_extension'::regclass AND d.deptype='e'
              AND e.extname='pgcrypto') AS extension_member
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         JOIN pg_roles r ON r.oid=p.proowner
         WHERE n.nspname=$1 AND p.oid IN
          (to_regprocedure($2),to_regprocedure($3))`,
        [
          namespace,
          `${cryptoSchema}.hmac(bytea,bytea,text)`,
          `${cryptoSchema}.gen_random_bytes(integer)`,
        ],
      );
      expect(functions.rowCount).toBe(2);
      for (const fn of functions.rows) {
        expect(fn.extension_member).toBe(true);
        expect(fn.definer).toBe(false);
        // Record actual ownership as safe booleans; a later offline admin
        // hardener must handle superuser-owned functions, not the migrator.
        expect(fn.owner_superuser || fn.owned_by_migrate).toBe(true);
        if (namespace === "gate_crypto") {
          expect(fn.owner_superuser).toBe(true);
          expect(fn.owned_by_migrate).toBe(false);
        }
      }
      for (const url of [owned!.authUrl, owned!.staffUrl, owned!.workerUrl]) {
        const role = new URL(url).username;
        const access = await migration.query<{ allowed: boolean }>(
          "SELECT has_schema_privilege($1,$2,'USAGE') AS allowed",
          [role, namespace],
        );
        expect(access.rows[0].allowed).toBe(false);
      }
      const generated = await migration.query<{ correct_length: boolean }>(
        `SELECT octet_length(${cryptoSchema}.gen_random_bytes(32))=32 AS correct_length`,
      );
      expect(generated.rows[0].correct_length).toBe(true);
    });
  });

  it("matches RFC4231 SHA256 test case 1 and fixed PG/Node framing", async () => {
    await sanitized(async () => {
      // Published RFC4231 section 4.2; these are public vector values, not keys
      // used by any runtime. Replay fixture key exists only in test memory.
      const vector = await migration.query<{ digest: Buffer }>(
        `SELECT ${cryptoSchema}.hmac($1::bytea,$2::bytea,'sha256') AS digest`,
        [Buffer.from("Hi There"), Buffer.alloc(20, 0x0b)],
      );
      expect(
        vector.rows[0].digest.toString("hex") ===
          "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
      ).toBe(true);
      const key = randomBytes(32);
      const user = randomUUID();
      const code = "012345";
      const framed = await migration.query<{ digest: Buffer }>(
        `SELECT ${cryptoSchema}.hmac(${frameSql},$3::bytea,'sha256') AS digest`,
        [user, code, key],
      );
      const expected = createHmac("sha256", key)
        .update(frame(user, code))
        .digest();
      expect(framed.rows[0].digest.equals(expected)).toBe(true);
      expect(frame("ab", "012345").equals(frame("a", "012345"))).toBe(false);
    });
  });

  it("has one winner across four independent connections and denies after reopen", async () => {
    await sanitized(async () => {
      // TEST ONLY public table and migrate clients. This is unique-claim
      // feasibility, NOT least-privilege authority or a production replay gate.
      await migration.query(`CREATE TABLE public.gate_replay_claim (
        user_id text NOT NULL, fingerprint bytea NOT NULL,
        reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(user_id,fingerprint))`);
      await migration.query(
        "REVOKE ALL ON public.gate_replay_claim FROM PUBLIC",
      );
      const key = randomBytes(32);
      const user = randomUUID();
      const code = "012345";
      const claim = async (client: Client) => {
        const result = await client.query(
          `INSERT INTO public.gate_replay_claim(user_id,fingerprint)
           VALUES($1,${cryptoSchema}.hmac(${frameSql},$3::bytea,'sha256'))
           ON CONFLICT DO NOTHING RETURNING 1`,
          [user, code, key],
        );
        return result.rowCount === 1;
      };
      const contenders = await Promise.all(
        Array.from({ length: 4 }, () => connect(owned!.migrationUrl)),
      );
      const outcomes = await Promise.all(contenders.map(claim));
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      for (const client of contenders) {
        await client.end();
        clients.delete(client);
      }
      const reopened = await connect(owned!.migrationUrl);
      expect(await claim(reopened)).toBe(false);
      // Connection reopen is deliberately NOT a true process-restart test.
      const stored = await migration.query<{
        count: number;
        digest_only: boolean;
      }>(
        "SELECT count(*)::integer AS count, bool_and(octet_length(fingerprint)=32) AS digest_only FROM public.gate_replay_claim",
      );
      expect(stored.rows[0]).toEqual({ count: 1, digest_only: true });
    });
  });

  it("uses actual SDK P30/digits6 verification for previous/current/next, rejecting outside", async () => {
    // Private offline fixture API: no mounted transport, no claimed HTTP/CSRF
    // acceptance, no staff principal/grant/admission. Generic SDK success alone
    // is NOT application proof. Fake Date only: DB/network timers remain real.
    await sanitized(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const fixedNow = Math.floor(Date.now() / 30000) * 30000 + 15000;
      vi.setSystemTime(fixedNow);
      try {
        const provider = betterAuth({
          appName: "B2b offline SDK feasibility",
          baseURL: "https://bookstore-design-gate.invalid",
          secret: randomBytes(48).toString("base64url"),
          database: prismaAdapter(identity!, {
            provider: "postgresql",
            transaction: true,
          }),
          emailAndPassword: {
            enabled: true,
            minPasswordLength: 15,
            maxPasswordLength: 128,
          },
          session: {
            disableSessionRefresh: true,
            cookieCache: { enabled: false },
          },
          advanced: {
            disableOriginCheck: false,
            disableCSRFCheck: false,
            useSecureCookies: true,
            cookiePrefix: "bookstore-design-gate",
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
        const jar = new Map<string, string>();
        const absorb = (response: Response) => {
          for (const entry of response.headers.getSetCookie()) {
            const first = entry.split(";", 1)[0];
            const split = first.indexOf("=");
            const name = first.slice(0, split),
              value = first.slice(split + 1);
            if (!value || /max-age=0(?:;|$)/i.test(entry)) jar.delete(name);
            else jar.set(name, value);
          }
        };
        const headers = () =>
          new Headers({
            cookie: [...jar]
              .map(([name, value]) => `${name}=${value}`)
              .join("; "),
          });
        const password = randomBytes(32).toString("base64url");
        const signed = await provider.api.signUpEmail({
          body: {
            email: `${randomUUID()}@example.invalid`,
            name: "Synthetic gate fixture",
            password,
          },
          asResponse: true,
        });
        expect(signed.status).toBe(200);
        absorb(signed);
        const enabled = await provider.api.enableTwoFactor({
          headers: headers(),
          body: { password },
          asResponse: true,
        });
        expect(enabled.status).toBe(200);
        absorb(enabled);
        const setup = (await enabled.json()) as { totpURI: string };
        const material = new URL(setup.totpURI).searchParams.get("secret");
        if (!material) throw new Error("Synthetic factor unavailable.");
        const codes = new Map<number, string>();
        for (const offset of [-2, -1, 0, 1, 2]) {
          vi.setSystemTime(fixedNow + offset * 30000);
          codes.set(
            offset,
            await createOTP(base32.decode(material), {
              period: 30,
              digits: 6,
            }).totp(),
          );
        }
        vi.setSystemTime(fixedNow);
        // Rare six-digit collisions must fail visibly, never retry/skip a case.
        expect(new Set(codes.values()).size === codes.size).toBe(true);
        for (const offset of [0, -1, 1, -2, 2]) {
          const response = await provider.api.verifyTOTP({
            headers: headers(),
            body: { code: codes.get(offset)!, trustDevice: false },
            asResponse: true,
          });
          expect(response.status).toBe(Math.abs(offset) <= 1 ? 200 : 401);
          if (response.ok) absorb(response);
        }
        const admissions = await migration.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM staff.admissions",
        );
        expect(admissions.rows[0].count).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
