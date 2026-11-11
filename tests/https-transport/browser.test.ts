import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer, type Server } from "node:http";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { startRestrictedHttpsTestTransport } from "../../src/server/security/https-transport";
import {
  TRANSPORT_PATHS,
  TEST_PROBE_PATH,
} from "../../src/server/security/https-transport-policy";
import {
  ControlFixtures,
  secretSafe,
  type SyntheticPrincipal,
} from "../admission-controls/fixtures";
import {
  ALIAS_HOST,
  TRANSPORT_HOST,
  createTransportCertificates,
  prepareLinuxBrowserTrust,
  type CertificatePeer,
  type TransportCertificateFixture,
} from "./certificates";

if (process.platform !== "linux")
  throw new Error(
    "HTTPS browser acceptance requires Linux isolated NSS trust.",
  );

const origin = `https://${TRANSPORT_HOST}:3443`;
const foreignHost = "foreign-transport.invalid";
const prefix = "__Secure-bookstore-provider-proof.";
const sessionName = `${prefix}session_token`;
const challengeName = `${prefix}two_factor`;
const fx = new ControlFixtures();
let certificates: TransportCertificateFixture;
let transport: Awaited<ReturnType<typeof startRestrictedHttpsTestTransport>>;
let context: BrowserContext | undefined;
let page: Page;
const contexts = new Set<BrowserContext>();
const peers = new Set<Server>();
let plainCookiePresent = false;
let plainRequests = 0;
let plain: Server;

// Assertion values are ALWAYS booleans, counts or static status/state strings.
// No auth-flow tracing, video, screenshots, storage-state or raw browser errors.
const scenario = (name: string, run: () => Promise<void>) =>
  it(name, () => secretSafe(run));
async function launch(trusted: boolean, fixture = certificates) {
  const profile = await prepareLinuxBrowserTrust(fixture, trusted);
  try {
    const browser = await chromium.launchPersistentContext(
      profile.userDataDir,
      {
        executablePath: chromium.executablePath(),
        headless: true,
        env: profile.env,
        ignoreHTTPSErrors: false,
        serviceWorkers: "block",
        acceptDownloads: false,
        args: [
          "--no-proxy-server",
          `--host-resolver-rules=MAP ${TRANSPORT_HOST} 127.0.0.1, MAP ${ALIAS_HOST} 127.0.0.1, MAP ${foreignHost} 127.0.0.1, EXCLUDE localhost`,
        ],
      },
    );
    browser.setDefaultTimeout(10000);
    browser.setDefaultNavigationTimeout(10000);
    contexts.add(browser);
    return browser;
  } catch {
    throw new Error(
      "Isolated Chromium launch unavailable; details suppressed.",
    );
  }
}
async function closeContext(browser: BrowserContext) {
  try {
    await browser.close();
    contexts.delete(browser);
  } catch {
    throw new Error("Isolated Chromium cleanup unavailable.");
  }
}
async function listen(server: Server, port: 3444 | 3445) {
  peers.add(server);
  server.requestTimeout = 5000;
  server.headersTimeout = 3000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    const failed = () =>
      reject(new Error("Owned browser peer bind unavailable."));
    server.once("error", failed);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.removeListener("error", failed);
      resolve();
    });
  });
  server.on("error", () => {});
}
async function closePeer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) =>
      error
        ? reject(new Error("Owned browser peer cleanup unavailable."))
        : resolve(),
    ),
  );
  peers.delete(server);
}
async function withTlsPeer<T>(peer: CertificatePeer, run: () => Promise<T>) {
  let cookiePresent = false;
  const server = createHttpsServer(
    { key: peer.key, cert: peer.cert, minVersion: "TLSv1.3" },
    (req, res) => {
      if (req.url === "/" || req.url === "/same-site-probe")
        cookiePresent ||= !!req.headers.cookie;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        connection: "close",
      });
      res.end("<!doctype html><title>Non-authorizing peer</title>");
    },
  );
  server.on("tlsClientError", () => {});
  await listen(server, 3445);
  try {
    const value = await run();
    return { value, cookiePresent };
  } finally {
    await closePeer(server);
  }
}
async function certificateError(browser: BrowserContext, url: string) {
  const probe = await browser.newPage();
  try {
    await probe.goto(url, { waitUntil: "domcontentloaded" });
    return "accepted";
  } catch (error) {
    const text = error instanceof Error ? error.message : "";
    // Never surface a browser stack, URL/arguments, key or request data.
    if (text.includes("net::ERR_CERT_AUTHORITY_INVALID")) return "authority";
    if (text.includes("net::ERR_CERT_COMMON_NAME_INVALID")) return "name";
    if (text.includes("net::ERR_CERT_DATE_INVALID")) return "date";
    return "unexpected-error";
  } finally {
    await probe.close();
  }
}
async function post(
  route: keyof typeof TRANSPORT_PATHS,
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
        cache: "no-store",
        redirect: "error",
      });
      const data: unknown = await response.json();
      const value =
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : {};
      const state =
        typeof value.state === "string" &&
        [
          "mfa-required",
          "verified-test-session",
          "signed-out",
          "denied",
          "rate-limited",
          "unavailable",
        ].includes(value.state)
          ? value.state
          : "invalid-state";
      return {
        status: response.status,
        state,
        minimal:
          Object.keys(value).sort().join(",") ===
            "applicationAdmission,state" &&
          value.applicationAdmission === "disabled",
        noStore: response.headers.get("cache-control") === "private, no-store",
        noRedirect: response.headers.get("location") === null,
        cookieHeaderHidden: response.headers.get("set-cookie") === null,
      };
    },
    { path: TRANSPORT_PATHS[route], body, csrf },
  );
}
async function begin(principal: SyntheticPrincipal) {
  const primary = await post("password", {
    email: principal.email,
    password: principal.password,
  });
  expect(primary.status).toBe(200);
  expect(primary.state).toBe("mfa-required");
  expect(primary.minimal && primary.noStore && primary.noRedirect).toBe(true);
}
async function login(principal: SyntheticPrincipal) {
  await begin(principal);
  const code = await fx.code(principal);
  const verified = await post("totp", { code });
  expect(verified.status).toBe(200);
  expect(verified.state).toBe("verified-test-session");
  expect(verified.minimal && verified.noStore && verified.noRedirect).toBe(
    true,
  );
  return code;
}
async function ownedCookies() {
  return (await context!.cookies(origin)).filter((cookie) =>
    cookie.name.startsWith(prefix),
  );
}
async function admissionSnapshot(principal: SyntheticPrincipal) {
  const result = await fx.migration.query<{
    authenticated: string;
    idle: string;
    deadline: string;
    mfa: string;
  }>(
    `SELECT a.authenticated_at::text AS authenticated,a.last_seen_at::text AS idle,
      c.absolute_deadline::text AS deadline,a.mfa_at::text AS mfa
     FROM staff.admissions a JOIN control_private.session_controls c USING(session_id)
     WHERE a.user_id=$1 AND a.mode='verified' ORDER BY a.authenticated_at DESC LIMIT 1`,
    [principal.userId],
  );
  if (result.rowCount !== 1)
    throw new Error("Synthetic browser admission missing.");
  return result.rows[0];
}
async function ingressUsed() {
  const result = await fx.migration.query<{ used: number }>(
    `SELECT coalesce(sum(used),0)::int AS used FROM control_private.budgets`,
  );
  return result.rows[0].used;
}

beforeAll(() =>
  secretSafe(async () => {
    vi.stubEnv("BOOKSTORE_RESTRICTED_HTTPS_TEST", "1");
    certificates = await createTransportCertificates();
    await fx.start();
    transport = await startRestrictedHttpsTestTransport({
      enabled: true,
      origin,
      ...fx.config,
      tls: {
        key: certificates.key,
        cert: certificates.cert,
        ca: certificates.ca,
      },
    });
    plain = createHttpServer((req, res) => {
      plainRequests++;
      plainCookiePresent ||= !!req.headers.cookie;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        connection: "close",
      });
      // Non-authentication peer: no provider, SQL, CORS or cookie-setting code.
      res.end("<!doctype html><title>Non-authorizing plaintext peer</title>");
    });
    await listen(plain, 3444);
  }),
);
beforeEach(() =>
  secretSafe(async () => {
    await fx.resetScenario();
    plainCookiePresent = false;
    plainRequests = 0;
    context = await launch(true);
    page = await context.newPage();
    const response = await page.goto(`${origin}${TEST_PROBE_PATH}`, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
  }),
);
afterEach(() =>
  secretSafe(async () => {
    if (context) await closeContext(context);
    context = undefined;
  }),
);
afterAll(() =>
  secretSafe(async () => {
    // Close consumers before deleting their marker-owned HOME/NSS/key directories.
    const outcomes = await Promise.allSettled([...contexts].map(closeContext));
    if (outcomes.some((outcome) => outcome.status === "rejected"))
      throw new Error("Isolated browser cleanup failed.");
    for (const peer of [...peers]) await closePeer(peer);
    await transport?.close();
    await fx.stop();
    await certificates?.close();
    vi.unstubAllEnvs();
  }),
);

describe("mandatory real Linux NSS Chromium HTTPS acceptance", () => {
  scenario(
    "rejects the private root in a fresh untrusted browser HOME",
    async () => {
      const untrusted = await launch(false);
      try {
        expect(
          await certificateError(untrusted, `${origin}${TEST_PROBE_PATH}`),
        ).toBe("authority");
      } finally {
        await closeContext(untrusted);
      }
    },
  );
  scenario(
    "accepts the private root only in the isolated trusted browser HOME",
    async () => {
      expect(
        await certificateError(context!, `${origin}${TEST_PROBE_PATH}`),
      ).toBe("accepted");
    },
  );
  for (const [fault, expected] of [
    ["wrongSan", "name"],
    ["expired", "date"],
    ["future", "date"],
  ] as const) {
    scenario(
      `rejects the trusted ${fault} certificate in actual Chromium`,
      async () => {
        const result = await withTlsPeer(certificates.faults[fault], () =>
          certificateError(context!, `https://${TRANSPORT_HOST}:3445/`),
        );
        expect(result.value).toBe(expected);
      },
    );
  }
  scenario(
    "rejects a different private CA despite trusting the original CA",
    async () => {
      const unrelated = await createTransportCertificates();
      try {
        const result = await withTlsPeer(unrelated, () =>
          certificateError(context!, `https://${TRANSPORT_HOST}:3445/`),
        );
        expect(result.value).toBe("authority");
      } finally {
        await unrelated.close();
      }
    },
  );
  scenario(
    "keeps password challenge cookies Secure HttpOnly Strict and host-only",
    async () => {
      const principal = await fx.createPrincipal();
      await begin(principal);
      const cookies = await ownedCookies();
      expect(cookies.length).toBe(1);
      expect(
        cookies.every(
          (cookie) =>
            cookie.name === challengeName &&
            cookie.secure &&
            cookie.httpOnly &&
            cookie.sameSite === "Strict" &&
            cookie.path === "/" &&
            cookie.domain === TRANSPORT_HOST,
        ),
      ).toBe(true);
      expect(await page.evaluate(() => document.cookie === "")).toBe(true);
      expect((await post("session")).status).toBe(401);
    },
  );
  scenario(
    "finalizes real TOTP before delivering the browser session cookie",
    async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      const cookies = await ownedCookies();
      expect(cookies.length).toBe(1);
      expect(
        cookies.every(
          (cookie) =>
            cookie.name === sessionName &&
            cookie.secure &&
            cookie.httpOnly &&
            cookie.sameSite === "Strict" &&
            cookie.path === "/" &&
            cookie.domain === TRANSPORT_HOST,
        ),
      ).toBe(true);
      expect(await page.evaluate(() => document.cookie === "")).toBe(true);
      const checked = await post("session");
      expect(checked.status).toBe(200);
      expect(
        checked.minimal &&
          checked.noStore &&
          checked.noRedirect &&
          checked.cookieHeaderHidden,
      ).toBe(true);
    },
  );
  scenario(
    "denies copied old primary cookie replay after final rotation",
    async () => {
      const principal = await fx.createPrincipal();
      await begin(principal);
      const copied = await ownedCookies();
      const code = await fx.code(principal);
      expect((await post("totp", { code })).status).toBe(200);
      await context!.clearCookies();
      await context!.addCookies(copied);
      expect((await post("totp", { code })).status === 200).toBe(false);
      expect(
        (await ownedCookies()).some((cookie) => cookie.name === sessionName),
      ).toBe(false);
    },
  );
  scenario(
    "cleans an old session cookie before binding a new password challenge",
    async () => {
      await login(await fx.createPrincipal());
      const next = await fx.createPrincipal();
      await begin(next);
      const cookies = await ownedCookies();
      expect(cookies.length === 1 && cookies[0].name === challengeName).toBe(
        true,
      );
      expect((await post("totp", { code: await fx.code(next) })).status).toBe(
        200,
      );
    },
  );
  scenario(
    "never sends host-only authentication cookies to a valid TLS alias",
    async () => {
      await login(await fx.createPrincipal());
      const result = await withTlsPeer(certificates, async () => {
        const alias = await context!.newPage();
        try {
          const response = await alias.goto(`https://${ALIAS_HOST}:3445/`, {
            waitUntil: "domcontentloaded",
          });
          return response?.status() === 200;
        } finally {
          await alias.close();
        }
      });
      expect(result.value).toBe(true);
      expect(result.cookiePresent).toBe(false);
    },
  );
  scenario(
    "withholds Secure cookies on genuine invalid-host plaintext navigation",
    async () => {
      await login(await fx.createPrincipal());
      const insecure = await context!.newPage();
      try {
        const response = await insecure.goto(`http://${TRANSPORT_HOST}:3444/`, {
          waitUntil: "domcontentloaded",
        });
        expect(response?.status()).toBe(200);
        expect(plainRequests > 0).toBe(true);
        expect(plainCookiePresent).toBe(false);
      } finally {
        await insecure.close();
      }
    },
  );
  scenario(
    "sends host cookies to a same-site port but Strict withholds on cross-site navigation",
    async () => {
      await login(await fx.createPrincipal());
      const sameSite = await withTlsPeer(certificates, async () => {
        const probe = await context!.newPage();
        try {
          await probe.goto(`${origin}${TEST_PROBE_PATH}`);
          const [response] = await Promise.all([
            probe.waitForNavigation({ waitUntil: "domcontentloaded" }),
            probe.evaluate((target) => {
              window.location.href = target;
            }, `https://${TRANSPORT_HOST}:3445/same-site-probe`),
          ]);
          return response?.status() === 200;
        } finally {
          await probe.close();
        }
      });
      expect(sameSite.value && sameSite.cookiePresent).toBe(true);
      const crossSite = await withTlsPeer(certificates, async () => {
        const probe = await context!.newPage();
        try {
          await probe.goto(`http://${foreignHost}:3444/`);
          const [response] = await Promise.all([
            probe.waitForNavigation({ waitUntil: "domcontentloaded" }),
            probe.evaluate((target) => {
              window.location.href = target;
            }, `https://${TRANSPORT_HOST}:3445/same-site-probe`),
          ]);
          return response?.status() === 200;
        } finally {
          await probe.close();
        }
      });
      expect(crossSite.value).toBe(true);
      expect(crossSite.cookiePresent).toBe(false);
    },
  );
  scenario(
    "rejects cross-site custom-header fetch without a SQL budget charge",
    async () => {
      await login(await fx.createPrincipal());
      const before = await ingressUsed();
      const foreign = await context!.newPage();
      const network = await context!.newCDPSession(foreign);
      const preflightIds = new Set<string>();
      const responseStatuses = new Map<string, number>();
      const target = `${origin}${TRANSPORT_PATHS.signOut}`;
      let preflightDenied = false;
      await network.send("Network.enable");
      network.on("Network.requestWillBeSent", (event) => {
        if (
          event.request.url === target &&
          event.request.method === "OPTIONS"
        ) {
          preflightIds.add(event.requestId);
          if (responseStatuses.get(event.requestId) === 405)
            preflightDenied = true;
        }
      });
      network.on("Network.responseReceivedExtraInfo", (event) => {
        // Retain only request correlation and numeric status, never headers.
        responseStatuses.set(event.requestId, event.statusCode);
        if (preflightIds.has(event.requestId) && event.statusCode === 405)
          preflightDenied = true;
      });
      try {
        expect(
          (await foreign.goto(`http://${foreignHost}:3444/`))?.status(),
        ).toBe(200);
        const denied = await foreign.evaluate(async (target) => {
          try {
            await fetch(target, {
              method: "POST",
              credentials: "include",
              headers: {
                "content-type": "application/json",
                "X-Bookstore-CSRF": "1",
              },
              body: "{}",
            });
            return false;
          } catch {
            return true;
          }
        }, target);
        expect(denied).toBe(true);
        expect(preflightDenied).toBe(true);
        expect((await ingressUsed()) === before).toBe(true);
        expect((await post("session")).status).toBe(200);
      } finally {
        await network.detach();
        await foreign.close();
      }
    },
  );
  scenario(
    "requires the custom CSRF header for same-origin browser POST",
    async () => {
      const before = await ingressUsed();
      expect((await post("session", {}, false)).status).toBe(403);
      expect((await ingressUsed()) === before).toBe(true);
    },
  );
  scenario(
    "keeps repeated session status reads from touching idle or epoch",
    async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      const before = await admissionSnapshot(principal);
      for (let i = 0; i < 3; i++)
        expect((await post("session")).status).toBe(200);
      const after = await admissionSnapshot(principal);
      expect(JSON.stringify(after) === JSON.stringify(before)).toBe(true);
    },
  );
  scenario(
    "step-up uses a fresh maintained TOTP without resetting login or idle origin",
    async () => {
      const principal = await fx.createPrincipal();
      const used = await login(principal);
      const before = await admissionSnapshot(principal);
      const fresh = await fx.code(principal, 1);
      expect(fresh !== used).toBe(true);
      expect((await post("stepUp", { code: fresh })).status).toBe(200);
      const after = await admissionSnapshot(principal);
      expect(
        after.authenticated === before.authenticated &&
          after.idle === before.idle &&
          after.deadline === before.deadline,
      ).toBe(true);
      expect((await post("stepUp", { code: fresh })).status === 200).toBe(
        false,
      );
    },
  );
  scenario(
    "clears admitted cookies and durably denies a copied session after sign-out",
    async () => {
      await login(await fx.createPrincipal());
      const copied = await ownedCookies();
      expect((await post("signOut")).status).toBe(200);
      expect((await ownedCookies()).length).toBe(0);
      await context!.addCookies(copied);
      expect((await post("session")).status === 200).toBe(false);
    },
  );
  scenario(
    "cancels a first-factor challenge and denies its copied cookie",
    async () => {
      const principal = await fx.createPrincipal();
      await begin(principal);
      const copied = await ownedCookies();
      expect((await post("signOut")).status).toBe(200);
      expect((await ownedCookies()).length).toBe(0);
      await context!.addCookies(copied);
      expect(
        (await post("totp", { code: await fx.code(principal) })).status === 200,
      ).toBe(false);
      expect(
        (await ownedCookies()).some((cookie) => cookie.name === sessionName),
      ).toBe(false);
    },
  );
  scenario(
    "denies browser session state after a current authorization-version change",
    async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      await fx.migration.query(
        "UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=$1",
        [principal.userId],
      );
      expect((await post("session")).status === 200).toBe(false);
    },
  );
  scenario(
    "denies browser session state while a relevant durable event is pending",
    async () => {
      const principal = await fx.createPrincipal();
      await login(principal);
      await fx.migration.query(
        "INSERT INTO audit.provider_events(user_id,kind,invalidates_user) VALUES($1,'identity.changed',true)",
        [principal.userId],
      );
      expect((await post("session")).status === 200).toBe(false);
    },
  );
  scenario(
    "rejects browser callback and identity claims with no new cookie",
    async () => {
      const principal = await fx.createPrincipal();
      const response = await post("password", {
        email: principal.email,
        password: principal.password,
        callbackURL: "https://foreign-transport.invalid/",
        userId: "forged",
      });
      expect(response.status).toBe(400);
      expect((await ownedCookies()).length).toBe(0);
    },
  );
});
