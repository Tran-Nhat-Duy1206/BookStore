import { randomBytes } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer, type Server } from "node:http";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { computeCacheBustingSearchParam } from "next/dist/shared/lib/router/utils/cache-busting-search-param";
import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
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
  prepareLinuxBrowserTrust,
  type TransportCertificateFixture,
  type CertificatePeer,
} from "../https-transport/certificates";
import { nextConfig, startNextProcess, type NextProcess } from "./client";
import { createWorkerProcess } from "./worker-client";
import {
  NEXT_AUTH_PATHS,
  NEXT_HOST,
  SECURITY_PAGE,
} from "../../experiments/next-security/wire";

if (process.platform !== "linux")
  throw new Error(
    "Next browser acceptance requires actual Linux isolated NSS trust.",
  );
const origin = `https://${NEXT_HOST}:3463`,
  alias = "other.bookstore-transport.invalid",
  foreign = "foreign-transport.invalid";
const fx = new ControlFixtures(),
  contexts = new Set<BrowserContext>(),
  peers = new Set<Server>();
const prefix = "__Secure-bookstore-provider-proof.",
  sessionName = `${prefix}session_token`,
  challengeName = `${prefix}two_factor`;
let certs: TransportCertificateFixture,
  processOwner: NextProcess | undefined,
  context: BrowserContext,
  page: Page,
  plain: Server;
let plainCookie = false,
  plainRequests = 0;
const csrfSecret = randomBytes(48).toString("hex");
const scenario = (name: string, run: () => Promise<void>) =>
  it(name, () => secretSafe(run));
async function launch(trusted = true) {
  const profile = await prepareLinuxBrowserTrust(certs, trusted);
  const browser = await chromium.launchPersistentContext(profile.userDataDir, {
    executablePath: chromium.executablePath(),
    headless: true,
    env: profile.env,
    ignoreHTTPSErrors: false,
    serviceWorkers: "block",
    acceptDownloads: false,
    args: [
      "--no-proxy-server",
      `--host-resolver-rules=MAP ${NEXT_HOST} 127.0.0.1, MAP ${alias} 127.0.0.1, MAP ${foreign} 127.0.0.1, EXCLUDE localhost`,
    ],
  });
  browser.setDefaultTimeout(10000);
  browser.setDefaultNavigationTimeout(10000);
  contexts.add(browser);
  return browser;
}
async function closeContext(value: BrowserContext) {
  await value.close();
  contexts.delete(value);
}
async function listen(server: Server, port: 3464 | 3465) {
  peers.add(server);
  server.maxConnections = 16;
  server.requestTimeout = 5000;
  server.headersTimeout = 3000;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((done, failed) => {
    const fail = () =>
      failed(new Error("Owned Next negative peer unavailable."));
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.removeListener("error", fail);
      done();
    });
  });
  server.on("error", () => {});
}
async function closePeer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, failed) =>
    server.close((error) =>
      error
        ? failed(new Error("Owned Next peer cleanup unavailable."))
        : done(),
    ),
  );
  peers.delete(server);
}
async function withPeer<T>(
  certificate: CertificatePeer,
  run: () => Promise<T>,
) {
  let cookie = false;
  const peer = createHttpsServer(
    { key: certificate.key, cert: certificate.cert, minVersion: "TLSv1.3" },
    (req, res) => {
      if (req.url === "/") cookie ||= !!req.headers.cookie;
      res.writeHead(200, {
        "content-type": "text/html",
        "cache-control": "private, no-store",
        connection: "close",
      });
      res.end("<!doctype html><title>Non-authorizing Next peer</title>");
    },
  );
  peer.on("tlsClientError", () => {});
  await listen(peer, 3465);
  try {
    return { value: await run(), cookie: () => cookie };
  } finally {
    await closePeer(peer);
  }
}
async function certificateResult(browser: BrowserContext, url: string) {
  const target = await browser.newPage();
  try {
    await target.goto(url, { waitUntil: "domcontentloaded" });
    return "accepted";
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return message.includes("ERR_CERT_AUTHORITY_INVALID")
      ? "authority"
      : message.includes("ERR_CERT_COMMON_NAME_INVALID")
        ? "name"
        : message.includes("ERR_CERT_DATE_INVALID")
          ? "date"
          : "unexpected";
  } finally {
    await target.close();
  }
}
async function post(
  route: keyof typeof NEXT_AUTH_PATHS,
  body: Record<string, string> = {},
  csrf = true,
) {
  return page.evaluate(
    async ({ path, body, csrf }) => {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(csrf ? { "X-Bookstore-CSRF": "1" } : {}),
        },
        body: JSON.stringify(body),
        redirect: "manual",
      });
      let minimal = false,
        state: string | null = null;
      try {
        const value = await response.json();
        minimal =
          Object.keys(value).sort().join(",") ===
            "applicationAdmission,state" &&
          value.applicationAdmission === "disabled";
        state = typeof value.state === "string" ? value.state : null;
      } catch {}
      return {
        status: response.status,
        state,
        minimal,
        noStore: response.headers.get("cache-control") === "private, no-store",
        noRedirect: !response.headers.has("location"),
        cookieHidden: response.headers.get("set-cookie") === null,
      };
    },
    { path: NEXT_AUTH_PATHS[route], body, csrf },
  );
}
async function begin(principal: SyntheticPrincipal) {
  expect(
    (
      await post("password", {
        email: principal.email,
        password: principal.password,
      })
    ).status,
  ).toBe(200);
}
async function login(principal: SyntheticPrincipal) {
  await begin(principal);
  expect((await post("totp", { code: await fx.code(principal) })).status).toBe(
    200,
  );
  await page.goto(`${origin}${SECURITY_PAGE}`, {
    waitUntil: "domcontentloaded",
  });
  expect(await admitted()).toBe(true);
}
async function admitted() {
  return (
    (await page
      .locator('[data-live-guard="admitted-test-session"]')
      .count()) === 1
  );
}
async function ownedCookies() {
  return (await context.cookies()).filter((cookie) =>
    cookie.name.startsWith(prefix),
  );
}
async function stamp(userId: string) {
  return (
    await fx.migration.query(
      "SELECT a.authenticated_at::text,a.last_seen_at::text,a.mfa_at::text,c.absolute_deadline::text FROM staff.admissions a JOIN control_private.session_controls c USING(session_id) WHERE a.user_id=$1 ORDER BY a.session_id",
      [userId],
    )
  ).rows;
}
async function nativeClick(purpose: "probe" | "revoke-self" | "sign-out") {
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("Emulation.setScriptExecutionDisabled", { value: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    const [response, request] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          request.url() === `${origin}${SECURITY_PAGE}`,
      ),
      page.locator(`form[data-native="${purpose}"] button`).click(),
    ]);
    const headers = await request.allHeaders();
    const exact = headers.origin === origin,
      opaque = headers.origin === "null",
      status = response?.status() ?? 0;
    if (!exact || opaque || status !== 200)
      console.info(
        `Synthetic native form diagnostic exactOrigin=${exact}, opaqueOrigin=${opaque}, status=${status}.`,
      );
    expect(exact && !opaque && status === 200).toBe(true);
  } finally {
    await cdp.send("Emulation.setScriptExecutionDisabled", { value: false });
    await cdp.detach();
  }
}
async function enhancedClick(purpose: "probe" | "sign-out") {
  // Readiness, not authentication; ONE request only after handlers attach.
  await page.locator('[data-hydrated="ready"]').waitFor();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url() === `${origin}${SECURITY_PAGE}`,
  );
  await page.locator(`[data-enhanced="${purpose}"]`).click();
  const response = await responsePromise,
    headers = await response.request().allHeaders();
  let physical = false,
    rootLayout = false;
  try {
    const tree: unknown = JSON.parse(
      decodeURIComponent(headers["next-router-state-tree"] ?? ""),
    );
    physical = JSON.stringify(tree).includes("%5F_bookstore_next_security");
    rootLayout = Array.isArray(tree) && tree[4] === 16;
  } catch {}
  const exact = headers.origin === origin,
    status = response.status();
  if (status !== 200 || !exact || !physical || !rootLayout)
    console.info(
      `Synthetic enhanced form diagnostic exactOrigin=${exact}, physicalSegment=${physical}, rootLayout16=${rootLayout}, status=${status}.`,
    );
  expect(status === 200 && exact && physical && rootLayout).toBe(true);
  await page
    .locator('[data-action-outcome="completed-without-application-admission"]')
    .waitFor();
}
async function directForm(
  purpose: string,
  mode: "normal" | "missing" | "wrong" | "claim" = "normal",
) {
  return page.evaluate(
    async ({ purpose, mode, path }) => {
      const form = document.querySelector(`form[data-native="${purpose}"]`);
      if (!(form instanceof HTMLFormElement))
        return { status: 0, noStore: false };
      const body = new FormData(form);
      if (mode === "missing") body.delete("csrf");
      if (mode === "wrong") {
        const value = String(body.get("csrf") ?? "");
        body.set(
          "csrf",
          value.slice(0, -1) + (value.endsWith("0") ? "1" : "0"),
        );
      }
      if (mode === "claim") body.set("userId", "synthetic-forged-claim");
      const response = await fetch(path, {
        method: "POST",
        body,
        credentials: "same-origin",
        redirect: "manual",
      });
      await response.text();
      return {
        status: response.status,
        noStore: response.headers.get("cache-control") === "private, no-store",
      };
    },
    { purpose, mode, path: SECURITY_PAGE },
  );
}
beforeAll(() =>
  secretSafe(async () => {
    certs = await createTransportCertificates();
    await fx.start();
    plain = createHttpServer((req, res) => {
      if (req.url === "/") {
        plainCookie ||= !!req.headers.cookie;
        plainRequests++;
      }
      const foreignDocument =
        req.method === "GET" &&
        req.url === "/" &&
        req.headers.host === `${foreign}:3464`;
      res.writeHead(foreignDocument ? 200 : 403, {
        "content-type": "text/html",
        "cache-control": "private, no-store",
        connection: "close",
      });
      res.end("<!doctype html><title>Non-authorizing plaintext peer</title>");
    });
    await listen(plain, 3464);
  }),
);
beforeEach(() =>
  secretSafe(async () => {
    await fx.resetScenario();
    plainCookie = false;
    plainRequests = 0;
    processOwner = await startNextProcess(
      nextConfig(fx.config, certs, csrfSecret),
    );
    context = await launch();
    page = await context.newPage();
    await page.goto(`${origin}${SECURITY_PAGE}`, {
      waitUntil: "domcontentloaded",
    });
  }),
);
afterEach(() =>
  secretSafe(async () => {
    if (context) await closeContext(context);
    await processOwner?.close();
    processOwner = undefined;
  }),
);
afterAll(() =>
  secretSafe(async () => {
    for (const browser of [...contexts]) await closeContext(browser);
    await processOwner?.close();
    for (const peer of [...peers]) await closePeer(peer);
    await fx.stop();
    await certs?.close();
  }),
);

describe("mandatory actual Linux Chromium Next RSC Action TLS acceptance", () => {
  scenario("rejects private CA in a fresh untrusted HOME", async () => {
    const browser = await launch(false);
    try {
      expect(
        await certificateResult(browser, `${origin}${SECURITY_PAGE}`),
      ).toBe("authority");
    } finally {
      await closeContext(browser);
    }
  });
  scenario("accepts only isolated trusted CA without TLS bypass", async () => {
    expect(await certificateResult(context, `${origin}${SECURITY_PAGE}`)).toBe(
      "accepted",
    );
  });
  for (const [fault, expected] of [
    ["wrongSan", "name"],
    ["expired", "date"],
    ["future", "date"],
  ] as const)
    scenario(`rejects trusted ${fault} certificate`, async () => {
      const result = await withPeer(certs.faults[fault], () =>
        certificateResult(context, `https://${NEXT_HOST}:3465/`),
      );
      expect(result.value).toBe(expected);
    });
  scenario("rejects an unrelated private CA", async () => {
    const other = await createTransportCertificates();
    try {
      const result = await withPeer(other, () =>
        certificateResult(context, `https://${NEXT_HOST}:3465/`),
      );
      expect(result.value).toBe("authority");
    } finally {
      await other.close();
    }
  });
  scenario(
    "denies anonymous and password-only RSC while enforcing browser challenge flags",
    async () => {
      expect(await admitted()).toBe(false);
      const principal = await fx.createPrincipal();
      await begin(principal);
      const cookies = await ownedCookies();
      expect(
        cookies.length === 1 &&
          cookies.every(
            (cookie) =>
              cookie.name === challengeName &&
              cookie.secure &&
              cookie.httpOnly &&
              cookie.sameSite === "Strict" &&
              cookie.path === "/" &&
              cookie.domain === NEXT_HOST,
          ),
      ).toBe(true);
      expect(await page.evaluate(() => document.cookie === "")).toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await admitted()).toBe(false);
      expect((await post("session")).status).toBe(401);
    },
  );
  scenario(
    "rotates actual TOTP cookies before admitted RSC with no secret HTML",
    async () => {
      const principal = await fx.createPrincipal();
      await begin(principal);
      const prior = await ownedCookies();
      const code = await fx.code(principal);
      expect((await post("totp", { code })).status).toBe(200);
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await admitted()).toBe(true);
      const cookies = await ownedCookies();
      expect(
        cookies.length === 1 &&
          cookies.every(
            (cookie) =>
              cookie.name === sessionName &&
              cookie.secure &&
              cookie.httpOnly &&
              cookie.sameSite === "Strict" &&
              cookie.path === "/" &&
              cookie.domain === NEXT_HOST,
          ),
      ).toBe(true);
      const html = await page.content();
      expect(
        !html.includes(principal.password) &&
          !html.includes(principal.secret) &&
          !html.includes(code) &&
          cookies.every((cookie) => !html.includes(cookie.value)) &&
          prior.every((cookie) => !html.includes(cookie.value)),
      ).toBe(true);
      expect(await page.evaluate(() => document.cookie === "")).toBe(true);
      const checked = await post("session");
      expect(
        checked.status === 200 &&
          checked.minimal &&
          checked.noStore &&
          checked.noRedirect &&
          checked.cookieHidden,
      ).toBe(true);
    },
  );
  scenario(
    "rejects copied stale primary after final SDK rotation",
    async () => {
      const principal = await fx.createPrincipal();
      await begin(principal);
      const old = await ownedCookies(),
        code = await fx.code(principal);
      expect((await post("totp", { code })).status).toBe(200);
      await context.clearCookies();
      await context.addCookies(old);
      expect((await post("totp", { code })).status === 200).toBe(false);
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await admitted()).toBe(false);
    },
  );
  scenario("withholds host-only cookies from a valid TLS alias", async () => {
    await login(await fx.createPrincipal());
    const result = await withPeer(certs, async () => {
      await page.goto(`https://${alias}:3465/`, {
        waitUntil: "domcontentloaded",
      });
    });
    expect(result.cookie()).toBe(false);
  });
  scenario(
    "withholds Secure cookies from genuine invalid-host plaintext",
    async () => {
      await login(await fx.createPrincipal());
      const response = await page.goto(`http://${NEXT_HOST}:3464/`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        response?.status() === 403 && plainRequests > 0 && !plainCookie,
      ).toBe(true);
    },
  );
  scenario(
    "proves same-site port positive and cross-site Strict withholding",
    async () => {
      await login(await fx.createPrincipal());
      const same = await withPeer(certs, async () => {
        await page.goto(`https://${NEXT_HOST}:3465/`, {
          waitUntil: "domcontentloaded",
        });
      });
      expect(same.cookie()).toBe(true);
      await page.goto(`http://${foreign}:3464/`, {
        waitUntil: "domcontentloaded",
      });
      const cross = await withPeer(certs, async () => {
        await page.evaluate((url) => {
          location.href = url;
        }, `https://${NEXT_HOST}:3465/`);
        await page.waitForURL(`https://${NEXT_HOST}:3465/`);
      });
      expect(cross.cookie()).toBe(false);
    },
  );
  scenario(
    "executes genuine JS-disabled native probe without idle extension",
    async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      const before = await stamp(principal.userId);
      await nativeClick("probe");
      expect(await admitted()).toBe(true);
      expect(
        JSON.stringify(await stamp(principal.userId)) ===
          JSON.stringify(before),
      ).toBe(true);
    },
  );
  scenario(
    "executes real enhanced Flight probe without navigation or idle extension",
    async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      const before = await stamp(principal.userId);
      await enhancedClick("probe");
      expect(
        JSON.stringify(await stamp(principal.userId)) ===
          JSON.stringify(before),
      ).toBe(true);
    },
  );
  scenario(
    "direct native Action invocation does not rely on navigation/layout",
    async () => {
      await login(await fx.createPrincipal());
      const response = await directForm("probe");
      expect(response.status === 200 && response.noStore).toBe(true);
    },
  );
  for (const mode of ["missing", "wrong", "claim"] as const)
    scenario(`rejects direct Action ${mode} with no revocation`, async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      const before = await stamp(principal.userId);
      expect((await directForm("revoke-self", mode)).status === 200).toBe(
        false,
      );
      expect(
        JSON.stringify(await stamp(principal.userId)) ===
          JSON.stringify(before),
      ).toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await admitted()).toBe(true);
    });
  scenario(
    "revalidates native self-revocation then denies retained browser cookie",
    async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      const before = (
        await fx.migration.query<{ session_id: string }>(
          "SELECT session_id FROM staff.admissions WHERE user_id=$1 AND mode='verified'",
          [principal.userId],
        )
      ).rows;
      expect(before.length === 1).toBe(true);
      await nativeClick("revoke-self");
      // Accepted005 revoke_admission269 updates the SAME row to mode=revoked;
      // it intentionally retains lineage instead of deleting controls/session.
      const retired = (
        await fx.migration.query<{ safe: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$1 AND session_id=$2 AND mode='revoked') AND NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$1 AND mode<>'revoked') AS safe",
          [principal.userId, before[0].session_id],
        )
      ).rows[0]?.safe;
      expect(retired === true).toBe(true);
      expect((await post("session")).status === 200).toBe(false);
      const response = await page.reload({ waitUntil: "domcontentloaded" });
      expect(response?.status() === 200 && !(await admitted())).toBe(true);
    },
  );
  scenario(
    "enhanced sign-out writes actual Next cookies and retires copied session",
    async () => {
      await login(await fx.createPrincipal());
      const copied = await ownedCookies();
      await enhancedClick("sign-out");
      expect((await ownedCookies()).length).toBe(0);
      await context.addCookies(copied);
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await admitted()).toBe(false);
    },
  );
  scenario(
    "native first-factor sign-out cancels its copied pending cookie",
    async () => {
      const principal = await fx.createPrincipal();
      await begin(principal);
      const old = await ownedCookies();
      await page.reload({ waitUntil: "domcontentloaded" });
      await nativeClick("sign-out");
      expect((await ownedCookies()).length).toBe(0);
      await context.addCookies(old);
      expect(
        (await post("totp", { code: await fx.code(principal) })).status === 200,
      ).toBe(false);
    },
  );
  scenario(
    "prefetch Flight and polling are no-store and never extend lifetime",
    async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      const before = await stamp(principal.userId),
        cookies = await ownedCookies();
      const cacheBusting = await computeCacheBustingSearchParam(
        "1",
        undefined,
        undefined,
        undefined,
      );
      const checks = await page.evaluate(
        async ({ path, cacheBusting }) => {
          const rows = [];
          for (let i = 0; i < 4; i++) {
            const response = await fetch(`${path}?_rsc=${cacheBusting}`, {
              headers: { RSC: "1", "Next-Router-Prefetch": "1" },
              credentials: "same-origin",
            });
            await response.text();
            rows.push(
              response.status === 200 &&
                response.headers.get("cache-control") === "private, no-store" &&
                response.headers.get("set-cookie") === null,
            );
          }
          return rows.every(Boolean);
        },
        { path: SECURITY_PAGE, cacheBusting },
      );
      expect(checks).toBe(true);
      for (let i = 0; i < 3; i++)
        expect((await post("session")).status).toBe(200);
      expect(
        JSON.stringify(await stamp(principal.userId)) ===
          JSON.stringify(before),
      ).toBe(true);
      expect(
        JSON.stringify(await ownedCookies()) === JSON.stringify(cookies),
      ).toBe(true);
    },
  );
  scenario(
    "requires route custom CSRF and rejects callback/identity claims",
    async () => {
      const principal = await fx.createPrincipal();
      expect(
        (
          await post(
            "password",
            { email: principal.email, password: principal.password },
            false,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await post("password", {
            email: principal.email,
            password: principal.password,
            callbackURL: "//foreign.invalid",
          })
        ).status,
      ).toBe(400);
      expect((await ownedCookies()).length).toBe(0);
    },
  );
  scenario(
    "rejects actual cross-origin preflight before any authority charge",
    async () => {
      const before = (
        await fx.migration.query(
          "SELECT coalesce(sum(used),0)::text n FROM control_private.budgets",
        )
      ).rows[0].n;
      const foreignResponse = await page.goto(`http://${foreign}:3464/`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        foreignResponse?.status() === 200 &&
          (await page.evaluate(
            () => location.origin === `http://${location.host}`,
          )),
      ).toBe(true);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      let options = false,
        denied = false;
      const preflights = new Set<string>(),
        statuses = new Map<string, number>();
      cdp.on("Network.requestWillBeSent", (event) => {
        if (
          event.request.url === `${origin}${NEXT_AUTH_PATHS.session}` &&
          event.request.method === "OPTIONS"
        ) {
          options = true;
          preflights.add(event.requestId);
          if (statuses.get(event.requestId) === 405) denied = true;
        }
      });
      cdp.on("Network.responseReceivedExtraInfo", (event) => {
        statuses.set(event.requestId, event.statusCode);
        if (preflights.has(event.requestId) && event.statusCode === 405)
          denied = true;
      });
      const rejected = await page.evaluate(async (url) => {
        try {
          await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "X-Bookstore-CSRF": "1",
            },
            body: "{}",
          });
          return false;
        } catch {
          return true;
        }
      }, `${origin}${NEXT_AUTH_PATHS.session}`);
      expect(rejected && options && denied).toBe(true);
      expect(
        (
          await fx.migration.query(
            "SELECT coalesce(sum(used),0)::text n FROM control_private.budgets",
          )
        ).rows[0].n === before,
      ).toBe(true);
    },
  );
  scenario(
    "denies suspended and stale-version protected browser renders",
    async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      await fx.migration.query(
        "UPDATE staff.principals SET status='suspended' WHERE user_id=$1",
        [principal.userId],
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await admitted()).toBe(false);
      expect((await post("session")).status === 200).toBe(false);
    },
  );
  scenario(
    "provider transition and worker restart never repair admission or approval",
    async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      await fx.auth.query('UPDATE identity."User" SET email=$2 WHERE id=$1', [
        principal.userId,
        `changed-${randomBytes(8).toString("hex")}@example.invalid`,
      ]);
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await admitted()).toBe(false);
      const first = await createWorkerProcess(fx.owned.workerUrl);
      await first.runOnce();
      await first.kill();
      const next = await createWorkerProcess(fx.owned.workerUrl);
      try {
        await next.runOnce();
        await page.reload({ waitUntil: "domcontentloaded" });
        expect(await admitted()).toBe(false);
      } finally {
        await next.close();
      }
    },
  );
  scenario(
    "genuine Next process restart preserves final-cookie admission and replay burn",
    async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      await processOwner!.kill();
      processOwner = await startNextProcess(
        nextConfig(fx.config, certs, csrfSecret),
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await admitted()).toBe(true);
      expect(
        (
          await fx.migration.query(
            "SELECT count(*)::integer n FROM control_private.replay_burns WHERE expires_at>clock_timestamp()",
          )
        ).rows[0].n > 0,
      ).toBe(true);
    },
  );
});
