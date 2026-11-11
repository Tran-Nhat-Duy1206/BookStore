import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { createHash } from "node:crypto";
import { ControlFixtures, secretSafe } from "../admission-controls/fixtures";
import {
  createTransportCertificates,
  type TransportCertificateFixture,
} from "./certificates";
import {
  WireClient,
  transportConfig,
  cookieAttributesValid,
  allCookiesCleared,
  startWireWorker,
  WIRE_PATHS,
  type WireOptions,
} from "./client";
import {
  startRestrictedHttpsTestTransport,
  type RestrictedHttpsTestTransport,
} from "../../src/server/security/https-transport";

const fx = new ControlFixtures();
let certs: TransportCertificateFixture, transport: RestrictedHttpsTestTransport;
const scenario = (name: string, run: () => Promise<void>) =>
  it(name, () => secretSafe(run));
async function login(client = new WireClient(certs.ca)) {
  const principal = await fx.createPrincipal();
  const primary = await client.post("password", {
    email: principal.email,
    password: principal.password,
  });
  expect(primary.status).toBe(200);
  const old = client.jar.clone();
  const code = await fx.code(principal);
  const verified = await client.post("totp", { code });
  expect(verified.status).toBe(200);
  const rows = await fx.migration.query<{ session_id: string }>(
    "SELECT session_id FROM staff.admissions WHERE user_id=$1 AND mode='verified'",
    [principal.userId],
  );
  expect(rows.rowCount).toBe(1);
  return { principal, client, old, code, sessionId: rows.rows[0].session_id };
}
async function countAdmissions(userId: string): Promise<number> {
  return (
    await fx.migration.query<{ n: number }>(
      "SELECT count(*)::integer n FROM staff.admissions WHERE user_id=$1 AND mode='verified'",
      [userId],
    )
  ).rows[0].n;
}
async function snapshot(sessionId: string) {
  return (
    await fx.migration.query<{
      authenticated: string;
      idle: string;
      deadline: string;
    }>(
      "SELECT a.authenticated_at::text authenticated,a.last_seen_at::text idle,c.absolute_deadline::text deadline FROM staff.admissions a JOIN control_private.session_controls c USING(session_id) WHERE session_id=$1",
      [sessionId],
    )
  ).rows[0];
}
/** Bounded state-change witness, not a claim that no metadata SQL ran. */
async function protectedStateWitness(): Promise<string> {
  const rows = await fx.migration.query<{
    value: unknown;
  }>(`SELECT jsonb_build_object(
    'budgets',(SELECT coalesce(jsonb_agg(jsonb_build_array(used,window_start,window_end) ORDER BY used,window_start,window_end),'[]'::jsonb) FROM control_private.budgets),
    'clock',(SELECT high_water::text FROM control_private.clock_state WHERE singleton),
    'audit',(SELECT count(*) FROM audit.events),
    'provider_events',(SELECT count(*) FROM audit.provider_events),
    'provider_sessions',(SELECT count(*) FROM identity."Session"),
    'attempts',(SELECT count(*) FROM control_private.attempts)) value`);
  // Compare only booleans at assertion sites: never dump even metadata rows.
  return createHash("sha256")
    .update(JSON.stringify(rows.rows[0].value))
    .digest("hex");
}
async function wrongCode(
  principal: Awaited<ReturnType<typeof fx.createPrincipal>>,
): Promise<string> {
  const accepted = new Set([
    await fx.code(principal, -1),
    await fx.code(principal),
    await fx.code(principal, 1),
  ]);
  const code = ["000000", "000001", "000002", "000003"].find(
    (value) => !accepted.has(value),
  );
  if (!code) throw new Error("Synthetic incorrect code unavailable.");
  return code;
}
beforeAll(() =>
  secretSafe(async () => {
    process.env.BOOKSTORE_RESTRICTED_HTTPS_TEST = "1";
    certs = await createTransportCertificates();
    await fx.start();
    transport = await startRestrictedHttpsTestTransport(
      transportConfig(fx.config, certs),
    );
  }),
);
beforeEach(() => secretSafe(() => fx.resetScenario()));
afterAll(() =>
  secretSafe(async () => {
    await transport?.close();
    await fx.stop();
    await certs?.close();
    delete process.env.BOOKSTORE_RESTRICTED_HTTPS_TEST;
  }),
);
describe("restricted actual HTTPS wire and durable authority (not browser evidence)", () => {
  scenario(
    "smoke: password then actual TOTP finalizes before wire success and live session",
    async () => {
      const principal = await fx.createPrincipal();
      const client = new WireClient(certs.ca);
      const password = await client.post("password", {
        email: principal.email,
        password: principal.password,
      });
      expect(password.status).toBe(200);
      expect(password.state).toBe("mfa-required");
      expect(password.applicationDisabled).toBe(true);
      expect(password.authorized).toBe(true);
      expect(cookieAttributesValid(password)).toBe(true);
      const first = await client.post("session");
      expect(first.status).toBe(401);
      expect(first.cookies.length).toBe(0);
      const verified = await client.post("totp", {
        code: await fx.code(principal),
      });
      expect(verified.status).toBe(200);
      expect(verified.state).toBe("verified-test-session");
      expect(verified.applicationDisabled).toBe(true);
      const session = await client.post("session");
      expect(session.status).toBe(200);
      expect(session.cookies.length).toBe(0);
    },
  );

  const ingressCases: Array<[string, WireOptions, number]> = [
    ["missing Origin", { headers: { Origin: null } }, 403],
    ["null Origin", { headers: { Origin: "null" } }, 403],
    ["foreign Origin", { headers: { Origin: "https://foreign.invalid" } }, 403],
    [
      "HTTP Origin",
      { headers: { Origin: "http://bookstore-transport.invalid:3443" } },
      403,
    ],
    [
      "alternate-port Origin",
      { headers: { Origin: "https://bookstore-transport.invalid:3445" } },
      403,
    ],
    ["missing CSRF", { headers: { "X-Bookstore-CSRF": null } }, 403],
    ["wrong CSRF", { headers: { "X-Bookstore-CSRF": "0" } }, 403],
    [
      "cross-site Fetch Metadata",
      { headers: { "Sec-Fetch-Site": "cross-site" } },
      403,
    ],
    [
      "alternate Host",
      { headers: { Host: "other.bookstore-transport.invalid:3443" } },
      403,
    ],
    [
      "alternate-port Host",
      { headers: { Host: "bookstore-transport.invalid:3445" } },
      403,
    ],
    [
      "Forwarded injection",
      { headers: { Forwarded: "for=192.0.2.1;proto=https" } },
      403,
    ],
    [
      "X-Forwarded-For injection",
      { headers: { "X-Forwarded-For": "192.0.2.1" } },
      403,
    ],
    [
      "X-Forwarded-Proto injection",
      { headers: { "X-Forwarded-Proto": "https" } },
      403,
    ],
    ["X-Real-IP injection", { headers: { "X-Real-IP": "192.0.2.1" } }, 403],
    [
      "CDN peer injection",
      { headers: { "CF-Connecting-IP": "192.0.2.1" } },
      403,
    ],
    ["method override", { headers: { "X-HTTP-Method-Override": "POST" } }, 403],
    [
      "form body",
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      415,
    ],
    ["missing content type", { headers: { "Content-Type": null } }, 415],
    [
      "unsupported charset",
      { headers: { "Content-Type": "application/json; charset=iso-8859-1" } },
      415,
    ],
    [
      "missing length becomes Node chunked framing and is denied",
      { headers: { "Content-Length": null } },
      403,
    ],
    ["padded content length", { headers: { "Content-Length": "02" } }, 411],
    ["oversized body", { body: "x".repeat(1025) }, 413],
    ["invalid JSON", { body: "{" }, 400],
    ["duplicate JSON key", { body: '{"code":"000000","code":"000001"}' }, 400],
    [
      "escaped JSON duplicate",
      { body: '{"code":"000000","co\\u0064e":"000001"}' },
      400,
    ],
    ["JSON array", { body: "[]" }, 400],
    ["noncanonical JSON whitespace", { body: "{ }" }, 400],
    ["actor claim", { body: '{"userId":"synthetic-claim"}' }, 400],
    ["verified claim", { body: '{"verified":true}' }, 400],
    ["redirect field", { body: '{"returnTo":"//foreign.invalid"}' }, 400],
    ["nested JSON", { body: '{"actor":{}}' }, 400],
    ["invalid UTF8", { body: Buffer.from([0xff]) }, 400],
    [
      "duplicate Origin",
      { extraHeaders: ["Origin", "https://bookstore-transport.invalid:3443"] },
      403,
    ],
    ["duplicate CSRF", { extraHeaders: ["X-Bookstore-CSRF", "1"] }, 403],
    [
      "duplicate Content-Type",
      { extraHeaders: ["Content-Type", "application/json"] },
      403,
    ],
    ["compressed body", { headers: { "Content-Encoding": "gzip" } }, 403],
    ["unknown cookie", { cookie: "synthetic_unknown=noncredential" }, 400],
    [
      "duplicate cookie",
      {
        cookie:
          "__Secure-bookstore-provider-proof.session_token=noncredential; __Secure-bookstore-provider-proof.session_token=noncredential",
      },
      400,
    ],
  ];
  for (const [name, options, status] of ingressCases)
    scenario(`denies ${name} before authority`, async () => {
      const before = await protectedStateWitness();
      const result = await new WireClient(certs.ca).post(
        "session",
        {},
        options,
      );
      expect(result.status).toBe(status);
      expect(result.applicationDisabled).toBe(true);
      expect(result.noStore).toBe(true);
      expect(result.cookies.length).toBe(0);
      expect(result.location).toBe(false);
      expect((await protectedStateWitness()) === before).toBe(true);
    });
  for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"])
    scenario(`denies alternate ${method} on authentication path`, async () => {
      const before = await protectedStateWitness();
      const result = await new WireClient(certs.ca).post(
        "password",
        {},
        { method },
      );
      expect(result.status).toBe(405);
      expect(result.cookies.length).toBe(0);
      expect((await protectedStateWitness()) === before).toBe(true);
    });
  for (const alias of [
    "/__bookstore_test_auth/password/",
    "/__bookstore_test_auth//password",
    "/__bookstore_test_auth/Password",
    "/__bookstore_test_auth/%70assword",
    "/__bookstore_test_auth/%252fpassword",
    "/__bookstore_test_auth/../password",
    "/__bookstore_test_auth/password?next=/",
    "/api/unmounted-provider-proof/sign-in/email",
    "/__bookstore_test_auth/two-factor/verify-backup-code",
    "/__bookstore_test_auth/enroll",
  ])
    scenario(`denies raw path alias ${alias}`, async () => {
      const before = await protectedStateWitness();
      const result = await new WireClient(certs.ca).send(alias);
      expect(result.status).toBe(404);
      expect(result.cookies.length).toBe(0);
      expect(result.location).toBe(false);
      expect((await protectedStateWitness()) === before).toBe(true);
    });
  scenario(
    "serves only the inert non-authentication probe document",
    async () => {
      const result = await new WireClient(certs.ca).send(
        "/__bookstore_test_probe",
        {},
        { method: "GET", body: "" },
      );
      expect(result.status).toBe(200);
      expect(result.cookies.length).toBe(0);
      expect(result.noStore).toBe(true);
      expect(result.body.includes("<body></body>")).toBe(true);
    },
  );
  scenario(
    "rejects ambiguous duplicate Host and CL+TE at the raw TLS HTTP parser",
    async () => {
      const client = new WireClient(certs.ca);
      const before = await protectedStateWitness();
      for (const extra of [
        "Host: bookstore-transport.invalid:3443\r\n",
        "Transfer-Encoding: chunked\r\n",
      ]) {
        const result = await client.raw(
          `POST ${WIRE_PATHS.session} HTTP/1.1\r\nHost: bookstore-transport.invalid:3443\r\nOrigin: https://bookstore-transport.invalid:3443\r\nX-Bookstore-CSRF: 1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n${extra}Connection: close\r\n\r\n{}`,
        );
        expect([400, 403].includes(result.status)).toBe(true);
        expect(result.cookies).toBe(false);
        expect((await protectedStateWitness()) === before).toBe(true);
      }
    },
  );
  scenario(
    "does not treat a forged signed-session value or helper cookie as authority",
    async () => {
      const client = new WireClient(certs.ca);
      for (const cookie of [
        "__Secure-bookstore-provider-proof.session_token=synthetic-noncredential",
        "__Secure-bookstore-provider-proof.session_data=synthetic-noncredential",
        "__Secure-bookstore-provider-proof.dont_remember=synthetic-noncredential",
      ]) {
        const result = await client.post("session", {}, { cookie });
        expect(result.status).toBe(401);
        expect(result.cookies.length).toBe(0);
      }
    },
  );
  scenario(
    "rotates the challenge and cannot replay old primary cookies after finalization",
    async () => {
      const admitted = await login();
      expect(admitted.client.jar.header !== admitted.old.header).toBe(true);
      const oldSession = await admitted.client.post(
        "session",
        {},
        { cookie: admitted.old.header },
      );
      expect(oldSession.status).toBe(401);
      const oldMfa = await admitted.client.post(
        "totp",
        { code: admitted.code },
        { cookie: admitted.old.header },
      );
      expect(oldMfa.status).toBe(403);
      expect(oldMfa.cookies.length).toBe(0);
      expect((await admitted.client.post("session")).status).toBe(200);
    },
  );
  scenario(
    "cleans stale scopes at password start without granting first-factor admission",
    async () => {
      const admitted = await login();
      const result = await admitted.client.post("password", {
        email: admitted.principal.email,
        password: admitted.principal.password,
      });
      expect(result.status).toBe(200);
      expect(result.cookies.length).toBe(5);
      expect(
        new Set(result.cookies.map((line) => line.split("=", 1)[0])).size,
      ).toBe(5);
      expect(cookieAttributesValid(result)).toBe(true);
      expect((await admitted.client.post("session")).status).toBe(401);
    },
  );
  scenario(
    "rejects a different principal's TOTP against the presented primary challenge",
    async () => {
      const a = await fx.createPrincipal(),
        b = await fx.createPrincipal(),
        client = new WireClient(certs.ca);
      expect(
        (
          await client.post("password", {
            email: a.email,
            password: a.password,
          })
        ).status,
      ).toBe(200);
      const other = await fx.code(b);
      expect(other !== (await fx.code(a))).toBe(true);
      const result = await client.post("totp", { code: other });
      expect(result.status).toBe(403);
      expect(result.cookies.length).toBe(0);
      expect(await countAdmissions(a.userId)).toBe(0);
    },
  );
  scenario(
    "rejects concurrent copies of one primary challenge with at most one wire grant",
    async () => {
      const p = await fx.createPrincipal(),
        client = new WireClient(certs.ca);
      await client.post("password", { email: p.email, password: p.password });
      const cookie = client.jar.header,
        code = await fx.code(p);
      const results = await Promise.all([
        client.post("totp", { code }, { cookie, absorb: false }),
        client.post("totp", { code }, { cookie, absorb: false }),
      ]);
      expect(results.filter((r) => r.status === 200).length).toBe(1);
      expect(
        results
          .filter((r) => r.status !== 200)
          .every((r) => r.cookies.length === 0),
      ).toBe(true);
      expect(await countAdmissions(p.userId)).toBe(1);
    },
  );
  scenario(
    "step-up requires a distinct unburned code and never resets absolute or idle origin",
    async () => {
      const admitted = await login(),
        before = await snapshot(admitted.sessionId);
      expect(
        (await admitted.client.post("stepUp", { code: admitted.code })).status,
      ).toBe(403);
      const next = await fx.code(admitted.principal, 1);
      expect(next !== admitted.code).toBe(true);
      expect(
        (await admitted.client.post("stepUp", { code: next })).status,
      ).toBe(200);
      const after = await snapshot(admitted.sessionId);
      expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
    },
  );
  scenario(
    "session polling neither touches idle nor sets cookies",
    async () => {
      const admitted = await login(),
        before = await snapshot(admitted.sessionId);
      for (let i = 0; i < 3; i++) {
        const result = await admitted.client.post("session");
        expect(result.status).toBe(200);
        expect(result.cookies.length).toBe(0);
      }
      expect(
        JSON.stringify(await snapshot(admitted.sessionId)) ===
          JSON.stringify(before),
      ).toBe(true);
    },
  );
  scenario(
    "expired idle state stays denied and is never revived by session or step-up",
    async () => {
      const admitted = await login();
      await fx.migration.query(
        `WITH boundary AS MATERIALIZED(SELECT clock_timestamp() n), changed AS(UPDATE staff.admissions SET authenticated_at=boundary.n-interval '32 minutes',last_seen_at=boundary.n-interval '31 minutes' FROM boundary WHERE session_id=$1 RETURNING session_id,authenticated_at) UPDATE control_private.session_controls c SET authenticated_at=a.authenticated_at,absolute_deadline=a.authenticated_at+interval '8 hours' FROM changed a WHERE c.session_id=a.session_id`,
        [admitted.sessionId],
      );
      const before = await snapshot(admitted.sessionId);
      expect((await admitted.client.post("session")).status).toBe(401);
      expect(
        (
          await admitted.client.post("stepUp", {
            code: await fx.code(admitted.principal, 1),
          })
        ).status,
      ).toBe(403);
      expect(
        JSON.stringify(await snapshot(admitted.sessionId)) ===
          JSON.stringify(before),
      ).toBe(true);
    },
  );
  scenario(
    "changed authorization version denies retained final cookies",
    async () => {
      const admitted = await login();
      await fx.migration.query(
        "UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=$1",
        [admitted.principal.userId],
      );
      expect((await admitted.client.post("session")).status).toBe(401);
    },
  );
  scenario(
    "retired credential generation and pending ledger deny retained cookies",
    async () => {
      const admitted = await login();
      await fx.auth.query(
        'UPDATE identity."User" SET "emailVerified"=false WHERE id=$1',
        [admitted.principal.userId],
      );
      const result = await admitted.client.post("session");
      expect(result.status).toBe(401);
      expect(result.cookies.length).toBe(0);
    },
  );
  scenario(
    "sign-out clears every scope and durable cancellation denies copied final cookies",
    async () => {
      const admitted = await login(),
        copy = admitted.client.jar.header;
      const result = await admitted.client.post("signOut");
      expect(result.status).toBe(200);
      expect(allCookiesCleared(result)).toBe(true);
      expect(admitted.client.jar.size).toBe(0);
      expect(
        (await admitted.client.post("session", {}, { cookie: copy })).status,
      ).toBe(401);
    },
  );
  scenario(
    "sign-out cancels a copied pending primary challenge before TOTP",
    async () => {
      const p = await fx.createPrincipal(),
        client = new WireClient(certs.ca);
      await client.post("password", { email: p.email, password: p.password });
      const copy = client.jar.header;
      expect((await client.post("signOut")).status).toBe(200);
      const result = await client.post(
        "totp",
        { code: await fx.code(p) },
        { cookie: copy },
      );
      expect(result.status).toBe(403);
      expect(result.cookies.length).toBe(0);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );
  scenario(
    "anonymous logout does not cancel an unrelated still-unpresented primary context",
    async () => {
      const p = await fx.createPrincipal(),
        client = new WireClient(certs.ca);
      await client.post("password", { email: p.email, password: p.password });
      const anonymous = new WireClient(certs.ca);
      expect((await anonymous.post("signOut")).status).toBe(200);
      expect(
        (await client.post("totp", { code: await fx.code(p) })).status,
      ).toBe(200);
    },
  );
  scenario(
    "finalizer audit failure returns unavailable with NO new cookies or local admission",
    async () => {
      const p = await fx.createPrincipal(),
        client = new WireClient(certs.ca);
      await client.post("password", { email: p.email, password: p.password });
      await fx.migration.query(
        "CREATE FUNCTION public.wire_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic wire audit fault' USING ERRCODE='P0001'; END $$",
      );
      await fx.migration.query(
        "CREATE TRIGGER wire_fail_audit BEFORE INSERT ON audit.events FOR EACH ROW WHEN (NEW.action='control.login') EXECUTE FUNCTION public.wire_fail_audit()",
      );
      try {
        const result = await client.post("totp", { code: await fx.code(p) });
        expect(result.status).toBe(503);
        expect(result.cookies.length).toBe(0);
        expect(await countAdmissions(p.userId)).toBe(0);
        const burned = await fx.migration.query<{ burned: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM control_private.attempts a JOIN control_private.replay_burns b USING(code_mac) WHERE a.user_id=$1) burned",
          [p.userId],
        );
        expect(burned.rows[0].burned).toBe(true);
      } finally {
        await fx.migration.query(
          "DROP TRIGGER wire_fail_audit ON audit.events",
        );
        await fx.migration.query("DROP FUNCTION public.wire_fail_audit()");
      }
    },
  );
  scenario(
    "native session-insert fault never forwards a new session cookie",
    async () => {
      const p = await fx.createPrincipal(),
        client = new WireClient(certs.ca);
      await client.post("password", { email: p.email, password: p.password });
      await fx.migration.query(
        "CREATE FUNCTION public.wire_fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic wire persistence fault' USING ERRCODE='P0001'; END $$",
      );
      await fx.migration.query(
        'CREATE TRIGGER wire_fail_session BEFORE INSERT ON identity."Session" FOR EACH ROW EXECUTE FUNCTION public.wire_fail_session()',
      );
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await client.post("totp", { code: await fx.code(p) });
        expect(result.status).toBe(503);
        expect(result.cookies.length).toBe(0);
        expect(result.applicationDisabled).toBe(true);
        expect(log.mock.calls.length).toBe(0);
        expect(await countAdmissions(p.userId)).toBe(0);
      } finally {
        log.mockRestore();
        await fx.migration.query(
          'DROP TRIGGER wire_fail_session ON identity."Session"',
        );
        await fx.migration.query("DROP FUNCTION public.wire_fail_session()");
      }
    },
  );
  scenario(
    "native sign-out persistence failure preserves prior durable cancellation and clears cookies",
    async () => {
      const admitted = await login(),
        copy = admitted.client.jar.header;
      await fx.migration.query(
        "CREATE FUNCTION public.wire_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic wire delete fault' USING ERRCODE='P0001'; END $$",
      );
      await fx.migration.query(
        'CREATE TRIGGER wire_fail_delete BEFORE DELETE ON identity."Session" FOR EACH ROW EXECUTE FUNCTION public.wire_fail_delete()',
      );
      try {
        const result = await admitted.client.post("signOut");
        expect(result.status).toBe(503);
        expect(allCookiesCleared(result)).toBe(true);
      } finally {
        await fx.migration.query(
          'DROP TRIGGER wire_fail_delete ON identity."Session"',
        );
        await fx.migration.query("DROP FUNCTION public.wire_fail_delete()");
      }
      expect(
        (await admitted.client.post("session", {}, { cookie: copy })).status,
      ).toBe(401);
    },
  );
  scenario(
    "cancellation audit failure is honest unavailable and always clears browser scopes",
    async () => {
      const admitted = await login();
      await fx.migration.query(
        "CREATE FUNCTION public.wire_fail_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic cancellation audit fault' USING ERRCODE='P0001'; END $$",
      );
      await fx.migration.query(
        "CREATE TRIGGER wire_fail_cancel BEFORE INSERT ON audit.events FOR EACH ROW WHEN(NEW.action='transport.cancel') EXECUTE FUNCTION public.wire_fail_cancel()",
      );
      try {
        const result = await admitted.client.post("signOut");
        expect(result.status).toBe(503);
        expect(allCookiesCleared(result)).toBe(true);
      } finally {
        await fx.migration.query(
          "DROP TRIGGER wire_fail_cancel ON audit.events",
        );
        await fx.migration.query("DROP FUNCTION public.wire_fail_cancel()");
      }
    },
  );
  scenario(
    "real second server process shares replay burns and retains them across restart",
    async () => {
      const p = await fx.createPrincipal(),
        first = new WireClient(certs.ca),
        second = new WireClient(certs.ca, 3445);
      let child = await startWireWorker(
        transportConfig(fx.config, certs, 3445),
      );
      try {
        await first.post("password", { email: p.email, password: p.password });
        await second.post("password", { email: p.email, password: p.password });
        const copy = second.jar.header,
          code = await fx.code(p);
        expect((await first.post("totp", { code })).status).toBe(200);
        expect(
          (await second.post("totp", { code }, { cookie: copy })).status,
        ).toBe(403);
        await child.close();
        child = await startWireWorker(transportConfig(fx.config, certs, 3445));
        expect(
          (await second.post("totp", { code }, { cookie: copy })).status,
        ).toBe(403);
        expect(await countAdmissions(p.userId)).toBe(1);
      } finally {
        await child.close();
      }
    },
  );
  scenario(
    "common ingress quota is atomic across two processes and restart with an anchored window",
    async () => {
      const child = await startWireWorker(
        transportConfig(fx.config, certs, 3445),
      );
      const clients = [
        new WireClient(certs.ca),
        new WireClient(certs.ca, 3445),
      ];
      let used = 0,
        denied = 0;
      try {
        for (let batch = 0; batch < 16; batch++) {
          const results = await Promise.all(
            Array.from({ length: 8 }, (_, i) => clients[i % 2].post("session")),
          );
          used += results.filter((r) => r.status === 401).length;
          denied += results.filter((r) => r.status === 429).length;
          expect(
            results.every((r) => r.status === 401 || r.status === 429),
          ).toBe(true);
        }
        expect(used).toBe(120);
        expect(denied).toBe(8);
      } finally {
        await child.close();
      }
      const before = (
        await fx.migration.query<{ start: string; end: string; used: number }>(
          "SELECT window_start::text start,window_end::text end,used FROM control_private.budgets",
        )
      ).rows;
      expect(before.length).toBe(1);
      expect(before[0].used).toBe(120);
      const restarted = await startWireWorker(
        transportConfig(fx.config, certs, 3445),
      );
      try {
        expect((await clients[1].post("session")).status).toBe(429);
        const logout = await clients[0].post("signOut");
        expect(logout.status).toBe(429);
        expect(allCookiesCleared(logout)).toBe(true);
      } finally {
        await restarted.close();
      }
      const after = (
        await fx.migration.query(
          "SELECT window_start::text start,window_end::text end,used FROM control_private.budgets",
        )
      ).rows;
      expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
    },
  );
  scenario(
    "two-worker odd-five password boundary has exactly five charges and never extends denial",
    async () => {
      const p = await fx.createPrincipal(),
        child = await startWireWorker(transportConfig(fx.config, certs, 3445)),
        clients = [new WireClient(certs.ca), new WireClient(certs.ca, 3445)];
      try {
        for (let batch = 0; batch < 4; batch++) {
          const results = await Promise.all(
            clients.map((client) =>
              client.post("password", {
                email: p.email,
                password: p.password + "invalid",
              }),
            ),
          );
          expect(results.map((r) => r.status)).toEqual([403, 403]);
          expect(
            results.every(
              (r) => r.cookies.length === 0 && r.applicationDisabled,
            ),
          ).toBe(true);
        }
        const prepared = (
          await fx.migration.query<{ n: number }>(
            "SELECT count(*)::integer n FROM control_private.attempts WHERE user_id=$1",
            [p.userId],
          )
        ).rows[0].n;
        expect(prepared).toBe(5);
        const sql =
          "SELECT used,window_start::text start,window_end::text end FROM control_private.budgets WHERE key_mac IN(control_private.mac('budget-account-password',$1::text),control_private.mac('budget-ip-password','unknown')) ORDER BY key_mac";
        const before = (
          await fx.migration.query<{
            used: number;
            start: string;
            end: string;
          }>(sql, [p.email])
        ).rows;
        expect(before.length).toBe(2);
        expect(before.every((row) => row.used === 5)).toBe(true);
        expect(
          (
            await clients[1].post("password", {
              email: p.email,
              password: p.password + "invalid",
            })
          ).status,
        ).toBe(403);
        const after = (await fx.migration.query(sql, [p.email])).rows;
        expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
        expect(await countAdmissions(p.userId)).toBe(0);
      } finally {
        await child.close();
      }
    },
  );
  scenario(
    "eight-way password pressure stays fail-closed without an availability guarantee",
    async () => {
      const p = await fx.createPrincipal(),
        child = await startWireWorker(transportConfig(fx.config, certs, 3445)),
        clients = [new WireClient(certs.ca), new WireClient(certs.ca, 3445)];
      try {
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            clients[i % 2].post("password", {
              email: p.email,
              password: p.password + "invalid",
            }),
          ),
        );
        expect(results.every((r) => r.status === 403 || r.status === 503)).toBe(
          true,
        );
        expect(
          results.every((r) => r.cookies.length === 0 && r.applicationDisabled),
        ).toBe(true);
        const budgets = (
          await fx.migration.query<{ used: number }>(
            "SELECT used FROM control_private.budgets WHERE key_mac IN(control_private.mac('budget-account-password',$1::text),control_private.mac('budget-ip-password','unknown'))",
            [p.email],
          )
        ).rows;
        expect(
          budgets.every(
            (row) =>
              Number.isInteger(row.used) && row.used >= 0 && row.used <= 5,
          ),
        ).toBe(true);
        expect(await countAdmissions(p.userId)).toBe(0);
      } finally {
        await child.close();
      }
    },
  );
  scenario(
    "wrong TOTP never creates a wire grant and shared account failures remain charged",
    async () => {
      const p = await fx.createPrincipal(),
        client = new WireClient(certs.ca);
      await client.post("password", { email: p.email, password: p.password });
      const result = await client.post("totp", { code: await wrongCode(p) });
      expect(result.status).toBe(403);
      expect(result.cookies.length).toBe(0);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );
  scenario(
    "raw no-length request is rejected before body interpretation without Node auto-framing",
    async () => {
      const result = await new WireClient(certs.ca).raw(
        `POST ${WIRE_PATHS.session} HTTP/1.1\r\nHost: bookstore-transport.invalid:3443\r\nOrigin: https://bookstore-transport.invalid:3443\r\nX-Bookstore-CSRF: 1\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`,
      );
      expect(result.status).toBe(411);
      expect(result.cookies).toBe(false);
      expect(result.applicationDisabled).toBe(true);
    },
  );
  scenario(
    "global twenty-password ceiling retains the stricter maintained native three-per-ten-second policy",
    async () => {
      const principals = [];
      for (let i = 0; i < 21; i++) principals.push(await fx.createPrincipal());
      const child = await startWireWorker(
          transportConfig(fx.config, certs, 3445),
        ),
        clients = [new WireClient(certs.ca), new WireClient(certs.ca, 3445)];
      try {
        let nativeAllowed = 0,
          nativeDenied = 0;
        for (let i = 0; i < 20; i++) {
          const p = principals[i];
          const result = await clients[i % 2].post("password", {
            email: p.email,
            password: p.password,
          });
          expect(result.status === 200 || result.status === 403).toBe(true);
          if (result.status === 200) {
            nativeAllowed++;
            expect(result.state).toBe("mfa-required");
          } else {
            nativeDenied++;
            expect(result.cookies.length).toBe(0);
          }
        }
        expect(nativeAllowed > 0 && nativeDenied > 0).toBe(true);
        const prepared = (
          await fx.migration.query<{ n: number }>(
            "SELECT count(*)::integer n FROM control_private.attempts WHERE user_id=ANY($1::text[])",
            [principals.slice(0, 20).map((p) => p.userId)],
          )
        ).rows[0].n;
        expect(prepared).toBe(20);
        const accounts = (
          await fx.migration.query<{ n: number }>(
            "SELECT count(*)::integer n FROM control_private.budgets WHERE used=1",
          )
        ).rows[0].n;
        expect(accounts).toBe(20);
        const before = (
          await fx.migration.query<{
            start: string;
            end: string;
            used: number;
          }>(
            "SELECT window_start::text start,window_end::text end,used FROM control_private.budgets WHERE used=20",
          )
        ).rows;
        // Both ingress and password-IP have20uses at this point; identify the
        // unchanged row after the21st valid request increments ingress only.
        expect(before.length).toBe(2);
        const p = principals[20];
        const denied = await clients[0].post("password", {
          email: p.email,
          password: p.password,
        });
        expect(denied.status).toBe(403);
        expect(denied.cookies.length).toBe(0);
        const after = (
          await fx.migration.query<{
            start: string;
            end: string;
            used: number;
          }>(
            "SELECT window_start::text start,window_end::text end,used FROM control_private.budgets WHERE used=20",
          )
        ).rows;
        expect(after.length).toBe(1);
        expect(
          before.some(
            (row) => JSON.stringify(row) === JSON.stringify(after[0]),
          ),
        ).toBe(true);
        const attempts = (
          await fx.migration.query<{ n: number }>(
            "SELECT count(*)::integer n FROM control_private.attempts WHERE user_id=$1",
            [p.userId],
          )
        ).rows[0].n;
        expect(attempts).toBe(0);
      } finally {
        await child.close();
      }
    },
  );
  scenario(
    "twenty common-IP MFA reservations include login and distinct wrong step-up codes across workers",
    async () => {
      const child = await startWireWorker(
        transportConfig(fx.config, certs, 3445),
      );
      try {
        const admitted = [
          await login(new WireClient(certs.ca)),
          await login(new WireClient(certs.ca, 3445)),
          await login(new WireClient(certs.ca)),
        ];
        const codes: string[][] = [];
        for (const entry of admitted) {
          const valid = new Set([
            await fx.code(entry.principal, -1),
            await fx.code(entry.principal),
            await fx.code(entry.principal, 1),
          ]);
          codes.push(
            Array.from({ length: 12 }, (_, i) => String(100000 + i))
              .filter((value) => !valid.has(value))
              .slice(0, 7),
          );
        }
        for (let i = 0; i < 17; i++) {
          const index = i % 3,
            round = Math.floor(i / 3);
          const result = await admitted[index].client.post("stepUp", {
            code: codes[index][round],
          });
          expect(result.status).toBe(403);
          expect(result.cookies.length).toBe(0);
        }
        const before = (
          await fx.migration.query<{
            start: string;
            end: string;
            used: number;
          }>(
            "SELECT window_start::text start,window_end::text end,used FROM control_private.budgets WHERE used=20",
          )
        ).rows;
        expect(before.length).toBe(1);
        const denied = await admitted[2].client.post("stepUp", {
          code: codes[2][5],
        });
        expect(denied.status).toBe(403);
        expect(denied.cookies.length).toBe(0);
        const after = (
          await fx.migration.query(
            "SELECT window_start::text start,window_end::text end,used FROM control_private.budgets WHERE used=20",
          )
        ).rows;
        expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
        const burns = (
          await fx.migration.query<{ n: number }>(
            "SELECT count(*)::integer n FROM control_private.replay_burns b JOIN control_private.attempts a USING(code_mac) WHERE a.user_id=ANY($1::text[])",
            [admitted.map((entry) => entry.principal.userId)],
          )
        ).rows[0].n;
        expect(burns).toBe(20);
        const accounts = (
          await fx.migration.query<{ used: number }>(
            "SELECT used FROM control_private.budgets WHERE key_mac IN(SELECT control_private.mac('budget-account-mfa',x.user_id) FROM unnest($1::text[]) AS x(user_id)) ORDER BY used",
            [admitted.map((entry) => entry.principal.userId)],
          )
        ).rows;
        expect(accounts.map((row) => row.used)).toEqual([6, 7, 7]);
      } finally {
        await child.close();
      }
    },
  );
  scenario(
    "known cancellation wins a governance-blocked actual HTTPS MFA request",
    async () => {
      const p = await fx.createPrincipal(),
        client = new WireClient(certs.ca);
      expect(
        (
          await client.post("password", {
            email: p.email,
            password: p.password,
          })
        ).status,
      ).toBe(200);
      const cookie = client.jar.header;
      await fx.staff.query("BEGIN");
      let pending: Promise<Awaited<ReturnType<WireClient["post"]>>> | undefined;
      try {
        await fx.staff.query("SELECT staff.reserve_transport_request()");
        const pid = (
          await fx.staff.query<{ pid: number }>("SELECT pg_backend_pid() pid")
        ).rows[0].pid;
        pending = client.post(
          "totp",
          { code: await fx.code(p) },
          { cookie, absorb: false },
        );
        let observed = false;
        for (let round = 0; round < 200; round++) {
          const row = await fx.migration.query<{ blocked: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))) blocked",
            [pid],
          );
          if (row.rows[0].blocked) {
            observed = true;
            break;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(observed).toBe(true);
        const cancellation = await fx.staff.query<{
          decision: { allowed: boolean };
        }>("SELECT staff.cancel_transport_context($1::text) decision", [
          cookie,
        ]);
        expect(cancellation.rows[0].decision.allowed).toBe(true);
        await fx.staff.query("COMMIT");
        const result = await pending;
        expect(result.status).toBe(403);
        expect(result.cookies.length).toBe(0);
        expect(await countAdmissions(p.userId)).toBe(0);
        expect(
          (await client.post("totp", { code: await fx.code(p) }, { cookie }))
            .status,
        ).toBe(403);
      } finally {
        await fx.staff.query("ROLLBACK");
        if (pending) await pending.catch(() => undefined);
      }
    },
  );
  scenario(
    "logout by the old primary context defeats later application of a buffered finalized cookie",
    async () => {
      const p = await fx.createPrincipal(),
        client = new WireClient(certs.ca);
      await client.post("password", { email: p.email, password: p.password });
      const old = client.jar.header;
      const completed = await client.post(
        "totp",
        { code: await fx.code(p) },
        { cookie: old, absorb: false },
      );
      expect(completed.status).toBe(200);
      expect(await countAdmissions(p.userId)).toBe(1);
      const logout = await client.post("signOut", {}, { cookie: old });
      expect(logout.status).toBe(200);
      expect(allCookiesCleared(logout)).toBe(true);
      client.jar.absorb(completed.cookies);
      const retained = await client.post("session");
      expect(retained.status).toBe(401);
      expect(await countAdmissions(p.userId)).toBe(0);
    },
  );
  scenario(
    "absolute deadline denies even with a recent idle timestamp and never resets epoch",
    async () => {
      const admitted = await login();
      await fx.migration.query(
        `WITH boundary AS MATERIALIZED(SELECT clock_timestamp() n), changed AS(UPDATE staff.admissions SET authenticated_at=boundary.n-interval '9 hours',last_seen_at=boundary.n-interval '1 minute' FROM boundary WHERE session_id=$1 RETURNING session_id,authenticated_at) UPDATE control_private.session_controls c SET authenticated_at=a.authenticated_at,absolute_deadline=a.authenticated_at+interval '8 hours' FROM changed a WHERE c.session_id=a.session_id`,
        [admitted.sessionId],
      );
      const before = await snapshot(admitted.sessionId);
      expect((await admitted.client.post("session")).status).toBe(401);
      expect(
        JSON.stringify(before) ===
          JSON.stringify(await snapshot(admitted.sessionId)),
      ).toBe(true);
    },
  );
  scenario(
    "post-comparison native factor persistence faults return no new cookie or raw console error",
    async () => {
      const p = await fx.createPrincipal(),
        client = new WireClient(certs.ca);
      await client.post("password", { email: p.email, password: p.password });
      await fx.migration.query(
        "CREATE FUNCTION public.wire_fail_factor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic wire factor fault' USING ERRCODE='P0001'; END $$",
      );
      await fx.migration.query(
        'CREATE TRIGGER wire_fail_factor BEFORE UPDATE ON identity."TwoFactor" FOR EACH ROW EXECUTE FUNCTION public.wire_fail_factor()',
      );
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await client.post("totp", { code: await fx.code(p) });
        expect(result.status).toBe(503);
        expect(result.cookies.length).toBe(0);
        expect(result.applicationDisabled).toBe(true);
        expect(log.mock.calls.length).toBe(0);
        expect(await countAdmissions(p.userId)).toBe(0);
      } finally {
        log.mockRestore();
        await fx.migration.query(
          'DROP TRIGGER wire_fail_factor ON identity."TwoFactor"',
        );
        await fx.migration.query("DROP FUNCTION public.wire_fail_factor()");
      }
    },
  );
  scenario(
    "raw forty-nine and sixty-four header tails fail without protected security-state changes",
    async () => {
      const client = new WireClient(certs.ca),
        before = await protectedStateWitness();
      for (const total of [49, 64]) {
        const base = [
          `Host: bookstore-transport.invalid:3443`,
          "X-Bookstore-CSRF: 1",
          "Content-Type: application/json",
          "Content-Length: 2",
          "Connection: close",
        ];
        const fillers = Array.from(
          { length: total - base.length - 1 },
          (_, i) => `X-Synthetic-${i}: bounded`,
        );
        // The sole Origin is deliberately the last header: silently truncating a
        // header list must never turn this into an authorized generic request.
        const wire = `POST ${WIRE_PATHS.session} HTTP/1.1\r\n${[...base, ...fillers, "Origin: https://bookstore-transport.invalid:3443"].join("\r\n")}\r\n\r\n{}`;
        const result = await client.raw(wire);
        expect(result.status).toBe(400);
        expect(result.cookies).toBe(false);
        expect(result.applicationDisabled).toBe(true);
        expect((await protectedStateWitness()) === before).toBe(true);
      }
    },
  );
  scenario(
    "actual client disconnect after committed SDK session and blocked evidence revokes undelivered context",
    async () => {
      const p = await fx.createPrincipal(),
        client = new WireClient(certs.ca);
      expect(
        (
          await client.post("password", {
            email: p.email,
            password: p.password,
          })
        ).status,
      ).toBe(200);
      const before = (
        await fx.migration.query<{ n: number }>(
          'SELECT count(*)::integer n FROM identity."Session" WHERE "userId"=$1',
          [p.userId],
        )
      ).rows[0].n;
      const blocker = await fx.client(fx.owned.migrationUrl);
      let locked = false,
        created = false,
        triggered = false,
        operation: ReturnType<WireClient["abortablePost"]> | undefined;
      let settled:
        | Promise<{
            aborted: boolean;
            receivedResponse: boolean;
            authorized: boolean;
          } | null>
        | undefined;
      try {
        await fx.migration.query(
          "CREATE FUNCTION public.wire_pause_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(624320018::bigint); RETURN NEW; END $$",
        );
        created = true;
        await fx.migration.query(
          "REVOKE ALL ON FUNCTION public.wire_pause_evidence() FROM PUBLIC",
        );
        await fx.migration.query(
          "CREATE TRIGGER wire_pause_evidence BEFORE INSERT ON audit.events FOR EACH ROW WHEN(NEW.action='control.evidence') EXECUTE FUNCTION public.wire_pause_evidence()",
        );
        triggered = true;
        await blocker.query("SELECT pg_advisory_lock(624320018::bigint)");
        locked = true;
        const pid = (
          await blocker.query<{ pid: number }>("SELECT pg_backend_pid() pid")
        ).rows[0].pid;
        operation = client.abortablePost("totp", { code: await fx.code(p) });
        settled = operation.done.then(
          (result) => result,
          () => null,
        );
        let observed = false;
        const until = performance.now() + 5000;
        for (let turn = 0; turn < 2000 && performance.now() < until; turn++) {
          const row = await fx.migration.query<{ blocked: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=$2 AND $1::integer=ANY(pg_blocking_pids(pid))) blocked",
            [pid, new URL(fx.owned.verifierUrl).username],
          );
          if (row.rows[0].blocked) {
            observed = true;
            break;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(observed).toBe(true);
        const committed = (
          await fx.migration.query<{ n: number }>(
            'SELECT count(*)::integer n FROM identity."Session" WHERE "userId"=$1',
            [p.userId],
          )
        ).rows[0].n;
        expect(committed > before).toBe(true);
        operation.abort();
        const disconnected = await settled;
        expect(
          disconnected !== null &&
            disconnected.aborted &&
            disconnected.authorized &&
            !disconnected.receivedResponse,
        ).toBe(true);
        await blocker.query("SELECT pg_advisory_unlock(624320018::bigint)");
        locked = false;
        let retired = false;
        const deadline = performance.now() + 5000;
        for (
          let turn = 0;
          turn < 2000 && performance.now() < deadline;
          turn++
        ) {
          const row = await fx.migration.query<{ safe: boolean }>(
            `SELECT a.state='revoked' AND a.final_session_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM staff.admissions s WHERE s.user_id=a.user_id)
          AND NOT EXISTS(SELECT 1 FROM control_private.session_controls c WHERE c.user_id=a.user_id)
          AND NOT EXISTS(SELECT 1 FROM audit.events e WHERE e.subject_id=a.user_id AND e.action='control.login')
          AND NOT EXISTS(SELECT 1 FROM identity."Session" s WHERE s.id=a.final_session_id)
          AND EXISTS(SELECT 1 FROM control_private.replay_burns b WHERE b.code_mac=a.code_mac AND b.expires_at>clock_timestamp()) safe
          FROM control_private.attempts a WHERE a.user_id=$1 AND a.purpose='login' ORDER BY a.authenticated_at DESC LIMIT 1`,
            [p.userId],
          );
          if (row.rows[0]?.safe) {
            retired = true;
            break;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(retired).toBe(true);
        expect(await countAdmissions(p.userId)).toBe(0);
      } finally {
        operation?.abort();
        if (locked)
          await blocker.query("SELECT pg_advisory_unlock(624320018::bigint)");
        if (settled) await settled;
        if (triggered)
          await fx.migration.query(
            "DROP TRIGGER wire_pause_evidence ON audit.events",
          );
        if (created)
          await fx.migration.query(
            "DROP FUNCTION public.wire_pause_evidence()",
          );
        await fx.release(blocker);
      }
    },
  );
  for (const [name, change] of [
    [
      "disabled opt-in",
      (base: ReturnType<typeof transportConfig>) => ({
        ...base,
        enabled: false,
      }),
    ],
    [
      "HTTP origin",
      (base: ReturnType<typeof transportConfig>) => ({
        ...base,
        origin: "http://bookstore-transport.invalid:3443",
      }),
    ],
    [
      "non-loopback hostname",
      (base: ReturnType<typeof transportConfig>) => ({
        ...base,
        origin: "https://foreign.invalid:3443",
      }),
    ],
    [
      "unapproved port",
      (base: ReturnType<typeof transportConfig>) => ({
        ...base,
        origin: "https://bookstore-transport.invalid:443",
      }),
    ],
    [
      "weak secret",
      (base: ReturnType<typeof transportConfig>) => ({
        ...base,
        secret: "short",
      }),
    ],
    [
      "unknown config key",
      (base: ReturnType<typeof transportConfig>) => ({ ...base, provider: {} }),
    ],
    [
      "invalid TLS key",
      (base: ReturnType<typeof transportConfig>) => ({
        ...base,
        tls: { ...base.tls, key: "invalid" },
      }),
    ],
    [
      "expired TLS leaf",
      (base: ReturnType<typeof transportConfig>) => ({
        ...base,
        tls: { ...base.tls, ...certs.faults.expired },
      }),
    ],
    [
      "wrong SAN TLS leaf",
      (base: ReturnType<typeof transportConfig>) => ({
        ...base,
        tls: { ...base.tls, ...certs.faults.wrongSan },
      }),
    ],
  ] as const)
    scenario(`configuration rejects ${name} before listening`, async () => {
      let rejected = false;
      try {
        const candidate = await startRestrictedHttpsTestTransport(
          change(transportConfig(fx.config, certs)) as ReturnType<
            typeof transportConfig
          >,
        );
        await candidate.close();
      } catch (error) {
        rejected =
          error instanceof Error &&
          error.message ===
            "Restricted HTTPS test transport configuration rejected.";
      }
      expect(rejected).toBe(true);
    });
  scenario(
    "production and missing explicit test process gates deny before listening",
    async () => {
      for (const gate of ["production", "missing"]) {
        try {
          if (gate === "production") vi.stubEnv("NODE_ENV", "production");
          else vi.stubEnv("BOOKSTORE_RESTRICTED_HTTPS_TEST", undefined);
          let rejected = false;
          try {
            await startRestrictedHttpsTestTransport(
              transportConfig(fx.config, certs),
            );
          } catch (error) {
            rejected =
              error instanceof Error &&
              error.message ===
                "Restricted HTTPS test transport configuration rejected.";
          }
          expect(rejected).toBe(true);
        } finally {
          vi.unstubAllEnvs();
        }
      }
    },
  );
});
