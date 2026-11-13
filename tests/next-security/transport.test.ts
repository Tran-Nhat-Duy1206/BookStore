import { createHash, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeCacheBustingSearchParam } from "next/dist/shared/lib/router/utils/cache-busting-search-param";
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
  NEXT_AUTH_PATHS,
  SECURITY_PAGE,
} from "../../experiments/next-security/wire";
import {
  NextWireClient,
  nativeAction,
  nextConfig,
  startNextProcess,
  type NextProcess,
  type NextWireOptions,
  type NextWireResponse,
} from "./client";
import { createWorkerProcess } from "./worker-client";

/** Actual CA-validated Node HTTPS/header replay; NEVER browser cookie evidence. */
const fx = new ControlFixtures();
let certs: TransportCertificateFixture;
let main: NextProcess | undefined;
const csrfSecret = randomBytes(48).toString("base64url");
const scenario = (name: string, work: () => Promise<void>) =>
  it(name, () => secretSafe(work));
const client = (port: 3463 | 3465 = 3463) => new NextWireClient(certs.ca, port);
const config = (port: 3463 | 3465 = 3463) =>
  nextConfig(fx.config, certs, csrfSecret, port);
function admitted(response: NextWireResponse): boolean {
  return response.body.includes('data-live-guard="admitted-test-session"');
}
function denied(response: NextWireResponse): boolean {
  return response.body.includes('data-live-guard="denied-test-session"');
}
function safe(response: NextWireResponse): boolean {
  return response.authorized && response.noStore && !response.location;
}
function positiveCookie(response: NextWireResponse): boolean {
  return response.cookies.some(
    (line) =>
      !/;\s*max-age=0(?:;|$)/i.test(line) &&
      line.split(";", 1)[0].split("=").slice(1).join("=") !== "",
  );
}
function allCleared(response: NextWireResponse): boolean {
  return (
    response.cookies.length === 5 &&
    response.cookies.every(
      (line) =>
        /;\s*max-age=0(?:;|$)/i.test(line) &&
        /;\s*path=\/(?:;|$)/i.test(line) &&
        /;\s*secure(?:;|$)/i.test(line) &&
        /;\s*httponly(?:;|$)/i.test(line) &&
        /;\s*samesite=strict(?:;|$)/i.test(line) &&
        !/;\s*domain=/i.test(line),
    )
  );
}
async function admissions(userId?: string): Promise<number> {
  const result = userId
    ? await fx.migration.query<{ n: number }>(
        "SELECT count(*)::integer n FROM staff.admissions WHERE user_id=$1 AND mode='verified'",
        [userId],
      )
    : await fx.migration.query<{ n: number }>(
        "SELECT count(*)::integer n FROM staff.admissions WHERE mode='verified'",
      );
  return result.rows[0].n;
}
async function immutableOrigins(userId: string): Promise<string> {
  const rows = await fx.migration.query(
    "SELECT a.authenticated_at::text admission_authenticated,a.last_seen_at::text last_seen,c.authenticated_at::text control_authenticated,c.absolute_deadline::text absolute_deadline,c.epoch_id::text epoch FROM staff.admissions a JOIN control_private.session_controls c USING(session_id) WHERE a.user_id=$1 ORDER BY a.session_id",
    [userId],
  );
  return createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex");
}
async function lifetime(userId: string): Promise<string> {
  const rows = await fx.migration.query(
    "SELECT a.authenticated_at::text,a.last_seen_at::text,a.mfa_at::text,c.absolute_deadline::text,c.authz_version::text,c.epoch_id::text FROM staff.admissions a JOIN control_private.session_controls c USING(session_id) WHERE a.user_id=$1 ORDER BY a.session_id",
    [userId],
  );
  return createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex");
}
/** Digest witnesses are compared only as booleans, never rendered on failure. */
async function witness(): Promise<string> {
  const result = await fx.migration.query(`SELECT jsonb_build_object(
    'budgets',(SELECT coalesce(jsonb_agg(jsonb_build_array(used,window_start,window_end) ORDER BY used,window_start,window_end),'[]'::jsonb) FROM control_private.budgets),
    'clock',(SELECT high_water::text FROM control_private.clock_state WHERE singleton),
    'audit',(SELECT count(*) FROM audit.events),'provider_events',(SELECT count(*) FROM audit.provider_events),
    'sessions',(SELECT count(*) FROM identity."Session"),'attempts',(SELECT count(*) FROM control_private.attempts)) value`);
  return createHash("sha256")
    .update(JSON.stringify(result.rows[0].value))
    .digest("hex");
}
async function primary(principal?: SyntheticPrincipal, wire = client()) {
  const p = principal ?? (await fx.createPrincipal());
  const result = await wire.post("password", {
    email: p.email,
    password: p.password,
  });
  expect(result.status).toBe(200);
  expect(result.state).toBe("mfa-required");
  expect(safe(result) && result.disabled).toBe(true);
  return { principal: p, client: wire, challenge: wire.jar.header };
}
async function login(wire = client()) {
  const prepared = await primary(await fx.createPrincipal(), wire);
  const code = await fx.code(prepared.principal);
  const result = await wire.post("totp", { code });
  expect(result.status).toBe(200);
  expect(result.state).toBe("verified-test-session");
  expect(safe(result) && result.disabled && positiveCookie(result)).toBe(true);
  return { ...prepared, code };
}
async function actionRef(
  wire: NextWireClient,
  purpose: "probe" | "revoke-self" | "sign-out",
) {
  const page = await wire.page();
  expect(safe(page) && page.cookies.length === 0).toBe(true);
  const reference = nativeAction(page.body, purpose);
  if (!reference) throw new Error("Synthetic native Action reference missing.");
  return reference;
}
async function wrongCodes(
  p: SyntheticPrincipal,
  count: number,
): Promise<string[]> {
  const valid = new Set([
    await fx.code(p, -1),
    await fx.code(p),
    await fx.code(p, 1),
  ]);
  const values = Array.from({ length: count + 3 }, (_, index) =>
    String(100000 + index),
  )
    .filter((value) => !valid.has(value))
    .slice(0, count);
  if (values.length !== count)
    throw new Error("Synthetic incorrect codes unavailable.");
  return values;
}
async function badRequest(
  wire: NextWireClient,
  path: string,
  body = "{}",
  options: NextWireOptions = {},
): Promise<void> {
  const result = await wire.send(path, body, {
    ...options,
    method: options.method ?? "POST",
  });
  expect(
    result.status >= 400 &&
      result.status < 500 &&
      result.cookies.length === 0 &&
      !result.location,
  ).toBe(true);
}
async function fault(
  kind:
    | "login-audit"
    | "session-insert"
    | "factor-update"
    | "session-delete"
    | "cancel-audit",
  work: () => Promise<void>,
) {
  const trigger: Record<typeof kind, string> = {
    "login-audit":
      "CREATE TRIGGER next_transport_fault BEFORE INSERT ON audit.events FOR EACH ROW WHEN(NEW.action='control.login') EXECUTE FUNCTION public.next_transport_fault()",
    "session-insert":
      'CREATE TRIGGER next_transport_fault BEFORE INSERT ON identity."Session" FOR EACH ROW EXECUTE FUNCTION public.next_transport_fault()',
    "factor-update":
      'CREATE TRIGGER next_transport_fault BEFORE UPDATE ON identity."TwoFactor" FOR EACH ROW EXECUTE FUNCTION public.next_transport_fault()',
    "session-delete":
      'CREATE TRIGGER next_transport_fault BEFORE DELETE ON identity."Session" FOR EACH ROW EXECUTE FUNCTION public.next_transport_fault()',
    "cancel-audit":
      "CREATE TRIGGER next_transport_fault BEFORE INSERT ON audit.events FOR EACH ROW WHEN(NEW.action='transport.cancel') EXECUTE FUNCTION public.next_transport_fault()",
  };
  const table =
    kind === "session-insert" || kind === "session-delete"
      ? 'identity."Session"'
      : kind === "factor-update"
        ? 'identity."TwoFactor"'
        : "audit.events";
  let created = false,
    triggered = false;
  try {
    await fx.migration.query(
      "CREATE FUNCTION public.next_transport_fault() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'Synthetic Next persistence fault' USING ERRCODE='P0001'; END $$",
    );
    created = true;
    await fx.migration.query(
      "REVOKE ALL ON FUNCTION public.next_transport_fault() FROM PUBLIC",
    );
    await fx.migration.query(trigger[kind]);
    triggered = true;
    await work();
  } finally {
    if (triggered)
      await fx.migration.query(`DROP TRIGGER next_transport_fault ON ${table}`);
    if (created)
      await fx.migration.query("DROP FUNCTION public.next_transport_fault()");
  }
}

beforeAll(() =>
  secretSafe(async () => {
    certs = await createTransportCertificates();
    await fx.start();
  }),
);
beforeEach(() =>
  secretSafe(async () => {
    await main?.close();
    main = undefined;
    await fx.resetScenario();
    // Independent scenario boundary, NEVER a limiter reset within any attack/race.
    main = await startNextProcess(config());
  }),
);
afterAll(() =>
  secretSafe(async () => {
    await main?.close();
    await fx.stop();
    await certs?.close();
  }),
);

describe("isolated production-built Next actual HTTPS authority (Node replay, not browser proof)", () => {
  scenario(
    "anonymous RSC is live-denied and exposes only deny-only signout",
    async () => {
      const page = await client().page();
      expect(
        safe(page) &&
          denied(page) &&
          !admitted(page) &&
          page.cookies.length === 0,
      ).toBe(true);
      expect(
        nativeAction(page.body, "probe") === null &&
          nativeAction(page.body, "revoke-self") === null &&
          nativeAction(page.body, "sign-out") !== null,
      ).toBe(true);
    },
  );
  scenario(
    "password-only native challenge never grants RSC admission",
    async () => {
      const entry = await primary();
      const page = await entry.client.page();
      expect(denied(page) && !admitted(page) && page.cookies.length === 0).toBe(
        true,
      );
      expect(await admissions(entry.principal.userId)).toBe(0);
    },
  );
  scenario(
    "actual password and TOTP commit before Route success and admitted RSC",
    async () => {
      const entry = await login();
      const session = await entry.client.post("session");
      const page = await entry.client.page();
      expect(
        session.status === 200 &&
          session.state === "verified-test-session" &&
          session.cookies.length === 0 &&
          session.disabled,
      ).toBe(true);
      expect(safe(page) && admitted(page) && page.cookies.length === 0).toBe(
        true,
      );
      expect(await admissions(entry.principal.userId)).toBe(1);
    },
  );
  scenario(
    "step-up uses fresh maintained code and final native jar without lifetime reset",
    async () => {
      const entry = await login();
      const before = await immutableOrigins(entry.principal.userId);
      const candidates = [
        await fx.code(entry.principal, -1),
        await fx.code(entry.principal, 1),
      ];
      const freshCode = candidates.find((code) => code !== entry.code);
      if (!freshCode)
        throw new Error("Synthetic fresh maintained code unavailable.");
      const result = await entry.client.post("stepUp", { code: freshCode });
      expect(
        result.status === 200 &&
          result.state === "verified-test-session" &&
          result.disabled,
      ).toBe(true);
      const row = await fx.migration.query<{ safe: boolean }>(
        "SELECT a.authenticated_at=c.authenticated_at AND c.absolute_deadline=c.authenticated_at+interval '8 hours' safe FROM staff.admissions a JOIN control_private.session_controls c USING(session_id) WHERE a.user_id=$1",
        [entry.principal.userId],
      );
      expect(
        row.rows.length === 1 &&
          row.rows[0].safe &&
          admitted(await entry.client.page()),
      ).toBe(true);
      // MFA recency may advance; read-only boundaries are covered independently.
      expect((await immutableOrigins(entry.principal.userId)) === before).toBe(
        true,
      );
    },
  );
  scenario(
    "copied stale primary jar cannot replace the finalized session",
    async () => {
      const entry = await login();
      const response = await entry.client.page({
        cookie: entry.challenge,
        absorb: false,
      });
      expect(
        denied(response) &&
          !admitted(response) &&
          response.cookies.length === 0,
      ).toBe(true);
    },
  );
  scenario(
    "Route signout clears every scope and copied old session remains denied",
    async () => {
      const entry = await login();
      const copied = entry.client.jar.header;
      const result = await entry.client.post("signOut");
      expect(
        result.status === 200 &&
          result.state === "signed-out" &&
          allCleared(result) &&
          entry.client.jar.size === 0,
      ).toBe(true);
      expect(
        (
          await entry.client.post(
            "session",
            {},
            { cookie: copied, absorb: false },
          )
        ).status,
      ).toBe(401);
    },
  );
  for (const enhanced of [false, true]) {
    scenario(
      `${enhanced ? "Flight" : "native multipart"} direct probe Action rechecks a genuine admitted session`,
      async () => {
        const entry = await login();
        const ref = await actionRef(entry.client, "probe");
        const result = await entry.client.action(
          ref.id,
          ref.csrf,
          {},
          enhanced,
        );
        expect(
          result.status === 200 && safe(result) && result.cookies.length === 0,
        ).toBe(true);
        expect(admitted(await entry.client.page())).toBe(true);
      },
    );
    scenario(
      `${enhanced ? "Flight" : "native multipart"} self-revoke Action targets only server-resolved self`,
      async () => {
        const entry = await login();
        const ref = await actionRef(entry.client, "revoke-self");
        const result = await entry.client.action(
          ref.id,
          ref.csrf,
          {},
          enhanced,
        );
        expect(result.status === 200 && safe(result)).toBe(true);
        expect(denied(await entry.client.page())).toBe(true);
        expect((await entry.client.post("session")).status).toBe(401);
      },
    );
    scenario(
      `${enhanced ? "Flight" : "native multipart"} signout Action writes actual Next cookie deletions`,
      async () => {
        const entry = await login();
        const copied = entry.client.jar.header;
        const ref = await actionRef(entry.client, "sign-out");
        const result = await entry.client.action(
          ref.id,
          ref.csrf,
          {},
          enhanced,
        );
        expect(
          result.status === 200 &&
            safe(result) &&
            allCleared(result) &&
            entry.client.jar.size === 0,
        ).toBe(true);
        expect(
          (
            await entry.client.post(
              "session",
              {},
              { cookie: copied, absorb: false },
            )
          ).status,
        ).toBe(401);
      },
    );
  }
  scenario(
    "missing null foreign and wrong-port Origin perform no cancellation or cookie clearing",
    async () => {
      const entry = await login();
      const ref = await actionRef(entry.client, "sign-out");
      const jar = entry.client.jar.header;
      const before = await witness();
      for (const origin of [
        null,
        "null",
        "https://foreign.invalid",
        "https://bookstore-transport.invalid:3465",
      ]) {
        const result = await entry.client.action(ref.id, ref.csrf, {
          headers: { Origin: origin },
        });
        expect(
          result.status === 403 &&
            result.cookies.length === 0 &&
            entry.client.jar.header === jar,
        ).toBe(true);
      }
      expect((await witness()) === before).toBe(true);
    },
  );
  scenario(
    "missing or invalid JSON CSRF header denies before any protected change",
    async () => {
      const entry = await login();
      const jar = entry.client.jar.header;
      const before = await witness();
      for (const csrf of [null, "0", "true", "1,1"])
        await badRequest(entry.client, NEXT_AUTH_PATHS.signOut, "{}", {
          headers: { "X-Bookstore-CSRF": csrf },
        });
      expect(
        entry.client.jar.header === jar && (await witness()) === before,
      ).toBe(true);
    },
  );
  scenario(
    "missing malformed and expired syntactic Action CSRF never clear cookies",
    async () => {
      const entry = await login();
      const ref = await actionRef(entry.client, "sign-out");
      const jar = entry.client.jar.header;
      const before = await witness();
      for (const csrf of [
        "",
        "invalid",
        `v1.1000000000000.${"a".repeat(32)}.${"b".repeat(64)}`,
      ]) {
        const result = await entry.client.action(ref.id, csrf);
        expect(
          [400, 403, 500].includes(result.status) &&
            result.cookies.length === 0 &&
            entry.client.jar.header === jar,
        ).toBe(true);
      }
      expect((await witness()) === before).toBe(true);
    },
  );
  scenario("a probe-purpose nonce cannot invoke signout", async () => {
    const entry = await login();
    const probe = await actionRef(entry.client, "probe");
    const signout = await actionRef(entry.client, "sign-out");
    const before = await witness();
    const result = await entry.client.action(signout.id, probe.csrf);
    expect(
      [403, 500].includes(result.status) && result.cookies.length === 0,
    ).toBe(true);
    expect((await witness()) === before).toBe(true);
    expect(admitted(await entry.client.page())).toBe(true);
  });
  scenario(
    "another genuine cookie jar cannot reuse a nonce or forged account target",
    async () => {
      const first = await login();
      const second = await login();
      const nativePrimary = await primary(first.principal, client());
      const validFirst = new Set([
        await fx.code(first.principal, -1),
        await fx.code(first.principal),
        await fx.code(first.principal, 1),
      ]);
      const otherCodes = [
        await fx.code(second.principal, -1),
        await fx.code(second.principal),
        await fx.code(second.principal, 1),
      ];
      const substituted = otherCodes.find((code) => !validFirst.has(code));
      if (!substituted)
        throw new Error(
          "Synthetic cross-account code collision prevented test.",
        );
      const invalidFactor = await nativePrimary.client.post("totp", {
        code: substituted,
      });
      expect(
        invalidFactor.status === 403 &&
          invalidFactor.cookies.length === 0 &&
          (await admissions(first.principal.userId)) === 1,
      ).toBe(true);
      const ref = await actionRef(first.client, "revoke-self");
      const before = await witness();
      const result = await second.client.action(ref.id, ref.csrf);
      expect(
        [403, 500].includes(result.status) &&
          result.cookies.length === 0 &&
          (await witness()) === before,
      ).toBe(true);
      expect(
        admitted(await first.client.page()) &&
          admitted(await second.client.page()),
      ).toBe(true);
    },
  );
  scenario(
    "Action user role session target callback and redirect fields are rejected before SDK or SQL",
    async () => {
      const entry = await login();
      const ref = await actionRef(entry.client, "revoke-self");
      const before = await witness();
      for (const field of [
        "actor",
        "user",
        "role",
        "session",
        "target",
        "returnTo",
        "next",
        "callbackURL",
      ]) {
        const result = await entry.client.action(ref.id, ref.csrf, {}, false, {
          [field]: "synthetic-forbidden",
        });
        expect(result.status === 400 && result.cookies.length === 0).toBe(true);
      }
      expect((await witness()) === before).toBe(true);
    },
  );
  scenario(
    "unknown bound duplicate and File native Action metadata cannot forward internally",
    async () => {
      const entry = await login();
      const ref = await actionRef(entry.client, "probe");
      const before = await witness();
      const boundary = "SyntheticNextNegativeBoundary";
      const field = (name: string, value: string, file = false) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file ? '; filename="synthetic.txt"' : ""}\r\n\r\n${value}\r\n`;
      const bodies = [
        field(`$ACTION_ID_${"f".repeat(40)}`, "") + field("csrf", ref.csrf),
        field("$ACTION_REF_0", "") + field("csrf", ref.csrf),
        field(`$ACTION_ID_${ref.id}`, "") +
          field("csrf", ref.csrf) +
          field("csrf", ref.csrf),
        field(`$ACTION_ID_${ref.id}`, "") + field("csrf", ref.csrf, true),
      ];
      for (const body of bodies)
        await badRequest(
          entry.client,
          SECURITY_PAGE,
          body + `--${boundary}--\r\n`,
          {
            headers: {
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
            },
          },
        );
      const enhanced = await entry.client.action(
        "f".repeat(40),
        ref.csrf,
        {},
        true,
      );
      expect(
        enhanced.status === 403 &&
          enhanced.cookies.length === 0 &&
          (await witness()) === before,
      ).toBe(true);
      expect(
        !main?.logContains("forwarded Server Actions") &&
          !main?.logContains("ECONNREFUSED"),
      ).toBe(true);
    },
  );
  scenario(
    "canonical JSON exact schemas reject claims aliases duplicate keys and nested values",
    async () => {
      const wire = client();
      const before = await witness();
      for (const body of [
        '{"actor":"synthetic"}',
        '{"role":"Owner"}',
        '{"session":"synthetic"}',
        '{"returnTo":"/"}',
        '{"csrf":{}}',
        '{"code":"000000","code":"000000"}',
        '{"\\u0063ode":"000000"}',
        '{"code":"000000", "trustDevice":true}',
        "[]",
        "null",
        "{",
      ]) {
        const result = await wire.send(NEXT_AUTH_PATHS.totp, body, {
          method: "POST",
        });
        expect(result.status === 400 && result.cookies.length === 0).toBe(true);
      }
      expect((await witness()) === before).toBe(true);
    },
  );
  scenario(
    "raw encoded dot case slash query and callback aliases never reach a facade",
    async () => {
      const wire = client();
      const before = await witness();
      for (const path of [
        "/__bookstore_next_auth/%73ession",
        "/__bookstore_next_auth/%2573ession",
        "/__bookstore_next_auth/../session",
        "/__bookstore_next_auth//session",
        "/__bookstore_next_auth/session/",
        "/__BOOKSTORE_next_auth/session",
        "/__bookstore_next_auth/session?next=/",
        "/__bookstore_next_auth%2fsession",
        "/__bookstore_next_security?actor=synthetic",
        "/__bookstore_next_security?_rsc=bad&next=/",
      ])
        await badRequest(wire, path);
      expect((await witness()) === before).toBe(true);
    },
  );
  scenario(
    "HEAD OPTIONS GET native SDK enrollment recovery and callback endpoints stay closed",
    async () => {
      const wire = client();
      const before = await witness();
      for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"])
        await badRequest(wire, NEXT_AUTH_PATHS.session, "", { method });
      for (const path of [
        "/api/auth/sign-in/email",
        "/api/unmounted-provider-proof/sign-in/email",
        "/__bookstore_next_auth/sign-up",
        "/__bookstore_next_auth/two-factor/enable",
        "/__bookstore_next_auth/recovery",
        "/__bookstore_next_auth/callback",
        "/__bookstore_test_auth/session",
      ])
        await badRequest(wire, path);
      expect((await witness()) === before).toBe(true);
    },
  );
  scenario(
    "supplied proxy identity override tracing and internal Next headers deny before protected changes",
    async () => {
      const wire = client();
      const before = await witness();
      for (const name of [
        "Forwarded",
        "X-Forwarded-Host",
        "X-Forwarded-Proto",
        "X-Forwarded-For",
        "X-Real-IP",
        "X-Action-Forwarded",
        "X-Middleware-Subrequest",
        "X-Nextjs-Revalidated-Tag-Token",
        "X-HTTP-Method-Override",
        "Traceparent",
        "Baggage",
      ])
        await badRequest(wire, NEXT_AUTH_PATHS.session, "{}", {
          headers: { [name]: "synthetic" },
        });
      expect((await witness()) === before).toBe(true);
    },
  );
  scenario(
    "duplicate Host Origin Cookie and CL plus TE parser ambiguity fail without protected changes",
    async () => {
      const wire = client();
      const before = await witness();
      for (const extraHeaders of [
        ["Host", "bookstore-transport.invalid:3463"],
        ["Origin", wire.origin],
        ["Content-Length", "2"],
        ["Cookie", "a=b", "Cookie", "a=b"],
        ["Transfer-Encoding", "chunked"],
      ]) {
        const result = await wire.send(NEXT_AUTH_PATHS.session, "{}", {
          method: "POST",
          extraHeaders,
        });
        expect(
          [400, 403].includes(result.status) && result.cookies.length === 0,
        ).toBe(true);
      }
      expect((await witness()) === before).toBe(true);
    },
  );
  scenario(
    "invalid Host content type oversized UTF8 and compressed bodies fail before SDK admission",
    async () => {
      const wire = client();
      const before = await witness();
      for (const host of [
        "localhost:3463",
        "bookstore-transport.invalid:3465",
        "other.bookstore-transport.invalid:3463",
      ])
        await badRequest(wire, NEXT_AUTH_PATHS.session, "{}", {
          headers: { Host: host },
        });
      for (const type of [
        "text/plain",
        "application/x-www-form-urlencoded",
        "application/json; charset=latin1",
      ])
        await badRequest(wire, NEXT_AUTH_PATHS.session, "{}", {
          headers: { "Content-Type": type },
        });
      await badRequest(wire, NEXT_AUTH_PATHS.session, "x".repeat(1025));
      const invalid = await wire.send(
        NEXT_AUTH_PATHS.session,
        Buffer.from([123, 255, 125]),
        { method: "POST" },
      );
      expect(invalid.status === 400 && invalid.cookies.length === 0).toBe(true);
      await badRequest(wire, NEXT_AUTH_PATHS.session, "{}", {
        headers: { "Content-Encoding": "gzip" },
      });
      expect((await witness()) === before).toBe(true);
    },
  );
  scenario(
    "HTML Flight and private child errors never disclose provider credentials or evidence",
    async () => {
      const entry = await login();
      const page = await entry.client.page();
      const ref = nativeAction(page.body, "probe");
      if (!ref) throw new Error("Synthetic Action reference missing.");
      const response = await entry.client.action(ref.id, ref.csrf, {}, true);
      const forbidden = [
        entry.principal.password,
        entry.principal.secret,
        entry.principal.userId,
        entry.principal.generationId,
        entry.code,
        fx.secret,
        csrfSecret,
        ...entry.client.jar.header
          .split("; ")
          .map((value) => value.slice(value.indexOf("=") + 1)),
      ].filter(Boolean);
      expect(
        forbidden.every(
          (value) =>
            !page.body.includes(value) &&
            !response.body.includes(value) &&
            !main?.logContains(value),
        ),
      ).toBe(true);
      expect(
        !page.body.includes("evidenceHandle") &&
          !response.body.includes("evidenceHandle"),
      ).toBe(true);
    },
  );
  scenario(
    "session polling RSC prefetch and probe Action never advance authentication idle or deadline origins",
    async () => {
      const entry = await login();
      const ref = await actionRef(entry.client, "probe");
      const before = await lifetime(entry.principal.userId);
      // Maintained Next protocol metadata: arbitrary hashes provoke its protective
      // redirect, which this harness deliberately forbids. Never disable validation.
      const rsc = await computeCacheBustingSearchParam(
        "1",
        undefined,
        undefined,
        undefined,
      );
      for (let index = 0; index < 3; index++) {
        const session = await entry.client.post("session");
        const page = await entry.client.page();
        const prefetched = await entry.client.send(
          `${SECURITY_PAGE}?_rsc=${rsc}`,
          "",
          { headers: { RSC: "1", "Next-Router-Prefetch": "1" } },
        );
        const action = await entry.client.action(ref.id, ref.csrf, {}, true);
        expect(
          session.status === 200 &&
            admitted(page) &&
            safe(prefetched) &&
            action.status === 200 &&
            session.cookies.length === 0 &&
            page.cookies.length === 0 &&
            prefetched.cookies.length === 0,
        ).toBe(true);
      }
      expect((await lifetime(entry.principal.userId)) === before).toBe(true);
    },
  );
  scenario(
    "absolute expiry denies RSC and direct Action despite copied valid native cookies",
    async () => {
      const entry = await login();
      const ref = await actionRef(entry.client, "probe");
      await fx.migration.query(
        `WITH boundary AS MATERIALIZED(SELECT clock_timestamp() n), changed AS(UPDATE staff.admissions SET authenticated_at=boundary.n-interval '9 hours',last_seen_at=boundary.n-interval '1 minute' FROM boundary WHERE user_id=$1 RETURNING session_id,authenticated_at) UPDATE control_private.session_controls c SET authenticated_at=a.authenticated_at,absolute_deadline=a.authenticated_at+interval '8 hours' FROM changed a WHERE c.session_id=a.session_id`,
        [entry.principal.userId],
      );
      expect(denied(await entry.client.page())).toBe(true);
      const response = await entry.client.action(ref.id, ref.csrf, {}, true);
      expect(response.status === 500 && response.cookies.length === 0).toBe(
        true,
      );
    },
  );
  scenario("idle expiry denies without opportunistic refresh", async () => {
    const entry = await login();
    await fx.migration.query(
      `WITH boundary AS MATERIALIZED(SELECT clock_timestamp() n), changed AS(UPDATE staff.admissions SET authenticated_at=boundary.n-interval '32 minutes',last_seen_at=boundary.n-interval '31 minutes' FROM boundary WHERE user_id=$1 RETURNING session_id,authenticated_at) UPDATE control_private.session_controls c SET authenticated_at=a.authenticated_at,absolute_deadline=a.authenticated_at+interval '8 hours' FROM changed a WHERE c.session_id=a.session_id`,
      [entry.principal.userId],
    );
    const before = await lifetime(entry.principal.userId);
    const result = await entry.client.post("session");
    expect(
      result.status === 401 &&
        result.cookies.length === 0 &&
        denied(await entry.client.page()) &&
        (await lifetime(entry.principal.userId)) === before,
    ).toBe(true);
  });
  scenario(
    "suspended synthetic Analyst cannot use old page or direct Action grant",
    async () => {
      const entry = await login();
      const ref = await actionRef(entry.client, "revoke-self");
      await fx.migration.query(
        "UPDATE staff.principals SET status='suspended' WHERE user_id=$1",
        [entry.principal.userId],
      );
      expect(denied(await entry.client.page())).toBe(true);
      const response = await entry.client.action(ref.id, ref.csrf, {}, true);
      expect(response.status === 500 && response.cookies.length === 0).toBe(
        true,
      );
    },
  );
  scenario(
    "authorization version changes invalidate copied session and Action nonce authority",
    async () => {
      const entry = await login();
      const ref = await actionRef(entry.client, "probe");
      await fx.migration.query(
        "UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=$1",
        [entry.principal.userId],
      );
      expect(
        denied(await entry.client.page()) &&
          (await entry.client.post("session")).status === 401,
      ).toBe(true);
      expect(
        (await entry.client.action(ref.id, ref.csrf, {}, true)).status,
      ).toBe(500);
    },
  );
  scenario(
    "role removal is live authorization denial not cached layout access",
    async () => {
      const entry = await login();
      await fx.migration.query(
        "DELETE FROM staff.role_grants WHERE user_id=$1 AND role_name='Analyst'",
        [entry.principal.userId],
      );
      expect(
        denied(await entry.client.page()) &&
          (await entry.client.post("session")).status === 401,
      ).toBe(true);
    },
  );
  scenario(
    "concurrent admitted anonymous primary stale and suspended RSC never share cached admission",
    async () => {
      const live = await login();
      const suspended = await login();
      const prepared = await primary();
      // Five genuinely different jars with only THREE native password successes:
      // live admitted, anonymous, fresh primary, stale consumed primary, suspended.
      // A fourth native login is NOT promised past the maintained rate ceiling.
      await fx.migration.query(
        "UPDATE staff.principals SET status='suspended' WHERE user_id=$1",
        [suspended.principal.userId],
      );
      for (let turn = 0; turn < 3; turn++) {
        const pages = await Promise.all([
          live.client.page(),
          client().page(),
          prepared.client.page(),
          client().page({ cookie: live.challenge }),
          suspended.client.page(),
        ]);
        expect(
          pages.every((page) => safe(page) && page.cookies.length === 0) &&
            admitted(pages[0]) &&
            pages.slice(1).every((page) => denied(page) && !admitted(page)),
        ).toBe(true);
      }
    },
  );
  scenario(
    "pending credential transition denies before worker and remains denied across worker kill restart",
    async () => {
      const entry = await login();
      const ref = await actionRef(entry.client, "probe");
      await fx.auth.query('UPDATE identity."User" SET email=$2 WHERE id=$1', [
        entry.principal.userId,
        `${randomUUID()}@example.invalid`,
      ]);
      expect(
        denied(await entry.client.page()) &&
          (await entry.client.action(ref.id, ref.csrf, {}, true)).status ===
            500,
      ).toBe(true);
      let worker = await createWorkerProcess(fx.owned.workerUrl);
      try {
        const first = await worker.runOnce();
        expect(["completed", "partial"].includes(first.status)).toBe(true);
        await worker.kill();
        worker = await createWorkerProcess(fx.owned.workerUrl);
        const second = await worker.runOnce();
        expect(["completed", "partial"].includes(second.status)).toBe(true);
        expect(
          denied(await entry.client.page()) &&
            (await entry.client.post("session")).status === 401,
        ).toBe(true);
        const row = await fx.migration.query<{ safe: boolean }>(
          "SELECT NOT EXISTS(SELECT 1 FROM control_private.approved_generations WHERE user_id=$1 AND NOT retired) safe",
          [entry.principal.userId],
        );
        expect(row.rows[0].safe).toBe(true);
      } finally {
        await worker.close();
      }
    },
  );
  scenario(
    "session.created pending event is intentionally non-invalidating and reconciliation never grants",
    async () => {
      const entry = await login();
      const before = await admissions(entry.principal.userId);
      await fx.auth.query(
        'INSERT INTO identity."Session" (id,token,"userId","expiresAt","updatedAt") VALUES ($1,$2,$3,clock_timestamp()+interval \'1 hour\',clock_timestamp())',
        [randomUUID(), randomUUID(), entry.principal.userId],
      );
      expect(admitted(await entry.client.page())).toBe(true);
      const worker = await createWorkerProcess(fx.owned.workerUrl);
      try {
        const result = await worker.runOnce();
        expect(
          result.status === "completed" &&
            admitted(await entry.client.page()) &&
            (await admissions(entry.principal.userId)) === before,
        ).toBe(true);
      } finally {
        await worker.close();
      }
    },
  );
  scenario(
    "a second genuine Next process reads the same canonical session without a second proof",
    async () => {
      const entry = await login();
      const second = await startNextProcess(config(3465));
      try {
        const page = await client(3465).page({
          cookie: entry.client.jar.header,
        });
        expect(safe(page) && admitted(page) && page.cookies.length === 0).toBe(
          true,
        );
      } finally {
        await second.close();
      }
    },
  );
  scenario(
    "genuine Next process loss and restart preserves durable admission but not local memory authority",
    async () => {
      const entry = await login();
      const copied = entry.client.jar.header;
      await main?.kill();
      main = undefined;
      main = await startNextProcess(config());
      expect(admitted(await client().page({ cookie: copied }))).toBe(true);
      expect(await admissions(entry.principal.userId)).toBe(1);
    },
  );
  scenario(
    "actual second process and restart retain pre-SDK replay burns",
    async () => {
      const principal = await fx.createPrincipal();
      const first = client();
      const secondClient = client(3465);
      let second = await startNextProcess(config(3465));
      try {
        await primary(principal, first);
        await primary(principal, secondClient);
        const copied = secondClient.jar.header;
        const code = await fx.code(principal);
        expect((await first.post("totp", { code })).status).toBe(200);
        const rejected = await secondClient.post(
          "totp",
          { code },
          { cookie: copied, absorb: false },
        );
        expect(rejected.status === 403 && rejected.cookies.length === 0).toBe(
          true,
        );
        await second.kill();
        second = await startNextProcess(config(3465));
        const after = await secondClient.post(
          "totp",
          { code },
          { cookie: copied, absorb: false },
        );
        expect(
          after.status === 403 &&
            after.cookies.length === 0 &&
            (await admissions(principal.userId)) === 1,
        ).toBe(true);
      } finally {
        await second.close();
      }
    },
  );
  scenario(
    "eight-way 128-request pressure never exceeds shared120 or creates admission",
    async () => {
      const second = await startNextProcess(config(3465));
      const clients = [client(), client(3465)];
      const before = await admissions();
      let count = 0;
      try {
        for (let turn = 0; turn < 16; turn++) {
          const responses = await Promise.all(
            Array.from({ length: 8 }, (_, index) =>
              clients[index % 2].post("session"),
            ),
          );
          count += responses.length;
          expect(
            responses.every(
              (response) =>
                [401, 429, 503].includes(response.status) &&
                safe(response) &&
                response.disabled &&
                response.cookies.length === 0,
            ),
          ).toBe(true);
        }
        expect(count).toBe(128);
        const row = await fx.migration.query<{ safe: boolean }>(
          "SELECT coalesce((SELECT used<=120 FROM control_private.budgets WHERE key_mac=control_private.mac('transport-ingress-v1','common-loopback')),true) safe",
        );
        expect(row.rows[0].safe && (await admissions()) === before).toBe(true);
      } finally {
        await second.close();
      }
    },
  );
  scenario(
    "two-process exact120 charges eight denials and restart preserve anchored ingress window",
    async () => {
      let second = await startNextProcess(config(3465));
      const clients = [client(), client(3465)];
      let used = 0,
        rejected = 0;
      try {
        for (let turn = 0; turn < 64; turn++) {
          const responses = await Promise.all(
            clients.map((wire) => wire.post("session")),
          );
          expect(
            responses.every(
              (response) =>
                [401, 429].includes(response.status) &&
                safe(response) &&
                response.disabled &&
                response.cookies.length === 0,
            ),
          ).toBe(true);
          used += responses.filter(
            (response) => response.status === 401,
          ).length;
          rejected += responses.filter(
            (response) => response.status === 429,
          ).length;
        }
        expect(used).toBe(120);
        expect(rejected).toBe(8);
        const before = (
          await fx.migration.query(
            "SELECT window_start::text,window_end::text,used FROM control_private.budgets ORDER BY key_mac",
          )
        ).rows;
        await second.kill();
        second = await startNextProcess(config(3465));
        expect((await clients[1].post("session")).status).toBe(429);
        const logout = await clients[0].post("signOut");
        expect(logout.status === 429 && allCleared(logout)).toBe(true);
        const after = (
          await fx.migration.query(
            "SELECT window_start::text,window_end::text,used FROM control_private.budgets ORDER BY key_mac",
          )
        ).rows;
        expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
      } finally {
        await second.close();
      }
    },
  );
  scenario(
    "two-process password account five ceiling never extends denied windows",
    async () => {
      const p = await fx.createPrincipal();
      const second = await startNextProcess(config(3465));
      const clients = [client(), client(3465)];
      const sql =
        "SELECT used,window_start::text,window_end::text FROM control_private.budgets WHERE key_mac IN(control_private.mac('budget-account-password',$1::text),control_private.mac('budget-ip-password','unknown')) ORDER BY key_mac";
      try {
        for (let turn = 0; turn < 4; turn++) {
          const results = await Promise.all(
            clients.map((wire) =>
              wire.post("password", {
                email: p.email,
                password: p.password + "invalid",
              }),
            ),
          );
          expect(
            results.every(
              (result) =>
                result.status === 403 &&
                result.cookies.length === 0 &&
                result.disabled,
            ),
          ).toBe(true);
        }
        const before = (
          await fx.migration.query<{ used: number }>(sql, [p.email])
        ).rows;
        expect(
          before.length === 2 && before.every((row) => row.used === 5),
        ).toBe(true);
        expect(
          (
            await clients[1].post("password", {
              email: p.email,
              password: p.password + "invalid",
            })
          ).status,
        ).toBe(403);
        const after = (await fx.migration.query(sql, [p.email])).rows;
        expect(
          JSON.stringify(before) === JSON.stringify(after) &&
            (await admissions(p.userId)) === 0,
        ).toBe(true);
      } finally {
        await second.close();
      }
    },
  );
  scenario(
    "twenty shared password reservations retain stricter maintained native throttling",
    async () => {
      const principals: SyntheticPrincipal[] = [];
      for (let index = 0; index < 21; index++)
        principals.push(await fx.createPrincipal());
      const second = await startNextProcess(config(3465));
      const clients = [client(), client(3465)];
      let allowed = 0,
        rejected = 0;
      try {
        for (let index = 0; index < 20; index++) {
          const p = principals[index];
          const result = await clients[index % 2].post("password", {
            email: p.email,
            password: p.password,
          });
          expect([200, 403].includes(result.status) && result.disabled).toBe(
            true,
          );
          if (result.status === 200) {
            allowed++;
            expect(result.state).toBe("mfa-required");
          } else {
            rejected++;
            expect(result.cookies.length).toBe(0);
          }
        }
        expect(allowed > 0 && rejected > 0).toBe(true);
        const sql =
          "SELECT used,window_start::text,window_end::text FROM control_private.budgets WHERE key_mac=control_private.mac('budget-ip-password','unknown')";
        const before = (await fx.migration.query<{ used: number }>(sql)).rows;
        expect(before.length === 1 && before[0].used === 20).toBe(true);
        const p = principals[20];
        const result = await clients[0].post("password", {
          email: p.email,
          password: p.password,
        });
        expect(result.status === 403 && result.cookies.length === 0).toBe(true);
        const after = (await fx.migration.query(sql)).rows;
        expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
        const attempts = await fx.migration.query<{ n: number }>(
          "SELECT count(*)::integer n FROM control_private.attempts WHERE user_id=$1",
          [p.userId],
        );
        expect(attempts.rows[0].n).toBe(0);
      } finally {
        await second.close();
      }
    },
  );
  scenario(
    "ten account MFA reservations include login and distinct wrong step-up codes without reset",
    async () => {
      const entry = await login();
      const codes = await wrongCodes(entry.principal, 10);
      for (let index = 0; index < 9; index++) {
        const result = await entry.client.post("stepUp", {
          code: codes[index],
        });
        expect(result.status === 403 && result.cookies.length === 0).toBe(true);
      }
      const sql =
        "SELECT used,window_start::text,window_end::text FROM control_private.budgets WHERE key_mac=control_private.mac('budget-account-mfa',$1::text)";
      const before = (
        await fx.migration.query<{ used: number }>(sql, [
          entry.principal.userId,
        ])
      ).rows;
      expect(before.length === 1 && before[0].used === 10).toBe(true);
      expect(
        (await entry.client.post("stepUp", { code: codes[9] })).status,
      ).toBe(403);
      const after = (await fx.migration.query(sql, [entry.principal.userId]))
        .rows;
      expect(
        JSON.stringify(before) === JSON.stringify(after) &&
          (await admissions(entry.principal.userId)) === 1,
      ).toBe(true);
    },
  );
  scenario(
    "twenty common-IP MFA reservations span two genuine Next processes",
    async () => {
      const second = await startNextProcess(config(3465));
      try {
        const entries = [
          await login(client()),
          await login(client(3465)),
          await login(client()),
        ];
        const codes = await Promise.all(
          entries.map((entry) => wrongCodes(entry.principal, 7)),
        );
        for (let index = 0; index < 17; index++) {
          const owner = index % 3;
          const result = await entries[owner].client.post("stepUp", {
            code: codes[owner][Math.floor(index / 3)],
          });
          expect(result.status === 403 && result.cookies.length === 0).toBe(
            true,
          );
        }
        const sql =
          "SELECT used,window_start::text,window_end::text FROM control_private.budgets WHERE key_mac=control_private.mac('budget-ip-mfa','unknown')";
        const before = (await fx.migration.query<{ used: number }>(sql)).rows;
        expect(before.length === 1 && before[0].used === 20).toBe(true);
        const result = await entries[2].client.post("stepUp", {
          code: codes[2][5],
        });
        expect(result.status === 403 && result.cookies.length === 0).toBe(true);
        const after = (await fx.migration.query(sql)).rows;
        expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
      } finally {
        await second.close();
      }
    },
  );
  scenario(
    "finalizer audit rollback delivers no new cookies or admission while burn remains",
    async () => {
      const entry = await primary();
      await fault("login-audit", async () => {
        const result = await entry.client.post("totp", {
          code: await fx.code(entry.principal),
        });
        expect(
          result.status === 503 &&
            result.cookies.length === 0 &&
            (await admissions(entry.principal.userId)) === 0,
        ).toBe(true);
        const row = await fx.migration.query<{ burned: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM control_private.attempts a JOIN control_private.replay_burns b USING(code_mac) WHERE a.user_id=$1) burned",
          [entry.principal.userId],
        );
        expect(row.rows[0].burned).toBe(true);
      });
    },
  );
  scenario(
    "native session INSERT fault cannot emit a new session cookie or local grant",
    async () => {
      const entry = await primary();
      await fault("session-insert", async () => {
        const result = await entry.client.post("totp", {
          code: await fx.code(entry.principal),
        });
        expect(
          result.status === 503 &&
            result.cookies.length === 0 &&
            (await admissions(entry.principal.userId)) === 0,
        ).toBe(true);
      });
    },
  );
  scenario(
    "post-comparison native factor persistence failure cannot manufacture a grant",
    async () => {
      const entry = await primary();
      await fault("factor-update", async () => {
        const result = await entry.client.post("totp", {
          code: await fx.code(entry.principal),
        });
        expect(
          result.status === 503 &&
            result.cookies.length === 0 &&
            (await admissions(entry.principal.userId)) === 0,
        ).toBe(true);
      });
    },
  );
  scenario(
    "signout native DELETE failure retains durable cancellation and clears scopes",
    async () => {
      const entry = await login();
      const copied = entry.client.jar.header;
      await fault("session-delete", async () => {
        const result = await entry.client.post("signOut");
        expect(
          result.status === 503 &&
            allCleared(result) &&
            entry.client.jar.size === 0,
        ).toBe(true);
      });
      expect(
        (
          await entry.client.post(
            "session",
            {},
            { cookie: copied, absorb: false },
          )
        ).status,
      ).toBe(401);
    },
  );
  scenario(
    "valid native signout still clears all Next cookie scopes on cancellation audit outage",
    async () => {
      const entry = await login();
      const ref = await actionRef(entry.client, "sign-out");
      await fault("cancel-audit", async () => {
        const result = await entry.client.action(ref.id, ref.csrf, {}, true);
        expect(
          result.status === 500 &&
            allCleared(result) &&
            entry.client.jar.size === 0 &&
            !positiveCookie(result),
        ).toBe(true);
      });
    },
  );
  scenario(
    "committed suspension wins an actual Action blocked at the governance clock-probe barrier",
    async () => {
      const entry = await login();
      const ref = await actionRef(entry.client, "revoke-self");
      const blocker = await fx.client(fx.owned.migrationUrl);
      let transaction = false;
      let pending: Promise<NextWireResponse | null> | undefined;
      try {
        await blocker.query("BEGIN");
        transaction = true;
        await blocker.query(
          "SELECT 1 FROM staff.governance WHERE singleton FOR UPDATE",
        );
        const pid = (
          await blocker.query<{ pid: number }>("SELECT pg_backend_pid() pid")
        ).rows[0].pid;
        pending = entry.client.action(ref.id, ref.csrf, {}, true).then(
          (result) => result,
          () => null,
        );
        let observed = false;
        const until = performance.now() + 2000;
        for (let turn = 0; turn < 1000 && performance.now() < until; turn++) {
          const row = await fx.migration.query<{ blocked: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=$2 AND $1::integer=ANY(pg_blocking_pids(pid))) blocked",
            [pid, new URL(fx.owned.staffUrl).username],
          );
          if (row.rows[0].blocked) {
            observed = true;
            break;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(observed).toBe(true);
        // This is honestly a clock/ingress barrier, NOT a claimed held finalizer lock.
        await blocker.query(
          "UPDATE staff.principals SET status='suspended' WHERE user_id=$1",
          [entry.principal.userId],
        );
        await blocker.query("COMMIT");
        transaction = false;
        const result = await pending;
        expect(
          result !== null &&
            result.status === 500 &&
            result.cookies.length === 0,
        ).toBe(true);
        expect(
          denied(await entry.client.page()) &&
            (await entry.client.post("session")).status === 401,
        ).toBe(true);
      } finally {
        if (transaction) await blocker.query("ROLLBACK");
        if (pending) await pending;
        await fx.release(blocker);
      }
    },
  );
});
