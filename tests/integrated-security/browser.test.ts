import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Client } from "pg";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { computeCacheBustingSearchParam } from "next/dist/shared/lib/router/utils/cache-busting-search-param";
import { prepareFlightRouterStateForRequest } from "next/dist/client/flight-data-helpers";
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
  NEXT_AUTH_PATHS,
  NEXT_HOST,
  SECURITY_PAGE,
} from "../../experiments/next-security/wire";
import {
  ControlFixtures,
  secretSafe,
  type SyntheticPrincipal,
} from "../admission-controls/fixtures";
import {
  createTransportCertificates,
  prepareLinuxBrowserTrust,
  type TransportCertificateFixture,
} from "../https-transport/certificates";
import {
  nextConfig,
  startNextProcess,
  type NextProcess,
} from "../next-security/client";
import {
  createWorkerProcess,
  type WorkerProcess,
} from "../next-security/worker-client";

// NEW actual browser evidence. Not an API jar, Node TLS substitute, recovery
// ceremony, operational identity or claim that both race delivery orders occur.
if (process.platform !== "linux")
  throw new Error(
    "B2e browser acceptance requires actual Linux isolated NSS trust.",
  );
const fx = new ControlFixtures();
const origin = `https://${NEXT_HOST}:3463`;
const prefix = "__Secure-bookstore-provider-proof.";
const challengeName = `${prefix}two_factor`;
const sessionName = `${prefix}session_token`;
const csrfSecret = randomBytes(48).toString("base64url");
const workers = new Set<WorkerProcess>();
let certs: TransportCertificateFixture;
let host: NextProcess | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
const scenario = (name: string, work: () => Promise<void>) =>
  it(name, () => secretSafe(work));
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function currentPage(): Page {
  if (!page) throw new Error("Owned integrated browser page unavailable.");
  return page;
}
function currentContext(): BrowserContext {
  if (!context)
    throw new Error("Owned integrated browser context unavailable.");
  return context;
}
async function ownedCookies() {
  return (await currentContext().cookies()).filter((cookie) =>
    cookie.name.startsWith(prefix),
  );
}
async function cookieStamp() {
  return digest(await ownedCookies());
}
async function assertCookieFlags(expectedName: string) {
  const cookies = await ownedCookies();
  expect(
    cookies.length === 1 &&
      cookies.every(
        (cookie) =>
          cookie.name === expectedName &&
          cookie.secure &&
          cookie.httpOnly &&
          cookie.sameSite === "Strict" &&
          cookie.path === "/" &&
          cookie.domain === NEXT_HOST,
      ),
  ).toBe(true);
  expect(await currentPage().evaluate(() => document.cookie === "")).toBe(true);
}
async function post(
  route: keyof typeof NEXT_AUTH_PATHS,
  body: Record<string, string> = {},
) {
  return currentPage().evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "X-Bookstore-CSRF": "1",
        },
        body: JSON.stringify(body),
      });
      let minimal = false;
      let state: string | null = null;
      try {
        const value = await response.json();
        const known = [
          "denied",
          "unavailable",
          "rate-limited",
          "mfa-required",
          "verified-test-session",
          "signed-out",
          "revoked",
        ];
        state = known.includes(value.state) ? value.state : null;
        minimal =
          Object.keys(value).sort().join(",") ===
            "applicationAdmission,state" &&
          value.applicationAdmission === "disabled" &&
          state !== null;
      } catch {
        /* Only fixed flags cross the browser boundary, never raw content. */
      }
      return {
        status: response.status,
        state,
        minimal,
        noStore: response.headers.get("cache-control") === "private, no-store",
        noLocation: !response.headers.has("location"),
        cookieHidden: response.headers.get("set-cookie") === null,
      };
    },
    { path: NEXT_AUTH_PATHS[route], body },
  );
}
function safeRoute(value: Awaited<ReturnType<typeof post>>) {
  return (
    value.minimal && value.noStore && value.noLocation && value.cookieHidden
  );
}
async function admitted() {
  return (
    (await currentPage()
      .locator('[data-live-guard="admitted-test-session"]')
      .count()) === 1
  );
}
async function freshGetDenied() {
  const response = await currentPage().goto(`${origin}${SECURITY_PAGE}`, {
    waitUntil: "domcontentloaded",
  });
  expect(
    response?.request().method() === "GET" &&
      response.status() === 200 &&
      response.headers()["cache-control"] === "private, no-store" &&
      !(await admitted()) &&
      (await currentPage()
        .locator('[data-live-guard="denied-test-session"]')
        .count()) === 1,
  ).toBe(true);
}
async function begin(principal: SyntheticPrincipal) {
  const value = await post("password", {
    email: principal.email,
    password: principal.password,
  });
  expect(
    value.status === 200 && value.state === "mfa-required" && safeRoute(value),
  ).toBe(true);
  await assertCookieFlags(challengeName);
}
async function login(principal: SyntheticPrincipal) {
  await begin(principal);
  const code = await fx.code(principal);
  const value = await post("totp", { code });
  expect(
    value.status === 200 &&
      value.state === "verified-test-session" &&
      safeRoute(value),
  ).toBe(true);
  await assertCookieFlags(sessionName);
  const response = await currentPage().goto(`${origin}${SECURITY_PAGE}`, {
    waitUntil: "domcontentloaded",
  });
  expect(
    response?.request().method() === "GET" &&
      response.status() === 200 &&
      (await admitted()),
  ).toBe(true);
  await currentPage().locator('[data-hydrated="ready"]').waitFor();
  // SAME full-RSC transport and strict model-prop parser as the later denial
  // assertions. A denied ingress/invalid wire or tree-only shell cannot pass as
  // a successful guard witness. This runs BEFORE offline state mutations.
  await rscGuardWithoutNavigation("admitted");
  return code;
}
async function heldNativeProbe() {
  return currentPage().evaluate(async (path) => {
    const form = document.querySelector('form[data-native="probe"]');
    if (!(form instanceof HTMLFormElement))
      return {
        present: false,
        status: 0,
        noStore: false,
        noLocation: false,
        cookieHidden: false,
      };
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      redirect: "manual",
      body: new FormData(form),
    });
    await response.text();
    return {
      present: true,
      status: response.status,
      noStore: response.headers.get("cache-control") === "private, no-store",
      noLocation: !response.headers.has("location"),
      cookieHidden: response.headers.get("set-cookie") === null,
    };
  }, SECURITY_PAGE);
}
async function heldFlightProbeDenied() {
  const target = currentPage();
  await target.locator('[data-hydrated="ready"]').waitFor();
  const observed = target.waitForResponse(
    (response) =>
      response.url() === `${origin}${SECURITY_PAGE}` &&
      response.request().method() === "POST" &&
      !!response.request().headers()["next-action"],
  );
  await target.locator('[data-enhanced="probe"]').click();
  const response = await observed;
  await response.finished();
  const headers = await response.request().allHeaders();
  let physical = false;
  let root = false;
  try {
    const tree: unknown = JSON.parse(
      decodeURIComponent(headers["next-router-state-tree"] ?? ""),
    );
    physical = JSON.stringify(tree).includes("%5F_bookstore_next_security");
    root = Array.isArray(tree) && tree[4] === 16;
  } catch {
    /* Return only the fixed protocol decision below. */
  }
  expect(
    [403, 500].includes(response.status()) &&
      response.headers()["cache-control"] === "private, no-store" &&
      !response.headers().location &&
      (await response.headerValue("set-cookie")) === null &&
      headers.origin === origin &&
      physical &&
      root,
  ).toBe(true);
}
async function rscGuardWithoutNavigation(expected: "admitted" | "denied") {
  // Pinned Next live RSC client sends RSC + a maintained serialized router tree,
  // NOT Next-Router-Prefetch. A prefetch without loading.tsx can be tree-only
  // (walk-tree-with-flight-router-state86–103), with no rendered guard at all.
  const tree = prepareFlightRouterStateForRequest([
    "",
    {
      children: ["%5F_bookstore_next_security", { children: ["__PAGE__", {}] }],
    },
    null,
    "refetch",
    16,
  ]);
  const cacheBusting = await computeCacheBustingSearchParam(
    undefined,
    undefined,
    tree,
    undefined,
  );
  // With all four cache-key header inputs absent the hash is empty; omitting it
  // redirects in base-server1467–1481, while empty _rsc fails our raw grammar.
  // The exact accepted physical refetch tree above yields a matching nonempty
  // hash without weakening either Next validation or the outer ingress policy.
  expect(/^[A-Za-z0-9_-]{1,64}$/.test(cacheBusting)).toBe(true);
  const wire = currentPage()
    .waitForResponse(
      (response) =>
        response.url() === `${origin}${SECURITY_PAGE}?_rsc=${cacheBusting}` &&
        response.request().method() === "GET" &&
        response.request().headers()["next-router-state-tree"] === tree,
    )
    .then(async (response) => ({
      noSetCookie: (await response.headerValue("set-cookie")) === null,
      noLocation: (await response.headerValue("location")) === null,
    }))
    .catch(() => null);
  const value = await currentPage().evaluate(
    async ({ path, cacheBusting, tree }) => {
      const response = await fetch(`${path}?_rsc=${cacheBusting}`, {
        headers: { RSC: "1", "Next-Router-State-Tree": tree },
        credentials: "same-origin",
        redirect: "manual",
      });
      const text = await response.text();
      let admittedGuards = 0;
      let deniedGuards = 0;
      let invalidGuard = false;
      let validModels = true;
      // Pinned React Flight default model rows are <hex-id>:<JSON> followed by
      // newline. Inspect ONLY parsed model props, not HTML or arbitrary token
      // presence. Module/hint/text/error tagged rows are not model objects.
      // This is a non-authentication projection assertion, never a Flight/MFA
      // decoder or issuer; raw content stays private inside this browser call.
      for (const row of text.split("\n")) {
        const colon = row.indexOf(":");
        if (colon < 1 || !/^[a-f0-9]+$/.test(row.slice(0, colon))) continue;
        const payload = row.slice(colon + 1);
        if (!payload.startsWith("{") && !payload.startsWith("[")) continue;
        let model: unknown;
        try {
          model = JSON.parse(payload);
        } catch {
          validModels = false;
          continue;
        }
        const pending: unknown[] = [model];
        while (pending.length) {
          const item = pending.pop();
          if (!item || typeof item !== "object") continue;
          if (Array.isArray(item)) {
            pending.push(...item);
          } else {
            const props = item as Record<string, unknown>;
            if (
              Object.prototype.hasOwnProperty.call(props, "data-live-guard")
            ) {
              if (props["data-live-guard"] === "admitted-test-session")
                admittedGuards++;
              else if (props["data-live-guard"] === "denied-test-session")
                deniedGuards++;
              else invalidGuard = true;
            }
            pending.push(...Object.values(props));
          }
        }
      }
      const projection =
        invalidGuard || !validModels
          ? "invalid"
          : admittedGuards === 1 && deniedGuards === 0
            ? "admitted"
            : deniedGuards === 1 && admittedGuards === 0
              ? "denied"
              : admittedGuards > 0 && deniedGuards > 0
                ? "mixed"
                : "missing";
      return {
        status: response.status,
        component:
          response.headers.get("content-type")?.split(";", 1)[0].trim() ===
          "text/x-component",
        projection,
        noAdmittedToken: !text.includes("admitted-test-session"),
        noDeniedToken: !text.includes("denied-test-session"),
        noStore: response.headers.get("cache-control") === "private, no-store",
        noLocation: !response.headers.has("location"),
        cookieHidden: response.headers.get("set-cookie") === null,
      };
    },
    { path: SECURITY_PAGE, cacheBusting, tree },
  );
  const received = await wire;
  const correct =
    value.status === 200 &&
    value.component &&
    value.projection === expected &&
    (expected === "denied" ? value.noAdmittedToken : value.noDeniedToken) &&
    value.noStore &&
    value.noLocation &&
    value.cookieHidden &&
    received !== null &&
    received.noSetCookie &&
    received.noLocation;
  if (!correct)
    console.info(
      `Synthetic full RSC diagnostic expected=${expected}, status=${value.status}, component=${value.component}, projection=${value.projection}, noAdmitted=${value.noAdmittedToken}, noDenied=${value.noDeniedToken}, noStore=${value.noStore}, noLocation=${value.noLocation}, cookieHidden=${value.cookieHidden}, wireObserved=${received !== null}, noSetCookie=${received?.noSetCookie === true}.`,
    );
  expect(correct).toBe(true);
}
async function rscDeniedWithoutNavigation() {
  await rscGuardWithoutNavigation("denied");
}
async function heldSurfacesDenied() {
  const native = await heldNativeProbe();
  expect(
    native.present &&
      [403, 500].includes(native.status) &&
      native.noStore &&
      native.noLocation &&
      native.cookieHidden,
  ).toBe(true);
  await heldFlightProbeDenied();
  const route = await post("session");
  expect(
    route.status === 401 && route.state === "denied" && safeRoute(route),
  ).toBe(true);
  await rscDeniedWithoutNavigation();
}
async function securityStamp(userId: string) {
  const result = await fx.migration.query(
    `SELECT jsonb_build_object(
    'origins',(SELECT coalesce(jsonb_agg(jsonb_build_array(a.session_id,a.authenticated_at,a.last_seen_at,a.mfa_at,c.authenticated_at,c.absolute_deadline,c.epoch_id) ORDER BY a.session_id),'[]'::jsonb)
      FROM staff.admissions a JOIN control_private.session_controls c USING(session_id) WHERE a.user_id=$1),
    'reserved',(SELECT count(*) FROM audit.events WHERE subject_id=$1 AND action='control.reserved'),
    'burns',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.code_mac),'[]'::jsonb) FROM control_private.replay_burns b),
    'factors',(SELECT coalesce(jsonb_agg(jsonb_build_array(id,"failedVerificationCount","lockedUntil") ORDER BY id),'[]'::jsonb) FROM identity."TwoFactor" WHERE "userId"=$1)) value`,
    [userId],
  );
  return digest(result.rows[0].value);
}
async function noGrant(principal: SyntheticPrincipal) {
  const result = await fx.migration.query<{ safe: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$1 AND mode='verified')
      AND NOT EXISTS(SELECT 1 FROM control_private.attempts WHERE user_id=$1 AND state='ready') AS safe`,
    [principal.userId],
  );
  expect(result.rows.length === 1 && result.rows[0].safe === true).toBe(true);
}
async function assertPrivateLogs(
  principal: SyntheticPrincipal,
  additional: readonly string[] = [],
) {
  const owner = host;
  if (!owner) throw new Error("Owned browser log witness unavailable.");
  const cookies = await ownedCookies();
  expect(
    [
      principal.email,
      principal.password,
      principal.secret,
      principal.userId,
      principal.generationId,
      fx.secret,
      csrfSecret,
      ...additional,
      ...cookies.map((cookie) => cookie.value),
    ]
      .filter(Boolean)
      .every((value) => !owner.logContains(value)),
  ).toBe(true);
}
async function assertOwnedMigration(client: Client = fx.migration) {
  const suffix = /^bookstore_security_test_([a-f0-9]{12})$/.exec(
    fx.owned.name,
  )?.[1];
  if (!suffix) throw new Error("Owned browser database binding unavailable.");
  const result = await client.query<{ safe: boolean }>(
    `SELECT current_database()=$1 AND current_user::text=$2 AND pg_get_userbyid(d.datdba)=$2
      AND shobj_description(d.oid,'pg_database') ~ $3 AS safe FROM pg_database d WHERE d.datname=current_database()`,
    [
      fx.owned.name,
      `bf_${suffix}_migrate`,
      `^bookstore-security-foundation:${suffix}:[a-f0-9]{32}$`,
    ],
  );
  if (result.rows.length !== 1 || result.rows[0].safe !== true)
    throw new Error("Owned browser database marker unavailable.");
}
async function newWorker() {
  const value = await createWorkerProcess(fx.owned.workerUrl);
  workers.add(value);
  return value;
}
async function closeWorker(value: WorkerProcess) {
  await value.close();
  workers.delete(value);
}
async function otherwiseLiveFacts(
  principal: SyntheticPrincipal,
  sessionId: string,
) {
  const result = await fx.migration.query<{ safe: boolean; facts: unknown }>(
    `SELECT p.status='active' AND a.mode='verified' AND NOT c.revoked AND NOT o.retired AND NOT g.retired
      AND c.fingerprint=g.fingerprint AND a.authz_version=p.authz_version AND c.authz_version=p.authz_version
      AND p.permission_version=1 AND c.permission_version=1 AND a.authenticated_at=c.authenticated_at
      AND a.authenticated_at<=clock_timestamp() AND a.last_seen_at<=clock_timestamp()
      AND a.last_seen_at+interval '30 minutes'>clock_timestamp() AND c.absolute_deadline>clock_timestamp()
      AND s."expiresAt">clock_timestamp() AND c.token_mac=o.token_mac
      AND c.token_mac=control_private.mac('session-token',s.token)
      AND u."emailVerified" AND u."twoFactorEnabled"
      AND EXISTS(SELECT 1 FROM identity."TwoFactor" WHERE "userId"=p.user_id AND verified) AS safe,
      jsonb_build_object('session',jsonb_build_array(s.id,s."userId",s."expiresAt",s."updatedAt",s."userAgent",s."ipAddress"),
        'user',jsonb_build_array(u.id,u.email,u."emailVerified",u."twoFactorEnabled"),'admission',to_jsonb(a),
        'control',to_jsonb(c),'observation',to_jsonb(o),'generation',to_jsonb(g),'principal',to_jsonb(p),
        'factors',(SELECT jsonb_agg(jsonb_build_array(id,verified,"failedVerificationCount","lockedUntil") ORDER BY id) FROM identity."TwoFactor" WHERE "userId"=p.user_id),
        'roles',(SELECT jsonb_agg(role_name ORDER BY role_name) FROM staff.role_grants WHERE user_id=p.user_id)) facts
      FROM identity."Session" s JOIN identity."User" u ON u.id=s."userId"
      JOIN staff.admissions a ON a.session_id=s.id AND a.user_id=s."userId"
      JOIN control_private.session_controls c ON c.session_id=s.id AND c.user_id=s."userId"
      JOIN control_private.session_observations o ON o.session_id=s.id AND o.user_id=s."userId"
      JOIN control_private.approved_generations g ON g.generation_id=c.generation_id AND g.user_id=s."userId"
      JOIN staff.principals p ON p.user_id=s."userId"
      WHERE s.id=$2 AND s."userId"=$1 AND g.generation_id=$3`,
    [principal.userId, sessionId, principal.generationId],
  );
  expect(result.rows.length === 1 && result.rows[0].safe === true).toBe(true);
  return digest(result.rows[0].facts);
}
async function withReconcileAuditFault(work: () => Promise<void>) {
  await assertOwnedMigration();
  let created = false;
  let triggered = false;
  try {
    await fx.migration
      .query(`CREATE FUNCTION public.b2e_browser_reconcile_fault() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
      RAISE EXCEPTION 'Synthetic B2e browser reconcile audit outage' USING ERRCODE='P0001'; END $$`);
    created = true;
    await fx.migration.query(
      "REVOKE ALL ON FUNCTION public.b2e_browser_reconcile_fault() FROM PUBLIC",
    );
    await fx.migration
      .query(`CREATE TRIGGER b2e_browser_reconcile_fault BEFORE INSERT ON audit.events
      FOR EACH ROW WHEN(NEW.action='provider.reconciled') EXECUTE FUNCTION public.b2e_browser_reconcile_fault()`);
    triggered = true;
    await work();
  } finally {
    try {
      if (triggered)
        await fx.migration.query(
          "DROP TRIGGER b2e_browser_reconcile_fault ON audit.events",
        );
    } finally {
      if (created)
        await fx.migration.query(
          "DROP FUNCTION public.b2e_browser_reconcile_fault()",
        );
    }
  }
}
async function lockWitness(sql: string, args: unknown[]) {
  // Fixed relation/advisory lock observations ONLY; not SDK/auth retries/sleeps.
  // Retain BOTH5s/2000queries. A monotonic2ms observer cadence prevents exhausting
  // the query cap early on a fast DB and reduces pressure on sampled-clock work.
  const started = performance.now();
  let queries = 0;
  let observed = false;
  let nextQueryAt = started;
  while (!observed && queries < 2000 && performance.now() - started < 5000) {
    if (performance.now() >= nextQueryAt) {
      const result = await fx.migration.query<{ observed: boolean }>(sql, args);
      queries++;
      observed =
        result.rows[0]?.observed === true && performance.now() - started < 5000;
      nextQueryAt = performance.now() + 2;
    }
    if (!observed) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return Object.freeze({
    observed,
    queries,
    queryCap: !observed && queries >= 2000,
    deadline: !observed && performance.now() - started >= 5000,
  });
}
function witnessFailureDiagnostic(
  phase: "verification" | "verifier-evidence" | "staff-governance",
  witness: Awaited<ReturnType<typeof lockWitness>>,
  reply: Awaited<ReturnType<typeof post>> | null | undefined,
) {
  // Only fixed public HTTP/state enums and bounded counts/booleans; never raw
  // body/error/headers/SQL/role/PID/cookie/OTP/configuration or provider records.
  const status =
    reply === undefined
      ? "pending"
      : reply === null
        ? "rejected"
        : [200, 401, 403, 429, 500, 503].includes(reply.status)
          ? String(reply.status)
          : "other";
  const knownStates = [
    "denied",
    "unavailable",
    "rate-limited",
    "mfa-required",
    "verified-test-session",
    "signed-out",
    "revoked",
  ];
  const state =
    reply === undefined
      ? "pending"
      : reply === null
        ? "rejected"
        : reply.state !== null && knownStates.includes(reply.state)
          ? reply.state
          : "other";
  console.info(
    `Synthetic browser lock diagnostic phase=${phase}, queries=${witness.queries}, queryCap=${witness.queryCap}, deadline=${witness.deadline}, replySettled=${reply !== undefined}, status=${status}, state=${state}, safeRoute=${reply != null && safeRoute(reply)}.`,
  );
}
async function closeOwnedProcesses() {
  const browser = context;
  context = undefined;
  page = undefined;
  const owner = host;
  host = undefined;
  const browserResults = await Promise.allSettled(
    browser ? [browser.close()] : [],
  );
  const results = await Promise.allSettled([
    ...(owner ? [owner.close()] : []),
    ...[...workers].map((value) => value.close()),
  ]);
  workers.clear();
  if (
    [...browserResults, ...results].some((value) => value.status === "rejected")
  )
    throw new Error("Owned integrated browser cleanup unavailable.");
}

beforeAll(() =>
  secretSafe(async () => {
    certs = await createTransportCertificates();
    await fx.start();
  }),
);
beforeEach(() =>
  secretSafe(async () => {
    await fx.resetScenario();
    host = await startNextProcess(nextConfig(fx.config, certs, csrfSecret));
    const profile = await prepareLinuxBrowserTrust(certs, true);
    context = await chromium.launchPersistentContext(profile.userDataDir, {
      executablePath: chromium.executablePath(),
      headless: true,
      env: profile.env,
      ignoreHTTPSErrors: false,
      serviceWorkers: "block",
      acceptDownloads: false,
      args: [
        "--no-proxy-server",
        `--host-resolver-rules=MAP ${NEXT_HOST} 127.0.0.1, EXCLUDE localhost`,
      ],
    });
    context.setDefaultTimeout(10000);
    context.setDefaultNavigationTimeout(10000);
    page = await context.newPage();
    const response = await page.goto(`${origin}${SECURITY_PAGE}`, {
      waitUntil: "domcontentloaded",
    });
    expect(
      response?.status() === 200 &&
        response.request().method() === "GET" &&
        !(await admitted()),
    ).toBe(true);
  }),
);
afterEach(() => secretSafe(closeOwnedProcesses));
afterAll(() =>
  secretSafe(async () => {
    try {
      await closeOwnedProcesses();
      await fx.stop();
    } finally {
      await certs?.close();
    }
  }),
);

describe("mandatory Linux Chromium B2e integrated denial/continuity evidence", () => {
  scenario(
    "actual browser bad-password Route commits exactly one fixed F02 denial without exposing cookies or secrets",
    async () => {
      const principal = await fx.createPrincipal();
      const before = new Set(
        (
          await fx.migration.query<{ id: string }>(
            "SELECT id::text FROM audit.denials",
          )
        ).rows.map((row) => row.id),
      );
      const wrongPassword = `${principal.password}invalid`;
      const result = await post("password", {
        email: principal.email,
        password: wrongPassword,
      });
      expect(
        result.status === 403 &&
          result.state === "denied" &&
          safeRoute(result) &&
          (await ownedCookies()).length === 0,
      ).toBe(true);
      const rows = await fx.migration.query<{
        id: string;
        reason: string;
        outcome: string;
      }>("SELECT id::text,reason,outcome FROM audit.denials");
      expect(
        [...before].every((id) => rows.rows.some((row) => row.id === id)),
      ).toBe(true);
      const added = rows.rows.filter((row) => !before.has(row.id));
      expect(added.length).toBe(1);
      expect(
        added.every(
          (row) =>
            row.reason === "forbidden" &&
            row.outcome === "denied" &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
              row.id,
            ) &&
            row.id !== principal.userId &&
            row.id !== principal.generationId,
        ),
      ).toBe(true);
      const witness = await fx.migration.query<{ safe: boolean }>(
        `SELECT
      (SELECT count(*) FROM control_private.attempts WHERE user_id=$1 AND state='prepared')=1
      AND (SELECT count(*) FROM control_private.budgets WHERE key_mac IN(
        control_private.mac('budget-account-password',$2::text),control_private.mac('budget-ip-password','unknown')) AND used=1)=2
      AND NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$1)
      AND NOT EXISTS(SELECT 1 FROM control_private.session_controls WHERE user_id=$1) AS safe`,
        [principal.userId, principal.email],
      );
      expect(witness.rows[0]?.safe === true).toBe(true);
      await assertPrivateLogs(principal, [wrongPassword]);
    },
  );

  scenario(
    "OFFLINE synthetic recovery-only admission/status denies held native Route RSC and fresh-code step-up without new burn or touch",
    async () => {
      const principal = await fx.createPrincipal();
      const loginCode = await login(principal);
      const freshCode = await fx.code(principal, 1);
      if (freshCode === loginCode)
        throw new Error("Synthetic distinct recovery-denial code unavailable.");
      await assertOwnedMigration();
      // Synthetic offline state only: no recovery endpoint, backup code, activation
      // or claim that an actual recovery ceremony happened.
      await fx.migration.query(
        "UPDATE staff.admissions SET mode='recovery' WHERE user_id=$1",
        [principal.userId],
      );
      const modeOnly = await fx.migration.query<{ safe: boolean }>(
        `SELECT EXISTS(
      SELECT 1 FROM staff.admissions a JOIN staff.principals p USING(user_id)
      JOIN control_private.session_controls c USING(session_id)
      JOIN control_private.approved_generations g ON g.generation_id=c.generation_id
      WHERE a.user_id=$1 AND a.mode='recovery' AND p.status='active' AND NOT c.revoked AND NOT g.retired) AS safe`,
        [principal.userId],
      );
      expect(modeOnly.rows[0]?.safe === true).toBe(true);
      const stamp = await securityStamp(principal.userId);
      const cookies = await cookieStamp();
      await heldSurfacesDenied();
      const modeStep = await post("stepUp", { code: freshCode });
      expect(
        modeStep.status === 403 &&
          safeRoute(modeStep) &&
          (await securityStamp(principal.userId)) === stamp,
      ).toBe(true);
      // A second explicitly different offline denial state, not a retry intended
      // to obtain success: principal recovery also denies without a fresh ceremony.
      await fx.migration.query(
        "UPDATE staff.principals SET status='recovery' WHERE user_id=$1",
        [principal.userId],
      );
      await heldSurfacesDenied();
      const statusStep = await post("stepUp", { code: freshCode });
      expect(statusStep.status === 403 && safeRoute(statusStep)).toBe(true);
      await freshGetDenied();
      expect(
        (await securityStamp(principal.userId)) === stamp &&
          (await cookieStamp()) === cookies,
      ).toBe(true);
      await assertCookieFlags(sessionName);
      await noGrant(principal);
      await assertPrivateLogs(principal, [loginCode, freshCode]);
    },
  );

  scenario(
    "actual stale authorization version rejects held DOM native POST before a fresh protected GET without cookie or lifetime rebase",
    async () => {
      const principal = await fx.createPrincipal();
      const code = await login(principal);
      await assertOwnedMigration();
      await fx.migration.query(
        "UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=$1",
        [principal.userId],
      );
      const stamp = await securityStamp(principal.userId);
      const cookies = await cookieStamp();
      const native = await heldNativeProbe();
      expect(
        native.present &&
          [403, 500].includes(native.status) &&
          native.noStore &&
          native.noLocation &&
          native.cookieHidden,
      ).toBe(true);
      // Fetching the held form did NOT navigate or replace the old admitted DOM.
      expect(await admitted()).toBe(true);
      const route = await post("session");
      expect(route.status === 401 && safeRoute(route)).toBe(true);
      await freshGetDenied();
      expect(
        (await securityStamp(principal.userId)) === stamp &&
          (await cookieStamp()) === cookies,
      ).toBe(true);
      await assertCookieFlags(sessionName);
      await assertPrivateLogs(principal, [code]);
    },
  );

  scenario(
    "SYNTHETIC offline session.changed ledger PENDING to BLOCKED denies browser held native Flight Route RSC with otherwise-live facts",
    async () => {
      const principal = await fx.createPrincipal();
      const code = await login(principal);
      await fx.drain();
      await assertOwnedMigration();
      const rights = await fx.migration.query<{ safe: boolean }>(
        "SELECT has_table_privilege('audit.provider_events','INSERT') AS safe",
      );
      if (rights.rows[0]?.safe !== true)
        throw new Error(
          "Owned browser ledger INSERT unavailable; no grant widened.",
        );
      const sessions = await fx.migration.query<{ session_id: string }>(
        "SELECT session_id FROM staff.admissions WHERE user_id=$1 AND mode='verified'",
        [principal.userId],
      );
      expect(sessions.rows.length).toBe(1);
      const sessionId = sessions.rows[0].session_id;
      const facts = await otherwiseLiveFacts(principal, sessionId);
      const cookies = await cookieStamp();
      // NOT a native provider commit. Immutable005176 also suppresses metadata-only
      // Session UPDATE events, so that withdrawn hypothesis is not used here.
      const inserted = await fx.migration.query<{ id: string }>(
        `INSERT INTO audit.provider_events(user_id,session_id,kind,invalidates_user)
      SELECT s."userId",s.id,'session.changed',false FROM identity."Session" s
      JOIN staff.admissions a ON a.session_id=s.id AND a.user_id=s."userId"
      WHERE s.id=$2 AND s."userId"=$1 AND a.mode='verified' RETURNING id::text`,
        [principal.userId, sessionId],
      );
      expect(inserted.rows.length).toBe(1);
      const eventId = inserted.rows[0].id;
      const barrier = async (
        state: "pending" | "blocked",
        attempts: number,
      ) => {
        const result = await fx.migration.query<{ safe: boolean }>(
          `SELECT
        EXISTS(SELECT 1 FROM audit.provider_events WHERE id=$1::bigint AND user_id=$2 AND session_id=$3
          AND kind='session.changed' AND NOT invalidates_user AND state=$4 AND attempts=$5)
        AND (SELECT count(*) FROM audit.provider_events WHERE user_id=$2 AND state<>'processed'
          AND (invalidates_user OR session_id=$3))=1
        AND NOT EXISTS(SELECT 1 FROM audit.events WHERE transition_id=$1::bigint) AS safe`,
          [eventId, principal.userId, sessionId, state, attempts],
        );
        expect(
          result.rows[0]?.safe === true &&
            (await otherwiseLiveFacts(principal, sessionId)) === facts &&
            (await cookieStamp()) === cookies,
        ).toBe(true);
      };
      await barrier("pending", 0);
      await heldSurfacesDenied();
      const first = await newWorker();
      await withReconcileAuditFault(async () => {
        for (const attempts of [1, 2, 3, 4, 5] as const) {
          const result = await first.runOnce();
          expect(
            result.status === "partial" &&
              result.selected === 1 &&
              result.applied === 0 &&
              result.skipped === 0 &&
              result.failed === 1 &&
              result.uncertain === 1 &&
              result.failureRecordCallsConfirmed === 1,
          ).toBe(true);
          await barrier(attempts === 5 ? "blocked" : "pending", attempts);
        }
        await heldSurfacesDenied();
        await barrier("blocked", 5);
      });
      await closeWorker(first);
      const fresh = await newWorker();
      const result = await fresh.runOnce();
      expect(
        result.status === "completed" &&
          result.selected === 0 &&
          result.applied === 0 &&
          result.failed === 0 &&
          result.uncertain === 0 &&
          result.failureRecordCallsConfirmed === 0 &&
          !Object.hasOwn(result, "healthy") &&
          !Object.hasOwn(result, "blocked"),
      ).toBe(true);
      await heldSurfacesDenied();
      await barrier("blocked", 5);
      await freshGetDenied();
      await barrier("blocked", 5);
      await assertCookieFlags(sessionName);
      await assertPrivateLogs(principal, [code]);
    },
  );

  scenario(
    "actual delayed UNKNOWN password response may install a NEW primary after anonymous logout but never a verified session",
    async () => {
      const principal = await fx.createPrincipal();
      expect((await ownedCookies()).length).toBe(0);
      const beforeMfa = await securityStamp(principal.userId);
      const blocker = await fx.client(fx.owned.migrationUrl);
      let locked = false;
      let pending: Promise<Awaited<ReturnType<typeof post>> | null> | undefined;
      try {
        await assertOwnedMigration(blocker);
        await blocker.query("BEGIN");
        locked = true;
        await blocker.query(
          'LOCK TABLE identity."Verification" IN ACCESS EXCLUSIVE MODE',
        );
        const pid = (
          await blocker.query<{ pid: number }>("SELECT pg_backend_pid() pid")
        ).rows[0].pid;
        pending = post("password", {
          email: principal.email,
          password: principal.password,
        }).then(
          (value) => value,
          () => null,
        );
        const observed = await lockWitness(
          `SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE a.datname=current_database() AND a.usename=$1 AND l.locktype='relation'
          AND l.relation='identity."Verification"'::regclass AND NOT l.granted
          AND $2::integer=ANY(pg_blocking_pids(a.pid))) AS observed`,
          [new URL(fx.owned.authUrl).username, pid],
        );
        expect(observed.observed).toBe(true);
        // Pinned SDK deletes its transient native Session before creating this
        // Verification challenge. Empty-jar signout never selects Verification.
        expect((await ownedCookies()).length).toBe(0);
        const signOut = await post("signOut");
        expect(
          signOut.status === 200 &&
            signOut.state === "signed-out" &&
            safeRoute(signOut) &&
            (await ownedCookies()).length === 0,
        ).toBe(true);
        await blocker.query("ROLLBACK");
        locked = false;
        const delayed = await pending;
        expect(
          delayed !== null &&
            delayed.status === 200 &&
            delayed.state === "mfa-required" &&
            safeRoute(delayed),
        ).toBe(true);
        await assertCookieFlags(challengeName);
        const route = await post("session");
        expect(route.status === 401 && safeRoute(route)).toBe(true);
        await freshGetDenied();
        const witness = await fx.migration.query<{ safe: boolean }>(
          `SELECT
        (SELECT count(*) FROM control_private.attempts WHERE user_id=$1 AND state='bound' AND code_mac IS NULL)=1
        AND NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$1)
        AND NOT EXISTS(SELECT 1 FROM control_private.session_controls WHERE user_id=$1)
        AND NOT EXISTS(SELECT 1 FROM control_private.attempts WHERE user_id=$1 AND code_mac IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM audit.events WHERE subject_id=$1 AND action IN('control.reserved','control.evidence','control.login')) AS safe`,
          [principal.userId],
        );
        expect(
          witness.rows[0]?.safe === true &&
            (await securityStamp(principal.userId)) === beforeMfa,
        ).toBe(true);
        await assertPrivateLogs(principal);
      } finally {
        try {
          if (locked) await blocker.query("ROLLBACK");
          if (pending) await pending;
        } finally {
          await fx.release(blocker);
        }
      }
    },
  );

  scenario(
    "actual known-primary MFA versus logout at owned evidence/governance barriers leaves no authorizing browser cookie",
    async () => {
      const principal = await fx.createPrincipal();
      await begin(principal);
      const primaryCookies = await ownedCookies();
      const code = await fx.code(principal);
      const beforeSessions = (
        await fx.migration.query<{ count: number }>(
          'SELECT count(*)::integer AS count FROM identity."Session" WHERE "userId"=$1',
          [principal.userId],
        )
      ).rows[0].count;
      const blocker = await fx.client(fx.owned.migrationUrl);
      let locked = false;
      let created = false;
      let triggered = false;
      let mfa: Promise<Awaited<ReturnType<typeof post>> | null> | undefined;
      let mfaReply: Awaited<ReturnType<typeof post>> | null | undefined;
      let signOut: Promise<Awaited<ReturnType<typeof post>> | null> | undefined;
      try {
        await assertOwnedMigration();
        await assertOwnedMigration(blocker);
        await fx.migration
          .query(`CREATE FUNCTION public.b2e_browser_pause_evidence() RETURNS trigger
        LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
        PERFORM pg_catalog.pg_advisory_xact_lock(624320021::bigint); RETURN NEW; END $$`);
        created = true;
        await fx.migration.query(
          "REVOKE ALL ON FUNCTION public.b2e_browser_pause_evidence() FROM PUBLIC",
        );
        await fx.migration
          .query(`CREATE TRIGGER b2e_browser_pause_evidence BEFORE INSERT ON audit.events
        FOR EACH ROW WHEN(NEW.action='control.evidence') EXECUTE FUNCTION public.b2e_browser_pause_evidence()`);
        triggered = true;
        await blocker.query("SELECT pg_advisory_lock(624320021::bigint)");
        locked = true;
        const pid = (
          await blocker.query<{ pid: number }>("SELECT pg_backend_pid() pid")
        ).rows[0].pid;
        mfa = post("totp", { code }).then(
          (value) => {
            mfaReply = value;
            return value;
          },
          () => {
            mfaReply = null;
            return null;
          },
        );
        const verifierWitness = await lockWitness(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.datname=current_database()
        AND a.usename=$1 AND a.wait_event_type='Lock' AND $2::integer=ANY(pg_blocking_pids(a.pid))) AS observed`,
          [new URL(fx.owned.verifierUrl).username, pid],
        );
        if (!verifierWitness.observed)
          witnessFailureDiagnostic(
            "verifier-evidence",
            verifierWitness,
            mfaReply,
          );
        expect(verifierWitness.observed).toBe(true);
        const nativeCommit = await fx.migration.query<{ safe: boolean }>(
          'SELECT count(*)>$2::integer AS safe FROM identity."Session" WHERE "userId"=$1',
          [principal.userId, beforeSessions],
        );
        expect(
          nativeCommit.rows[0]?.safe === true &&
            (await cookieStamp()) === digest(primaryCookies),
        ).toBe(true);
        signOut = post("signOut").then(
          (value) => value,
          () => null,
        );
        // The STAFF ingress/clock operation is queued behind the VERIFIER that is
        // itself waiting on our exact advisory key. This observes one real order;
        // it does NOT force or claim both HTTP response delivery permutations.
        const staffWitness = await lockWitness(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity s JOIN pg_stat_activity v
        ON v.pid=ANY(pg_blocking_pids(s.pid)) WHERE s.datname=current_database() AND v.datname=current_database()
          AND s.usename=$1 AND v.usename=$2 AND s.wait_event_type='Lock'
          AND $3::integer=ANY(pg_blocking_pids(v.pid))) AS observed`,
          [
            new URL(fx.owned.staffUrl).username,
            new URL(fx.owned.verifierUrl).username,
            pid,
          ],
        );
        if (!staffWitness.observed)
          witnessFailureDiagnostic("staff-governance", staffWitness, mfaReply);
        expect(staffWitness.observed).toBe(true);
        await blocker.query("SELECT pg_advisory_unlock(624320021::bigint)");
        locked = false;
        const [mfaResult, signOutResult] = await Promise.all([mfa, signOut]);
        expect(
          mfaResult !== null &&
            [200, 403, 503].includes(mfaResult.status) &&
            safeRoute(mfaResult) &&
            signOutResult !== null &&
            [200, 503].includes(signOutResult.status) &&
            safeRoute(signOutResult),
        ).toBe(true);
        const finalCookies = await ownedCookies();
        const route = await post("session");
        expect(route.status === 401 && safeRoute(route)).toBe(true);
        await freshGetDenied();
        // Negative copied-cookie replay uses ONLY cookies actually issued to this
        // browser, never a positive API-jar identity substitute or TLS fallback.
        await currentContext().clearCookies();
        await currentContext().addCookies(primaryCookies);
        const copiedPrimary = await post("session");
        expect(copiedPrimary.status === 401 && safeRoute(copiedPrimary)).toBe(
          true,
        );
        await currentContext().clearCookies();
        if (finalCookies.length)
          await currentContext().addCookies(finalCookies);
        const copiedFinal = await post("session");
        expect(copiedFinal.status === 401 && safeRoute(copiedFinal)).toBe(true);
        await freshGetDenied();
        const witness = await fx.migration.query<{ safe: boolean }>(
          `SELECT
        EXISTS(SELECT 1 FROM control_private.attempts a JOIN control_private.replay_burns b ON b.code_mac=a.code_mac
          WHERE a.user_id=$1 AND a.state='revoked' AND a.final_session_id IS NOT NULL
            AND b.reserved_at=a.reserved_at AND b.expires_at=b.reserved_at+interval '180 seconds'
            AND b.expires_at>clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$1 AND mode='verified')
        AND NOT EXISTS(SELECT 1 FROM control_private.session_controls WHERE user_id=$1 AND NOT revoked) AS safe`,
          [principal.userId],
        );
        expect(witness.rows[0]?.safe === true).toBe(true);
        await assertPrivateLogs(principal, [
          code,
          ...primaryCookies.map((cookie) => cookie.value),
          ...finalCookies.map((cookie) => cookie.value),
        ]);
      } finally {
        try {
          if (locked)
            await blocker.query("SELECT pg_advisory_unlock(624320021::bigint)");
          await Promise.all([mfa, signOut]);
        } finally {
          try {
            if (triggered)
              await fx.migration.query(
                "DROP TRIGGER b2e_browser_pause_evidence ON audit.events",
              );
          } finally {
            try {
              if (created)
                await fx.migration.query(
                  "DROP FUNCTION public.b2e_browser_pause_evidence()",
                );
            } finally {
              await fx.release(blocker);
            }
          }
        }
      }
    },
  );
});
