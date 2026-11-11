import "server-only";

import { X509Certificate, createPrivateKey } from "node:crypto";
import { createServer, type Server } from "node:https";
import { TLSSocket, createSecureContext } from "node:tls";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertFoundationUrl } from "./database-config";
import { createDormantAdmissionControls } from "./provider-proof";
import {
  MAX_TRANSPORT_BODY,
  TEST_PROBE_PATH,
  TEST_TRANSPORT_HOST,
  TEST_TRANSPORT_PORTS,
  TRANSPORT_PATHS,
  applyTransportCookies,
  canonicalTransportCookie,
  cleanLoginCookies,
  clearTransportCookies,
  isActiveTransportJar,
  parseTransportBody,
  parseTransportCookie,
  providerCookiePolicy,
  type TransportRoute,
} from "./https-transport-policy";

export interface RestrictedHttpsTestTransportConfig {
  enabled: true;
  origin: string;
  authUrl: string;
  staffUrl: string;
  verifierUrl: string;
  secret: string;
  tls: { key: string; cert: string; ca: string };
}
function exactData(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === "string" &&
        keys.includes(key) &&
        !!descriptor &&
        "value" in descriptor
      );
    })
  );
}
function certificatePem(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length < 32768 &&
    /^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----\r?\n?$/.test(
      value,
    )
  );
}
/** Public TLS material validation, not authentication proof or an injected clock. */
function validTls(
  value: unknown,
): value is RestrictedHttpsTestTransportConfig["tls"] {
  try {
    if (
      !exactData(value, ["key", "cert", "ca"]) ||
      typeof value.key !== "string" ||
      value.key.length > 32768 ||
      !certificatePem(value.cert) ||
      !certificatePem(value.ca)
    )
      return false;
    const leaf = new X509Certificate(value.cert);
    const ca = new X509Certificate(value.ca);
    const key = createPrivateKey(value.key);
    const now = Date.now();
    const valid = (cert: X509Certificate) => {
      const start = Date.parse(cert.validFrom);
      const end = Date.parse(cert.validTo);
      return (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start <= now &&
        end > now &&
        end - start <= 86401000
      );
    };
    const sans = leaf.subjectAltName?.split(", ") ?? [];
    const allowedSans = new Set([
      `DNS:${TEST_TRANSPORT_HOST}`,
      "DNS:other.bookstore-transport.invalid",
      "IP Address:127.0.0.1",
    ]);
    return (
      valid(leaf) &&
      valid(ca) &&
      ca.ca &&
      !leaf.ca &&
      leaf.checkIssued(ca) &&
      leaf.verify(ca.publicKey) &&
      ca.verify(ca.publicKey) &&
      leaf.checkPrivateKey(key) &&
      key.asymmetricKeyType === "rsa" &&
      (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 3072 &&
      leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1") === true &&
      leaf.checkHost(TEST_TRANSPORT_HOST, {
        subject: "never",
        wildcards: false,
      }) === TEST_TRANSPORT_HOST &&
      leaf.checkIP("127.0.0.1") === "127.0.0.1" &&
      sans.length >= 2 &&
      sans.every((san) => allowedSans.has(san))
    );
  } catch {
    return false;
  }
}
function configuration(value: unknown): RestrictedHttpsTestTransportConfig {
  try {
    // No imports/listeners/SQL setup before these process + explicit gates.
    if (
      process.env.NODE_ENV !== "test" ||
      process.env.BOOKSTORE_RESTRICTED_HTTPS_TEST !== "1" ||
      !exactData(value, [
        "enabled",
        "origin",
        "authUrl",
        "staffUrl",
        "verifierUrl",
        "secret",
        "tls",
      ]) ||
      value.enabled !== true ||
      typeof value.origin !== "string" ||
      !/^https:\/\/bookstore-transport\.invalid:(3443|3445)$/.test(
        value.origin,
      ) ||
      typeof value.authUrl !== "string" ||
      typeof value.staffUrl !== "string" ||
      typeof value.verifierUrl !== "string" ||
      typeof value.secret !== "string" ||
      Buffer.byteLength(value.secret) < 32 ||
      value.secret.length > 1024 ||
      /\s/.test(value.secret) ||
      !validTls(value.tls)
    )
      throw new Error();
    const origin = new URL(value.origin);
    if (
      origin.origin !== value.origin ||
      !TEST_TRANSPORT_PORTS.includes(Number(origin.port) as 3443 | 3445)
    )
      throw new Error();
    const auth = new URL(assertFoundationUrl(value.authUrl, "auth"));
    const staff = new URL(assertFoundationUrl(value.staffUrl, "staff"));
    const verifier = new URL(
      assertFoundationUrl(value.verifierUrl, "verifier"),
    );
    if (
      [staff, verifier].some(
        (url) =>
          url.hostname !== auth.hostname ||
          url.port !== auth.port ||
          url.pathname !== auth.pathname,
      )
    )
      throw new Error();
    return Object.freeze({
      enabled: true,
      origin: value.origin,
      authUrl: auth.href,
      staffUrl: staff.href,
      verifierUrl: verifier.href,
      secret: value.secret,
      tls: Object.freeze({
        key: value.tls.key,
        cert: value.tls.cert,
        ca: value.tls.ca,
      }),
    });
  } catch {
    throw new Error("Restricted HTTPS test transport configuration rejected.");
  }
}
const responseHeaders = {
  "cache-control": "private, no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy":
    "default-src 'none'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  connection: "close",
};
function json(
  res: ServerResponse,
  status: number,
  state: string,
  cookies: readonly string[] = [],
) {
  if (res.destroyed || res.headersSent) return;
  const body = JSON.stringify({ state, applicationAdmission: "disabled" });
  res.writeHead(status, {
    ...responseHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...(cookies.length ? { "set-cookie": [...cookies] } : {}),
  });
  res.end(body);
}
function failureStatus(reason: string): number {
  return reason === "rate_limited" ? 429 : reason === "unavailable" ? 503 : 401;
}
function failureState(status: number): string {
  return status === 429
    ? "rate-limited"
    : status >= 500
      ? "unavailable"
      : "denied";
}
const forbiddenHeader = (name: string) =>
  name === "forwarded" ||
  name.startsWith("x-forwarded-") ||
  [
    "x-real-ip",
    "cf-connecting-ip",
    "true-client-ip",
    "fastly-client-ip",
    "x-client-ip",
    "x-cluster-client-ip",
    "x-original-forwarded-for",
    "x-http-method-override",
    "x-method-override",
    "x-original-url",
    "x-rewrite-url",
    "x-bookstore-client-ip",
  ].includes(name);
function rawHeaders(req: IncomingMessage): Map<string, string[]> | null {
  if (req.rawHeaders.length > 96 || req.rawHeaders.length % 2) return null;
  const map = new Map<string, string[]>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    const value = req.rawHeaders[i + 1];
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) ||
      /[^\x20-\x7e]/.test(value) ||
      forbiddenHeader(name)
    )
      return null;
    const entries = map.get(name) ?? [];
    entries.push(value);
    map.set(name, entries);
  }
  // No duplicate headers, even where an HTTP generic framework would combine.
  if ([...map.values()].some((values) => values.length !== 1)) return null;
  if (
    [
      "transfer-encoding",
      "trailer",
      "upgrade",
      "expect",
      "content-encoding",
    ].some((name) => map.has(name))
  )
    return null;
  return map;
}
async function readBody(
  req: IncomingMessage,
  length: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > length || size > MAX_TRANSPORT_BODY) return null;
      chunks.push(bytes);
    }
    return size === length ? Buffer.concat(chunks) : null;
  } catch {
    return null;
  }
}
/** Only this standalone opt-in factory can dispatch private fixed operations.
 * Never import/call from Next app/routes/RSC/Actions or promote into production.
 */
export async function startRestrictedHttpsTestTransport(
  value: RestrictedHttpsTestTransportConfig,
) {
  const config = configuration(value);
  const controls = await createDormantAdmissionControls({
    authUrl: config.authUrl,
    staffUrl: config.staffUrl,
    verifierUrl: config.verifierUrl,
    secret: config.secret,
  });
  let server: Server | undefined;
  try {
    if (!controls.transportSupported) throw new Error();
    const cookiePolicy = providerCookiePolicy(controls.cookieNames);
    const origin = new URL(config.origin);
    const port = Number(origin.port);
    const host = origin.host;
    const secureContext = createSecureContext({
      ...config.tls,
      minVersion: "TLSv1.3",
    });
    const ownedSockets = new WeakSet<object>();
    const cleanup = new Set<Promise<unknown>>();
    let inflight = 0;
    let window = performance.now();
    let localUsed = 0;
    let closing = false;
    const denyUndelivered = (cookie: string) => {
      const work = controls.signOut(cookie).catch(() => undefined);
      cleanup.add(work);
      void work.finally(() => cleanup.delete(work));
    };
    const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
      let finalCredential: string | null = null;
      res.once("finish", () => {
        finalCredential = null;
      });
      res.once("close", () => {
        if (finalCredential && !res.writableFinished)
          denyUndelivered(finalCredential);
        finalCredential = null;
      });
      const headers = rawHeaders(req);
      const socket = req.socket;
      if (
        closing ||
        !(socket instanceof TLSSocket) ||
        !socket.encrypted ||
        socket.localAddress !== "127.0.0.1" ||
        socket.remoteAddress !== "127.0.0.1" ||
        socket.localPort !== port ||
        socket.servername !== TEST_TRANSPORT_HOST ||
        req.httpVersion !== "1.1" ||
        !headers ||
        headers.get("host")?.[0] !== host
      ) {
        json(res, 403, "denied");
        return;
      }
      if (ownedSockets.has(socket)) {
        socket.destroy();
        return;
      }
      ownedSockets.add(socket);
      const target = req.url;
      if (target === TEST_PROBE_PATH && req.method === "GET") {
        if (
          headers.has("content-length") &&
          headers.get("content-length")?.[0] !== "0"
        ) {
          json(res, 400, "denied");
          return;
        }
        const doc =
          '<!doctype html><html><head><meta charset="utf-8"><title>Isolated transport probe</title></head><body></body></html>';
        res.writeHead(200, {
          ...responseHeaders,
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(doc),
        });
        res.end(doc);
        return;
      }
      const route = Object.entries(TRANSPORT_PATHS).find(
        ([, path]) => path === target,
      )?.[0] as TransportRoute | undefined;
      if (!route) {
        json(res, 404, "denied");
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, "denied");
        return;
      }
      if (
        headers.get("origin")?.[0] !== config.origin ||
        headers.get("x-bookstore-csrf")?.[0] !== "1" ||
        (headers.has("sec-fetch-site") &&
          headers.get("sec-fetch-site")?.[0] !== "same-origin")
      ) {
        json(res, 403, "denied");
        return;
      }
      const type = headers.get("content-type")?.[0];
      if (
        type !== "application/json" &&
        type !== "application/json; charset=utf-8"
      ) {
        json(res, 415, "denied");
        return;
      }
      const lengthText = headers.get("content-length")?.[0];
      if (!lengthText || !/^(0|[1-9][0-9]{0,3})$/.test(lengthText)) {
        json(res, 411, "denied");
        return;
      }
      const length = Number(lengthText);
      if (length > MAX_TRANSPORT_BODY) {
        json(res, 413, "denied");
        return;
      }
      const now = performance.now();
      if (now - window >= 60000) {
        window = now;
        localUsed = 0;
      }
      if (inflight >= 16 || ++localUsed > 256) {
        json(
          res,
          503,
          "unavailable",
          route === "signOut" ? clearTransportCookies(cookiePolicy) : [],
        );
        return;
      }
      inflight++;
      try {
        req.setTimeout(3000, () => req.destroy());
        res.setTimeout(6000, () => res.destroy());
        const bytes = await readBody(req, length);
        const body = bytes && parseTransportBody(bytes, route);
        if (!body || req.aborted || res.destroyed || !socket.writable) {
          json(
            res,
            400,
            "denied",
            route === "signOut" ? clearTransportCookies(cookiePolicy) : [],
          );
          return;
        }
        const jar = parseTransportCookie(
          headers.get("cookie")?.[0] ?? "",
          cookiePolicy,
        );
        if (!jar) {
          json(
            res,
            400,
            "denied",
            route === "signOut" ? clearTransportCookies(cookiePolicy) : [],
          );
          return;
        }
        const budget = await controls.reserveTransport();
        if (route === "signOut") {
          // Presented active contexts only; helpers never become cancellation or
          // authentication claims. A malformed/mixed jar cannot select user IDs.
          const contexts = [cookiePolicy.session, cookiePolicy.challenge]
            .filter((name) => jar.has(name))
            .map((name) =>
              canonicalTransportCookie(new Map([[name, jar.get(name)!]])),
            );
          if (!contexts.length) contexts.push("");
          let succeeded = true;
          for (const context of contexts) {
            const outcome = await controls.signOut(context);
            if (!outcome.response.ok) succeeded = false;
          }
          const status = !succeeded
            ? 503
            : !budget.allowed
              ? failureStatus(budget.reason)
              : 200;
          json(
            res,
            status,
            status === 200 ? "signed-out" : failureState(status),
            clearTransportCookies(cookiePolicy),
          );
          return;
        }
        if (!budget.allowed) {
          const status = failureStatus(budget.reason);
          json(res, status, failureState(status));
          return;
        }
        if (route === "password") {
          const primary = await controls.password(body.email, body.password);
          if (!primary.response.ok) {
            json(
              res,
              primary.response.status,
              failureState(primary.response.status),
            );
            return;
          }
          const updates = cleanLoginCookies(
            primary.response.headers.getSetCookie(),
            cookiePolicy,
          );
          const next = applyTransportCookies(
            new Map(),
            primary.response.headers.getSetCookie(),
            cookiePolicy,
          );
          finalCredential = canonicalTransportCookie(next.jar);
          if (res.destroyed || req.aborted) {
            denyUndelivered(finalCredential);
            finalCredential = null;
            return;
          }
          json(res, 200, "mfa-required", updates);
          return;
        }
        const kind = route === "totp" ? "challenge" : "session";
        if (!isActiveTransportJar(jar, cookiePolicy, kind)) {
          json(res, 401, "denied");
          return;
        }
        const cookie = canonicalTransportCookie(jar);
        if (route === "session") {
          const checked = await controls.check(cookie);
          const status = checked.allowed ? 200 : failureStatus(checked.reason);
          json(
            res,
            status,
            checked.allowed ? "verified-test-session" : failureState(status),
          );
          return;
        }
        const verified =
          route === "totp"
            ? await controls.verifyTotp(body.code, cookie)
            : await controls.stepUp(body.code, cookie);
        if (!verified.response.ok || !verified.evidenceHandle) {
          const status = verified.response.ok ? 503 : verified.response.status;
          json(res, status, failureState(status));
          return;
        }
        const projected = applyTransportCookies(
          jar,
          verified.response.headers.getSetCookie(),
          cookiePolicy,
        );
        if (!isActiveTransportJar(projected.jar, cookiePolicy, "session"))
          throw new Error();
        const final = canonicalTransportCookie(projected.jar);
        if (res.destroyed || req.aborted) {
          denyUndelivered(final);
          return;
        }
        const finalized = await controls.finalize(
          verified.evidenceHandle,
          final,
        );
        if (!finalized.response.ok) {
          json(
            res,
            finalized.response.status,
            failureState(finalized.response.status),
          );
          return;
        }
        finalCredential = final;
        if (res.destroyed || req.aborted) {
          denyUndelivered(final);
          finalCredential = null;
          return;
        }
        json(res, 200, "verified-test-session", projected.updates);
      } catch {
        json(
          res,
          503,
          "unavailable",
          route === "signOut" ? clearTransportCookies(cookiePolicy) : [],
        );
      } finally {
        inflight--;
      }
    };
    server = createServer(
      {
        key: config.tls.key,
        cert: config.tls.cert,
        minVersion: "TLSv1.3",
        handshakeTimeout: 3000,
        maxHeaderSize: 8192,
        headersTimeout: 3000,
        requestTimeout: 5000,
        keepAliveTimeout: 1000,
        connectionsCheckingInterval: 1000,
        insecureHTTPParser: false,
        SNICallback(name, callback) {
          if (name !== TEST_TRANSPORT_HOST) callback(new Error("Unavailable"));
          else callback(null, secureContext);
        },
      },
      (req, res) => {
        void dispatch(req, res).catch(() => json(res, 503, "unavailable"));
      },
    );
    server.maxConnections = 32;
    server.maxHeadersCount = 48;
    server.on("checkContinue", (_req, res) => json(res, 417, "denied"));
    server.on("checkExpectation", (_req, res) => json(res, 417, "denied"));
    server.on("upgrade", (_req, socket) => socket.destroy());
    server.on("tlsClientError", () => {
      /* No private TLS/request/peer logs. */
    });
    server.on("clientError", (_error, socket) => {
      const body = '{"state":"denied","applicationAdmission":"disabled"}';
      if (socket.writable)
        socket.end(
          `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nCache-Control: private, no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      else socket.destroy();
    });
    const listener = server;
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new Error("Unavailable"));
      listener.once("error", failed);
      listener.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        listener.removeListener("error", failed);
        resolve();
      });
    });
    listener.on("error", () => {
      closing = true;
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      origin: config.origin,
      close() {
        if (!closePromise)
          closePromise = (async () => {
            closing = true;
            await new Promise<void>((resolve) =>
              listener.close(() => resolve()),
            );
            await Promise.allSettled([...cleanup]);
            await controls.close();
          })();
        return closePromise;
      },
    });
  } catch {
    if (server?.listening)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await controls.close().catch(() => undefined);
    throw new Error("Restricted HTTPS test transport unavailable.");
  }
}
export type RestrictedHttpsTestTransport = Awaited<
  ReturnType<typeof startRestrictedHttpsTestTransport>
>;
