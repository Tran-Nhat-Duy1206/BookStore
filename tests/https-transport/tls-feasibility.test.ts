import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:https";
import { connect } from "node:net";
import { rootCertificates, type TLSSocket } from "node:tls";
import { X509Certificate } from "node:crypto";
import {
  createTransportCertificates,
  validateTransportCertificate,
  TRANSPORT_HOST,
  type TransportCertificateFixture,
  type CertificatePeer,
} from "./certificates";

let fixture: TransportCertificateFixture;
async function listener(
  peer: CertificatePeer,
): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const server = createServer(
    { key: peer.key, cert: peer.cert, minVersion: "TLSv1.2" },
    (_req, res) => {
      res.setHeader("Connection", "close");
      res.setHeader(
        "Set-Cookie",
        "synthetic_probe=noncredential; Secure; HttpOnly; SameSite=Strict; Path=/",
      );
      res.end("synthetic TLS probe");
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(new Error("Synthetic TLS listener unavailable.")),
    );
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (
    !address ||
    typeof address === "string" ||
    address.address !== "127.0.0.1"
  )
    throw new Error("Synthetic TLS bind rejected.");
  return {
    server,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error
            ? reject(new Error("Synthetic TLS cleanup unavailable."))
            : resolve(),
        ),
      ),
  };
}
async function outcome(
  peer: CertificatePeer,
  ca?: string,
  hostname = TRANSPORT_HOST,
): Promise<{
  accepted: boolean;
  authorized: boolean;
  cookieFlags: boolean;
  code: string;
}> {
  const running = await listener(peer);
  try {
    return await new Promise((resolve) => {
      const req = request(
        {
          hostname,
          port: running.port,
          path: "/",
          ca,
          rejectUnauthorized: true,
          agent: false,
          lookup: (hostname, options, callback) => {
            if (hostname !== TRANSPORT_HOST && hostname !== "127.0.0.1") {
              callback(new Error("Synthetic DNS scope rejected."), "", 4);
              return;
            }
            if (options.all)
              callback(null, [{ address: "127.0.0.1", family: 4 }]);
            else callback(null, "127.0.0.1", 4);
          },
          timeout: 5000,
        },
        (response) => {
          const authorized = (response.socket as TLSSocket).authorized;
          const cookieFlags =
            response.headers["set-cookie"]?.[0] ===
            "synthetic_probe=noncredential; Secure; HttpOnly; SameSite=Strict; Path=/";
          response.resume();
          response.once("end", () =>
            resolve({
              accepted: response.statusCode === 200,
              authorized,
              cookieFlags,
              code: "",
            }),
          );
        },
      );
      req.once("timeout", () =>
        req.destroy(new Error("Synthetic request timeout.")),
      );
      req.once("error", (error: NodeJS.ErrnoException) =>
        resolve({
          accepted: false,
          authorized: false,
          cookieFlags: false,
          code: /^[A-Z0-9_]+$/.test(error.code ?? "")
            ? error.code!
            : "REQUEST_DENIED",
        }),
      );
      req.end();
    });
  } finally {
    await running.close();
  }
}
describe("actual owned CA and Node HTTPS feasibility (not browser proof)", () => {
  beforeAll(async () => {
    fixture = await createTransportCertificates();
  });
  afterAll(async () => {
    if (fixture) await fixture.close();
  });
  it("validates the generated chain key EKU dates and exact DNS/IP SAN", () => {
    expect(validateTransportCertificate(fixture)).toBe(true);
    const ca = new X509Certificate(fixture.ca);
    expect(ca.ca).toBe(true);
  });
  it("makes an authorized HTTPS DNS request with real noncredential cookie headers", async () => {
    const result = await outcome(fixture, fixture.ca);
    expect(result.accepted).toBe(true);
    expect(result.authorized).toBe(true);
    expect(result.cookieFlags).toBe(true);
  });
  it("validates the IP SAN with normal hostname verification", async () => {
    expect((await outcome(fixture, fixture.ca, "127.0.0.1")).authorized).toBe(
      true,
    );
  });
  it("rejects the root when no custom CA is provided", async () => {
    expect((await outcome(fixture)).accepted).toBe(false);
  });
  it("rejects an unrelated trusted CA", async () => {
    expect((await outcome(fixture, rootCertificates[0])).accepted).toBe(false);
  });
  it("rejects a trusted signature with the wrong SAN", async () => {
    const result = await outcome(fixture.faults.wrongSan, fixture.ca);
    expect(result.accepted).toBe(false);
    expect(result.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(
      validateTransportCertificate({ ...fixture, ...fixture.faults.wrongSan }),
    ).toBe(false);
  });
  it("rejects a trusted but expired leaf", async () => {
    const result = await outcome(fixture.faults.expired, fixture.ca);
    expect(result.accepted).toBe(false);
    expect(result.code).toBe("CERT_HAS_EXPIRED");
    expect(
      validateTransportCertificate({ ...fixture, ...fixture.faults.expired }),
    ).toBe(false);
  });
  it("rejects a trusted but not-yet-valid leaf", async () => {
    const result = await outcome(fixture.faults.future, fixture.ca);
    expect(result.accepted).toBe(false);
    expect(result.code).toBe("CERT_NOT_YET_VALID");
    expect(
      validateTransportCertificate({ ...fixture, ...fixture.faults.future }),
    ).toBe(false);
  });
  it("rejects a mismatched private key before any application authority", () => {
    expect(
      validateTransportCertificate({
        ...fixture,
        key: fixture.faults.wrongSan.key,
      }),
    ).toBe(false);
  });
  it("never invokes HTTP handling for plaintext on its TLS port", async () => {
    const running = await listener(fixture);
    let calls = 0;
    running.server.on("request", () => {
      calls++;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: running.port });
        socket.setTimeout(5000, () =>
          socket.destroy(new Error("Synthetic plaintext timeout.")),
        );
        socket.on("data", () => {});
        socket.once("error", () =>
          reject(new Error("Synthetic plaintext probe unavailable.")),
        );
        socket.once("close", () => resolve());
        socket.once("connect", () =>
          socket.end(
            "GET / HTTP/1.1\r\nHost: bookstore-transport.invalid\r\n\r\n",
          ),
        );
      });
      expect(calls).toBe(0);
    } finally {
      await running.close();
    }
  });
});
