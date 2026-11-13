import { X509Certificate, createPrivateKey } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { assertFoundationUrl } from "../../src/server/security/database-config";
import type { NextSecurityConfig } from "./runtime/context";

export const NEXT_HOST = "bookstore-transport.invalid";
export const SECURITY_PAGE = "/__bookstore_next_security";
export const NEXT_AUTH_PATHS = Object.freeze({
  password: "/__bookstore_next_auth/password",
  totp: "/__bookstore_next_auth/totp/verify",
  stepUp: "/__bookstore_next_auth/step-up",
  session: "/__bookstore_next_auth/session",
  signOut: "/__bookstore_next_auth/sign-out",
});
export function exactObject(
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
    own.every(
      (key) =>
        typeof key === "string" &&
        keys.includes(key) &&
        Object.getOwnPropertyDescriptor(value, key)?.get === undefined &&
        "value" in Object.getOwnPropertyDescriptor(value, key)!,
    )
  );
}
export function validateNextSecurityConfig(value: unknown): NextSecurityConfig {
  try {
    if (
      process.env.BOOKSTORE_ISOLATED_NEXT_TEST !== "1" ||
      process.env.NODE_ENV !== "production" ||
      !exactObject(value, [
        "enabled",
        "origin",
        "authUrl",
        "staffUrl",
        "verifierUrl",
        "secret",
        "csrfSecret",
        "tls",
      ]) ||
      value.enabled !== true ||
      typeof value.origin !== "string" ||
      !/^https:\/\/bookstore-transport\.invalid:(3463|3465)$/.test(value.origin)
    )
      throw new Error();
    for (const name of ["secret", "csrfSecret"])
      if (
        typeof value[name] !== "string" ||
        Buffer.byteLength(value[name]) < 48 ||
        value[name].length > 1024 ||
        /\s/.test(value[name])
      )
        throw new Error();
    if (
      value.secret === value.csrfSecret ||
      !exactObject(value.tls, ["key", "cert", "ca"])
    )
      throw new Error();
    const tls = value.tls;
    if (typeof tls.key !== "string" || tls.key.length > 32768)
      throw new Error();
    for (const name of ["cert", "ca"])
      if (
        typeof tls[name] !== "string" ||
        tls[name].length > 32768 ||
        !/^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----\r?\n?$/.test(
          tls[name],
        )
      )
        throw new Error();
    const leaf = new X509Certificate(tls.cert as string),
      ca = new X509Certificate(tls.ca as string),
      key = createPrivateKey(tls.key),
      now = Date.now();
    for (const cert of [leaf, ca])
      if (!(
        Date.parse(cert.validFrom) <= now &&
        Date.parse(cert.validTo) > now &&
        Date.parse(cert.validTo) - Date.parse(cert.validFrom) <= 86401000
      ))
        throw new Error();
    const sans = new Set([
      `DNS:${NEXT_HOST}`,
      "DNS:other.bookstore-transport.invalid",
      "IP Address:127.0.0.1",
    ]);
    if (
      !ca.ca ||
      leaf.ca ||
      !leaf.checkIssued(ca) ||
      !leaf.verify(ca.publicKey) ||
      !ca.verify(ca.publicKey) ||
      !leaf.checkPrivateKey(key) ||
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072 ||
      !leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1") ||
      leaf.checkHost(NEXT_HOST, { subject: "never", wildcards: false }) !==
        NEXT_HOST ||
      leaf.checkIP("127.0.0.1") !== "127.0.0.1" ||
      !leaf.subjectAltName?.split(", ").every((san) => sans.has(san))
    )
      throw new Error();
    const urls = ["auth", "staff", "verifier"].map((purpose) => {
      const raw = value[`${purpose}Url`];
      if (typeof raw !== "string") throw new Error();
      return new URL(
        assertFoundationUrl(raw, purpose as "auth" | "staff" | "verifier"),
      );
    });
    if (
      urls.some(
        (url) => url.host !== urls[0].host || url.pathname !== urls[0].pathname,
      )
    )
      throw new Error();
    return Object.freeze({
      ...value,
      tls: Object.freeze({ ...tls }),
    }) as unknown as NextSecurityConfig;
  } catch {
    throw new Error("Isolated Next security configuration rejected.");
  }
}
const headerNames = new Set([
  "host",
  "origin",
  "cookie",
  "content-type",
  "content-length",
  "connection",
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "referer",
  "cache-control",
  "pragma",
  "priority",
  "upgrade-insecure-requests",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "x-bookstore-csrf",
  "rsc",
  "next-action",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-url",
]);
const denialPreflightHeaders = new Set([
  "access-control-request-method",
  "access-control-request-headers",
]);
export function nextRawHeaders(
  req: IncomingMessage,
): Map<string, string> | null {
  if (req.rawHeaders.length > 96 || req.rawHeaders.length % 2) return null;
  const headers = new Map<string, string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase(),
      value = req.rawHeaders[i + 1];
    if (
      (!headerNames.has(name) &&
        !(req.method === "OPTIONS" && denialPreflightHeaders.has(name))) ||
      headers.has(name) ||
      /[^\x20-\x7e]/.test(value)
    )
      return null;
    headers.set(name, value);
  }
  // Recognize ONLY the browser's fixed denial preflight. This never grants CORS:
  // the outer exact-target method gate must still return 405 before Next/SQL.
  if (
    headers.has("access-control-request-method") ||
    headers.has("access-control-request-headers")
  ) {
    if (
      req.method !== "OPTIONS" ||
      headers.get("access-control-request-method") !== "POST" ||
      headers.get("access-control-request-headers") !==
        "content-type,x-bookstore-csrf"
    )
      return null;
  }
  if (headers.has("rsc") && headers.get("rsc") !== "1") return null;
  if (
    headers.has("next-router-prefetch") &&
    headers.get("next-router-prefetch") !== "1"
  )
    return null;
  if (
    headers.has("next-router-segment-prefetch") &&
    headers.get("next-router-segment-prefetch") !== "/_tree"
  )
    return null;
  if (headers.has("next-url") && headers.get("next-url") !== SECURITY_PAGE)
    return null;
  const tree = headers.get("next-router-state-tree");
  if (tree !== undefined) {
    if (tree.length > 2048) return null;
    let count = 0;
    const segments = ["", "%5F_bookstore_next_security", "__PAGE__"];
    const refreshMarkers = ["refetch", "inside-shared-layout", "metadata-only"];
    const valid = (value: unknown, depth: number): boolean => {
      if (++count > 48 || depth > 8 || depth >= segments.length) return false;
      if (
        !Array.isArray(value) ||
        value.length < 2 ||
        value.length > 5 ||
        value[0] !== segments[depth]
      )
        return false;
      const routes: unknown = value[1];
      if (!routes || typeof routes !== "object" || Array.isArray(routes))
        return false;
      const entries = Object.entries(routes);
      if (depth === 2) {
        if (entries.length !== 0) return false;
      } else if (
        entries.length !== 1 ||
        entries[0][0] !== "children" ||
        !valid(entries[0][1], depth + 1)
      )
        return false;
      // Pinned prepareFlightRouterStateForRequest strips refresh state/URLs and
      // renderedSearch. Only its null placeholder may occupy slot 2.
      if (value.length >= 3 && value[2] !== null) return false;
      if (
        value.length >= 4 &&
        value[3] !== null &&
        !refreshMarkers.includes(value[3])
      )
        return false;
      // This build has one root layout, no loading/PPR/cache-component hints.
      // Numeric hints are accepted ONLY in their documented tuple position.
      if (
        value.length >= 5 &&
        value[4] !== null &&
        value[4] !== (depth === 0 ? 16 : 0)
      )
        return false;
      return true;
    };
    try {
      // Decode the complete header ONCE. Never decode a physical segment again.
      if (!valid(JSON.parse(decodeURIComponent(tree)), 0)) return null;
    } catch {
      return null;
    }
  }
  return headers;
}
/** Read in non-flowing mode and restore synchronously BEFORE end emits. */
export function bufferAndRestore(
  req: IncomingMessage,
  length: number,
): Promise<Buffer> {
  if (!length) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      settled = false;
    const remove = () => {
      req.removeListener("readable", readable);
      req.removeListener("end", ended);
      req.removeListener("aborted", failed);
      req.removeListener("error", failed);
    };
    const failed = () => {
      if (!settled) {
        settled = true;
        remove();
        reject(new Error("Isolated body unavailable."));
      }
    };
    const ended = () => {
      if (!settled) failed();
    };
    const readable = () => {
      if (settled) return;
      let chunk: Buffer | null;
      while ((chunk = req.read()) !== null) {
        size += chunk.length;
        if (size > length || size > 8192) {
          failed();
          return;
        }
        chunks.push(chunk);
        if (size === length) {
          const body = Buffer.concat(chunks);
          if (req.readableEnded || req.aborted) {
            failed();
            return;
          }
          // Public Readable API permits unshift after EOF is queued but before end.
          req.unshift(body);
          settled = true;
          remove();
          resolveBody(body);
          return;
        }
      }
    };
    req.on("readable", readable);
    req.once("end", ended);
    req.once("aborted", failed);
    req.once("error", failed);
    readable();
  });
}
const csrfShape = /^v1\.[0-9]{13}\.[a-f0-9]{32}\.[a-f0-9]{64}$/;
/** Native multipart/Flight subset for these unbound, single-FormData Actions. */
export async function validActionBody(
  body: Buffer,
  type: string,
  id: string | undefined,
  known: ReadonlySet<string>,
): Promise<boolean> {
  try {
    if (
      !/^multipart\/form-data; boundary=[A-Za-z0-9'()+_,\-./:=?]{1,100}$/.test(
        type,
      )
    )
      return false;
    const form = await new Request(
      "https://bookstore-transport.invalid/__bookstore_next_security",
      {
        method: "POST",
        headers: { "content-type": type },
        body: new Uint8Array(body),
      },
    ).formData();
    if (id) {
      // The pinned streaming React decoder needs referenced FormData FIRST.
      // Its encoder uses root-prefix '' + '_1_' and emits root chunk 0 LAST.
      if (
        !known.has(id) ||
        [...form.keys()].join(",") !== "_1_csrf,0" ||
        form.getAll("0").length !== 1 ||
        form.get("0") !== '["$K1"]' ||
        form.getAll("_1_csrf").length !== 1
      )
        return false;
      const value = form.get("_1_csrf");
      return typeof value === "string" && csrfShape.test(value);
    }
    if ([...form.keys()].length !== 2 || form.getAll("csrf").length !== 1)
      return false;
    const nonce = form.get("csrf");
    const marker = [...form.keys()].find((key) =>
      key.startsWith("$ACTION_ID_"),
    );
    return (
      typeof nonce === "string" &&
      csrfShape.test(nonce) &&
      !!marker &&
      known.has(marker.slice(11)) &&
      form.getAll(marker).length === 1 &&
      form.get(marker) === ""
    );
  } catch {
    return false;
  }
}
