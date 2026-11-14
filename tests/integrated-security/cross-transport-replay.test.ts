import { createHash, randomBytes } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  ControlFixtures,
  secretSafe,
  type SyntheticPrincipal,
} from "../admission-controls/fixtures";
import {
  createTransportCertificates,
  type TransportCertificateFixture,
} from "../https-transport/certificates";
import {
  WireClient,
  startWireWorker,
  transportConfig,
  allCookiesCleared,
  type WireResponse,
} from "../https-transport/client";
import {
  NextWireClient,
  nextConfig,
  startNextProcess,
  nativeAction,
  type NextProcess,
  type NextWireResponse,
} from "../next-security/client";

// ADR020 OTP composition: TWO actual independently enabled HTTPS processes,
// B.2c3443 and production-built isolated B.2d3463, SAME newly owned database and
// provider secret. Header-jar replay is NOT Chromium/SameSite/HttpOnly proof.
// Host-only cookies do NOT isolate ports. Each inbound Origin/Host is validated
// independently; neither client claims identity through a forwarded header.
const fx = new ControlFixtures();
const csrfSecret = randomBytes(48).toString("base64url");
let certs: TransportCertificateFixture;
let standalone: Awaited<ReturnType<typeof startWireWorker>> | undefined;
let next: NextProcess | undefined;
const scenario = (name: string, run: () => Promise<void>) =>
  it(name, () => secretSafe(run));
type Response = WireResponse | NextWireResponse;

async function closeChildren(): Promise<void> {
  const wireChild = standalone;
  const nextChild = next;
  standalone = undefined;
  next = undefined;
  const results = await Promise.allSettled([
    ...(wireChild ? [wireChild.close()] : []),
    ...(nextChild ? [nextChild.close()] : []),
  ]);
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Owned cross-transport child cleanup unavailable.");
}
beforeAll(() =>
  secretSafe(async () => {
    certs = await createTransportCertificates();
    await fx.start();
  }),
);
beforeEach(() =>
  secretSafe(async () => {
    // Independent scenarios only. No limiter/budget/replay reset inside a race.
    await fx.resetScenario();
    // Existing process helpers construct minimal environments with ONLY the
    // AUTH/STAFF/VERIFIER runtime config, never Migrate/bootstrap/worker URLs.
    // Sequential startup avoids adding concurrent constructor probe pressure.
    standalone = await startWireWorker(transportConfig(fx.config, certs, 3443));
    next = await startNextProcess(
      nextConfig(fx.config, certs, csrfSecret, 3463),
    );
  }),
);
afterEach(() => secretSafe(closeChildren));
afterAll(() =>
  secretSafe(async () => {
    try {
      await closeChildren();
      await fx.stop();
    } finally {
      await certs?.close();
    }
  }),
);

function safe(response: Response): boolean {
  return response.authorized && response.noStore && !response.location;
}
function minimal(response: Response, state: string): boolean {
  return (
    safe(response) &&
    response.body ===
      JSON.stringify({
        state,
        applicationAdmission: "disabled",
      })
  );
}
function scopedCookies(response: Response): boolean {
  return response.cookies.every(
    (line) =>
      /(?:^|;)\s*Secure(?:;|$)/.test(line) &&
      /(?:^|;)\s*HttpOnly(?:;|$)/.test(line) &&
      /(?:^|;)\s*SameSite=Strict(?:;|$)/.test(line) &&
      /(?:^|;)\s*Path=\/(?:;|$)/.test(line) &&
      !/(?:^|;)\s*Domain=/i.test(line),
  );
}
async function actualCode(principal: SyntheticPrincipal): Promise<string> {
  return createOTP(base32.decode(principal.secret), {
    period: 30,
    digits: 6,
  }).totp();
}
async function verifiedSession(userId: string): Promise<string> {
  const rows = await fx.migration.query<{ session_id: string }>(
    "SELECT session_id FROM staff.admissions WHERE user_id=$1 AND mode='verified'",
    [userId],
  );
  expect(rows.rows.length).toBe(1);
  return rows.rows[0].session_id;
}
async function lifetime(userId: string): Promise<string> {
  const rows = await fx.migration.query(
    `SELECT a.session_id,a.authenticated_at::text,a.last_seen_at::text,a.mfa_at::text,
      c.authenticated_at::text AS control_origin,c.absolute_deadline::text,c.epoch_id::text
     FROM staff.admissions a JOIN control_private.session_controls c USING(session_id)
     WHERE a.user_id=$1 ORDER BY a.session_id`,
    [userId],
  );
  // Private digest comparison only; IDs/timestamps never become assertion diffs.
  return createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex");
}
async function burnWitness(userId: string): Promise<string> {
  const rows = await fx.migration.query(
    `SELECT b.reserved_at::text,b.expires_at::text,encode(b.code_mac,'hex') AS code_mac
     FROM control_private.replay_burns b WHERE b.code_mac IN
       (SELECT a.code_mac FROM control_private.attempts a WHERE a.user_id=$1)
     ORDER BY b.code_mac`,
    [userId],
  );
  expect(rows.rows.length).toBe(1);
  return createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex");
}
async function proveSharedAccess(
  wire: WireClient,
  app: NextWireClient,
  cookie: string,
) {
  const standaloneSession = await wire.post(
    "session",
    {},
    { cookie, absorb: false },
  );
  const nextSession = await app.post("session", {}, { cookie, absorb: false });
  expect(
    [standaloneSession, nextSession].every(
      (response) =>
        response.status === 200 &&
        minimal(response, "verified-test-session") &&
        response.cookies.length === 0,
    ),
  ).toBe(true);
  const page = await app.page({ cookie, absorb: false });
  expect(
    safe(page) &&
      page.status === 200 &&
      page.cookies.length === 0 &&
      page.body.includes('data-live-guard="admitted-test-session"'),
  ).toBe(true);
  return page;
}

// These tests deliberately share provider roots, not Action-CSRF secrets. The
// existing facade resolves actual signed cookies/user/SID via SDK in EACH child;
// no caller-selected actor, proof, resolver, origin or IP authority is introduced.
describe("cross-transport global replay and known-context logout (Node header replay, not browser)", () => {
  scenario(
    "allows exactly one same-code finalization across standalone and Next processes sharing the protected replay store",
    async () => {
      const wire = new WireClient(certs.ca, 3443);
      const app = new NextWireClient(certs.ca, 3463);
      // Independent Host and Origin rejection; genuine CA/TLS remains required.
      const malformedPeers = [
        await wire.post("session", {}, { headers: { Origin: app.origin } }),
        await app.post("session", {}, { headers: { Origin: wire.origin } }),
        await wire.post(
          "session",
          {},
          { headers: { Host: new URL(app.origin).host } },
        ),
        await app.post(
          "session",
          {},
          { headers: { Host: new URL(wire.origin).host } },
        ),
      ];
      expect(
        malformedPeers.every(
          (response) =>
            response.status === 403 &&
            minimal(response, "denied") &&
            response.cookies.length === 0,
        ),
      ).toBe(true);
      const principal = await fx.createPrincipal();
      const first = await wire.post("password", {
        email: principal.email,
        password: principal.password,
      });
      const second = await app.post("password", {
        email: principal.email,
        password: principal.password,
      });
      expect(
        [first, second].every(
          (response) =>
            response.status === 200 &&
            minimal(response, "mfa-required") &&
            scopedCookies(response),
        ),
      ).toBe(true);
      const oldWireJar = wire.jar.header;
      const oldNextJar = app.jar.header;
      expect(
        oldWireJar.length > 0 &&
          oldNextJar.length > 0 &&
          oldWireJar !== oldNextJar,
      ).toBe(true);
      const code = await actualCode(principal);
      // Exact same real maintained code, two actual HTTP operations, one shared
      // SQL user/code reservation winner. No retry/sleep/time or budget mutation.
      const [wireResult, nextResult] = await Promise.all([
        wire.post("totp", { code }),
        app.post("totp", { code }),
      ]);
      const results = [wireResult, nextResult];
      expect(results.filter((response) => response.status === 200).length).toBe(
        1,
      );
      expect(results.filter((response) => response.status === 403).length).toBe(
        1,
      );
      const wireWon = wireResult.status === 200;
      const winner = wireWon ? wireResult : nextResult;
      const loser = wireWon ? nextResult : wireResult;
      const cookie = wireWon ? wire.jar.header : app.jar.header;
      expect(
        minimal(winner, "verified-test-session") &&
          scopedCookies(winner) &&
          winner.cookies.length > 0,
      ).toBe(true);
      expect(minimal(loser, "denied") && loser.cookies.length === 0).toBe(true);
      expect(
        wireWon
          ? app.jar.header === oldNextJar
          : wire.jar.header === oldWireJar,
      ).toBe(true);
      const sid = await verifiedSession(principal.userId);
      const state = await fx.migration.query<{ safe: boolean }>(
        `SELECT (SELECT count(*)=2 FROM control_private.attempts WHERE user_id=$1 AND purpose='login')
        AND (SELECT count(*)=1 FROM control_private.attempts WHERE user_id=$1 AND state='consumed' AND final_session_id=$2 AND operation_handle IS NOT NULL)
        AND (SELECT count(*)=1 FROM control_private.attempts WHERE user_id=$1 AND state='denied' AND operation_handle IS NULL AND evidence_handle IS NULL)
        AND (SELECT count(*)=1 FROM control_private.session_controls WHERE user_id=$1 AND session_id=$2 AND NOT revoked)
        AND (SELECT count(DISTINCT epoch_id)=1 FROM control_private.session_controls WHERE user_id=$1)
        AND (SELECT count(*)=1 FROM audit.events WHERE subject_id=$1 AND action='control.reserved')
        AND (SELECT count(*)=1 FROM audit.events WHERE subject_id=$1 AND action='control.evidence')
        AND (SELECT count(*)=1 FROM audit.events WHERE subject_id=$1 AND action='control.login')
        AND (SELECT count(*)=2 FROM control_private.budgets WHERE key_mac IN
          (control_private.mac('budget-account-mfa',$1::text),control_private.mac('budget-ip-mfa','unknown')) AND used=2)
        AND EXISTS(SELECT 1 FROM control_private.attempts a JOIN control_private.replay_burns b ON b.code_mac=a.code_mac
          WHERE a.user_id=$1 AND a.state='consumed' AND a.reserved_at=b.reserved_at
          AND b.expires_at=b.reserved_at+interval '180 seconds' AND b.expires_at>clock_timestamp()) AS safe`,
        [principal.userId, sid],
      );
      expect(state.rows.length === 1 && state.rows[0].safe).toBe(true);
      const beforeLifetime = await lifetime(principal.userId);
      const beforeBurn = await burnWitness(principal.userId);
      await proveSharedAccess(wire, app, cookie);
      expect((await lifetime(principal.userId)) === beforeLifetime).toBe(true);
      expect((await burnWitness(principal.userId)) === beforeBurn).toBe(true);
    },
  );

  scenario(
    "standalone logout of a Next-issued known cookie denies retained routes, RSC and native Actions without refunding its burn",
    async () => {
      const wire = new WireClient(certs.ca, 3443);
      const app = new NextWireClient(certs.ca, 3463);
      const principal = await fx.createPrincipal();
      const password = await app.post("password", {
        email: principal.email,
        password: principal.password,
      });
      expect(password.status === 200 && minimal(password, "mfa-required")).toBe(
        true,
      );
      const verified = await app.post("totp", {
        code: await actualCode(principal),
      });
      expect(
        verified.status === 200 && minimal(verified, "verified-test-session"),
      ).toBe(true);
      const retained = app.jar.header;
      const page = await proveSharedAccess(wire, app, retained);
      const probe = nativeAction(page.body, "probe");
      if (!probe)
        throw new Error("Cross-transport native probe reference unavailable.");
      // Confirm the actual Action protocol succeeds before revocation, not merely
      // a public Action ID/error path. No cookies/CSRF are logged or persisted.
      const positive = await app.action(probe.id, probe.csrf, {
        cookie: retained,
        absorb: false,
      });
      expect(
        safe(positive) &&
          positive.status === 200 &&
          positive.cookies.length === 0,
      ).toBe(true);
      const sid = await verifiedSession(principal.userId);
      const beforeBurn = await burnWitness(principal.userId);
      const signedOut = await wire.post("signOut", {}, { cookie: retained });
      expect(
        signedOut.status === 200 &&
          minimal(signedOut, "signed-out") &&
          allCookiesCleared(signedOut),
      ).toBe(true);
      const standaloneDenied = await wire.post(
        "session",
        {},
        { cookie: retained, absorb: false },
      );
      const nextDenied = await app.post(
        "session",
        {},
        { cookie: retained, absorb: false },
      );
      expect(
        [standaloneDenied, nextDenied].every(
          (response) =>
            response.status === 401 &&
            minimal(response, "denied") &&
            response.cookies.length === 0,
        ),
      ).toBe(true);
      const deniedPage = await app.page({ cookie: retained, absorb: false });
      expect(
        safe(deniedPage) &&
          deniedPage.status === 200 &&
          deniedPage.cookies.length === 0 &&
          deniedPage.body.includes('data-live-guard="denied-test-session"') &&
          !deniedPage.body.includes('data-live-guard="admitted-test-session"'),
      ).toBe(true);
      const native = await app.action(probe.id, probe.csrf, {
        cookie: retained,
        absorb: false,
      });
      const flight = await app.action(
        probe.id,
        probe.csrf,
        { cookie: retained, absorb: false },
        true,
      );
      // Existing Next Action denial contract throws a sanitized error (native500
      // or ingress403), never action200. These are not logical rollback claims.
      expect(
        [native, flight].every(
          (response) =>
            safe(response) &&
            [403, 500].includes(response.status) &&
            response.cookies.length === 0,
        ),
      ).toBe(true);
      const retired = await fx.migration.query<{ safe: boolean }>(
        `SELECT NOT EXISTS(SELECT 1 FROM identity."Session" WHERE id=$2 AND "userId"=$1)
        AND NOT EXISTS(SELECT 1 FROM staff.admissions WHERE session_id=$2 AND user_id=$1)
        AND EXISTS(SELECT 1 FROM control_private.session_controls WHERE session_id=$2 AND user_id=$1 AND revoked)
        AND EXISTS(SELECT 1 FROM control_private.session_observations WHERE session_id=$2 AND user_id=$1 AND retired)
        AND NOT EXISTS(SELECT 1 FROM control_private.attempts WHERE user_id=$1
          AND final_session_id=$2 AND state IN ('ready','consumed'))
        AND (SELECT count(*)=1 FROM audit.events WHERE subject_id=$1 AND action='control.login') AS safe`,
        [principal.userId, sid],
      );
      expect(retired.rows.length === 1 && retired.rows[0].safe).toBe(true);
      expect((await burnWitness(principal.userId)) === beforeBurn).toBe(true);
      // Exact presented/derived lineage only. The fixture's other setup session is
      // deliberately NOT asserted deleted: this is no all-device logout promise.
    },
  );
});
