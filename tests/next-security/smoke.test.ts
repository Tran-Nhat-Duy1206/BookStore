import { randomBytes } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { ControlFixtures, secretSafe } from "../admission-controls/fixtures";
import {
  createTransportCertificates,
  type TransportCertificateFixture,
} from "../https-transport/certificates";
import {
  NextWireClient,
  nativeAction,
  nextConfig,
  startNextProcess,
  type NextProcess,
} from "./client";
const fx = new ControlFixtures();
let certs: TransportCertificateFixture, child: NextProcess;
beforeAll(() =>
  secretSafe(async () => {
    certs = await createTransportCertificates();
    await fx.start();
    child = await startNextProcess(
      nextConfig(fx.config, certs, randomBytes(48).toString("hex")),
    );
  }),
);
afterAll(() =>
  secretSafe(async () => {
    await child?.close();
    await fx.stop();
    await certs?.close();
  }),
);
describe("actual production-built isolated Next HTTPS feasibility", () => {
  it("binds Route Handler, RSC and direct native multipart Action to real SDK+SQL admission", () =>
    secretSafe(async () => {
      const principal = await fx.createPrincipal(),
        client = new NextWireClient(certs.ca);
      const anonymous = await client.page();
      expect(
        anonymous.authorized &&
          anonymous.noStore &&
          anonymous.body.includes('data-live-guard="denied-test-session"'),
      ).toBe(true);
      const primary = await client.post("password", {
        email: principal.email,
        password: principal.password,
      });
      expect(primary.status).toBe(200);
      expect(primary.state).toBe("mfa-required");
      const firstFactor = await client.page();
      expect(
        firstFactor.body.includes('data-live-guard="denied-test-session"'),
      ).toBe(true);
      const code = await fx.code(principal),
        final = await client.post("totp", { code });
      if (final.status !== 200) {
        const states = (
          await fx.migration.query(
            "SELECT state,count(*)::integer n FROM control_private.attempts WHERE user_id=$1 GROUP BY state",
            [principal.userId],
          )
        ).rows;
        const count = (state: string) =>
          states.find((row) => row.state === state)?.n ?? 0;
        console.info(
          `Synthetic Next route diagnostic entered=${child.logContains("BookStore Next TOTP route entered.")}, decoded=${child.logContains("BookStore Next TOTP route decoded")}, nextMismatch=${child.logContains("nextJar=false")}, rawMismatch=${child.logContains("rawJar=false")}, nativeForbidden=${child.logContains("BookStore Next TOTP operation status=403.")}.`,
        );
        console.info(
          `Synthetic Next MFA stage bound=${count("bound")}, reserved=${count("reserved")}, ready=${count("ready")}, consumed=${count("consumed")}, cancelled=${count("cancelled")}, cookies=${client.jar.size}, frameworkDisturbed=${child.logContains("disturbed")}.`,
        );
      }
      expect(final.status).toBe(200);
      expect(final.state).toBe("verified-test-session");
      const page = await client.page();
      expect(
        page.authorized &&
          page.noStore &&
          page.cookies.length === 0 &&
          !page.location &&
          page.body.includes('data-live-guard="admitted-test-session"'),
      ).toBe(true);
      const probe = nativeAction(page.body, "probe"),
        revoke = nativeAction(page.body, "revoke-self");
      expect(probe !== null && revoke !== null).toBe(true);
      if (!probe || !revoke)
        throw new Error("Synthetic native Action reference missing.");
      const token = client.jar.header.split("=", 2)[1];
      expect(
        !page.body.includes(principal.password) &&
          !page.body.includes(principal.secret) &&
          !page.body.includes(code) &&
          !!token &&
          !page.body.includes(token),
      ).toBe(true);
      const beforeActions = await child.diagnostics();
      const called = await client.action(probe.id, probe.csrf);
      expect(
        called.authorized &&
          called.noStore &&
          !called.location &&
          called.status === 200,
      ).toBe(true);
      const flight = await client.action(probe.id, probe.csrf, {}, true);
      expect(
        flight.status === 200 &&
          flight.noStore &&
          !flight.location &&
          flight.cookies.length === 0,
      ).toBe(true);
      const revoked = await client.action(revoke.id, revoke.csrf);
      expect(revoked.status).toBe(200);
      const afterActions = await child.diagnostics();
      expect(
        beforeActions.servicePublications === 1 &&
          afterActions.servicePublications === 1 &&
          beforeActions.outgoingHttpRequests === 0 &&
          afterActions.outgoingHttpRequests === 0 &&
          afterActions.ingressRequests - beforeActions.ingressRequests === 3 &&
          afterActions.tlsErrors === 0,
      ).toBe(true);
      const denied = await client.page();
      expect(
        denied.body.includes('data-live-guard="denied-test-session"'),
      ).toBe(true);
      expect(
        !child.logContains(principal.password) &&
          !child.logContains(principal.secret) &&
          !child.logContains(token),
      ).toBe(true);
    }));
});
