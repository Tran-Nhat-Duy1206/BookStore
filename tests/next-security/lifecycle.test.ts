import { randomBytes } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { ControlFixtures, secretSafe } from "../admission-controls/fixtures";
import {
  createTransportCertificates,
  type TransportCertificateFixture,
} from "../https-transport/certificates";
import {
  nextConfig,
  startNextProcess,
  NextWireClient,
  type NextProcess,
} from "./client";
const fx = new ControlFixtures();
let certs: TransportCertificateFixture, child: NextProcess | undefined;
beforeAll(() =>
  secretSafe(async () => {
    certs = await createTransportCertificates();
    await fx.start();
  }),
);
afterAll(() =>
  secretSafe(async () => {
    await child?.close();
    await fx.stop();
    await certs?.close();
  }),
);
it("supervisor IPC loss closes owned Next listener and pools before a fresh exclusive restart", () =>
  secretSafe(async () => {
    const config = nextConfig(
      fx.config,
      certs,
      randomBytes(48).toString("hex"),
    );
    child = await startNextProcess(config);
    expect((await child.diagnostics()).servicePublications).toBe(1);
    await child.disconnectSupervisor();
    child = undefined;
    // A genuinely new owned process must bind the SAME exclusive port and create
    // its own canonical service. No unrelated listener is reused or terminated.
    child = await startNextProcess(config);
    const response = await new NextWireClient(certs.ca).page();
    expect(
      response.authorized &&
        response.status === 200 &&
        response.noStore &&
        response.body.includes('data-live-guard="denied-test-session"'),
    ).toBe(true);
    const diagnostics = await child.diagnostics();
    expect(
      diagnostics.servicePublications === 1 &&
        diagnostics.outgoingHttpRequests === 0,
    ).toBe(true);
  }));
