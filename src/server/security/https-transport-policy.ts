import "server-only";

/** B.2c deliberately narrow wire grammar. These helpers are NOT identity/proof. */
export const TEST_TRANSPORT_HOST = "bookstore-transport.invalid";
export const TEST_TRANSPORT_PORTS = Object.freeze([3443, 3445] as const);
export const TEST_PROBE_PATH = "/__bookstore_test_probe";
export const TRANSPORT_PATHS = Object.freeze({
  password: "/__bookstore_test_auth/password",
  totp: "/__bookstore_test_auth/totp/verify",
  stepUp: "/__bookstore_test_auth/step-up",
  session: "/__bookstore_test_auth/session",
  signOut: "/__bookstore_test_auth/sign-out",
});
export type TransportRoute = keyof typeof TRANSPORT_PATHS;
export const MAX_TRANSPORT_BODY = 1024;
const prefix = "__Secure-bookstore-provider-proof.";
const expectedNames = Object.freeze(
  [
    "account_data",
    "dont_remember",
    "session_data",
    "session_token",
    "two_factor",
  ]
    .map((suffix) => prefix + suffix)
    .sort(),
);
export type ProviderCookiePolicy = Readonly<{
  names: readonly string[];
  session: string;
  challenge: string;
}>;
export function providerCookiePolicy(
  names: readonly string[],
): ProviderCookiePolicy {
  if (
    !Array.isArray(names) ||
    names.length !== expectedNames.length ||
    [...names].sort().some((name, index) => name !== expectedNames[index])
  )
    throw new Error("Transport cookie policy unavailable.");
  return Object.freeze({
    names: expectedNames,
    session: prefix + "session_token",
    challenge: prefix + "two_factor",
  });
}
export function canonicalTransportCookie(
  jar: ReadonlyMap<string, string>,
): string {
  return [...jar]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
export function parseTransportCookie(
  value: string,
  policy: ProviderCookiePolicy,
): Map<string, string> | null {
  if (value.length > 4096 || /[^\x20-\x7e]/.test(value)) return null;
  const jar = new Map<string, string>();
  if (!value) return jar;
  for (const item of value.split(";")) {
    const split = item.indexOf("=");
    if (split < 1) return null;
    const name = item.slice(0, split).trim();
    const token = item.slice(split + 1).trim();
    if (
      !policy.names.includes(name) ||
      jar.has(name) ||
      !token ||
      /\s/.test(token) ||
      token.length > 2048
    )
      return null;
    try {
      if (/[\x00-\x20\x7f;]/.test(decodeURIComponent(token))) return null;
    } catch {
      return null;
    }
    jar.set(name, token);
  }
  return jar;
}
export function isActiveTransportJar(
  jar: ReadonlyMap<string, string>,
  policy: ProviderCookiePolicy,
  kind: "session" | "challenge",
): boolean {
  return jar.size === 1 && jar.has(policy[kind]);
}
export function clearTransportCookies(policy: ProviderCookiePolicy): string[] {
  return policy.names.map(
    (name) => `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`,
  );
}
/** Treat EACH Set-Cookie as a single header; Expires commas are never separators. */
export function applyTransportCookies(
  input: ReadonlyMap<string, string>,
  updates: readonly string[],
  policy: ProviderCookiePolicy,
): Readonly<{ jar: Map<string, string>; updates: readonly string[] }> {
  if (updates.length > 16)
    throw new Error("Transport cookie projection denied.");
  const jar = new Map(input);
  const seen = new Set<string>();
  for (const line of updates) {
    if (line.length > 4096 || /[^\x20-\x7e]/.test(line))
      throw new Error("Transport cookie projection denied.");
    const parts = line.split(";");
    const first = parts.shift()!;
    const split = first.indexOf("=");
    const name = first.slice(0, split);
    const token = first.slice(split + 1);
    if (split < 1 || !policy.names.includes(name) || seen.has(name))
      throw new Error("Transport cookie projection denied.");
    seen.add(name);
    const attrs = new Map<string, string | true>();
    for (const raw of parts) {
      const part = raw.trim();
      const eq = part.indexOf("=");
      const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
      const attr = eq < 0 ? true : part.slice(eq + 1);
      if (
        ![
          "secure",
          "httponly",
          "samesite",
          "path",
          "max-age",
          "expires",
        ].includes(key) ||
        attrs.has(key)
      )
        throw new Error("Transport cookie projection denied.");
      attrs.set(key, attr);
    }
    if (
      attrs.get("secure") !== true ||
      attrs.get("httponly") !== true ||
      attrs.get("samesite") !== "Strict" ||
      attrs.get("path") !== "/"
    )
      throw new Error("Transport cookie projection denied.");
    const age = attrs.get("max-age");
    if (
      age !== undefined &&
      (typeof age !== "string" ||
        !/^(0|[1-9][0-9]{0,4})$/.test(age) ||
        Number(age) > 28800)
    )
      throw new Error("Transport cookie projection denied.");
    const expires = attrs.get("expires");
    if (
      expires !== undefined &&
      (typeof expires !== "string" || !Number.isFinite(Date.parse(expires)))
    )
      throw new Error("Transport cookie projection denied.");
    const deleting = token.length === 0 || age === "0";
    if (deleting) jar.delete(name);
    else {
      if (
        (name !== policy.session && name !== policy.challenge) ||
        !parseTransportCookie(`${name}=${token}`, policy)
      )
        throw new Error("Transport cookie projection denied.");
      jar.set(name, token);
    }
  }
  return Object.freeze({ jar, updates: Object.freeze([...updates]) });
}
/** Clear stale scopes then replace with validated SDK updates: one final line/name. */
export function cleanLoginCookies(
  updates: readonly string[],
  policy: ProviderCookiePolicy,
): readonly string[] {
  const validated = applyTransportCookies(new Map(), updates, policy);
  if (!isActiveTransportJar(validated.jar, policy, "challenge"))
    throw new Error("Transport primary projection denied.");
  const final = new Map(
    clearTransportCookies(policy).map((line) => [
      line.slice(0, line.indexOf("=")),
      line,
    ]),
  );
  for (const line of validated.updates)
    final.set(line.slice(0, line.indexOf("=")), line);
  return Object.freeze([...final.values()]);
}
export function parseTransportBody(
  bytes: Uint8Array,
  route: TransportRoute,
): Readonly<Record<string, string>> | null {
  if (bytes.byteLength > MAX_TRANSPORT_BODY) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    // Deliberately narrow canonical flat JSON. Native JSON parse is not a
    // duplicate-key detector; round-trip equality also rejects escaped aliases,
    // duplicate (including escaped duplicate) keys and ambiguous encodings.
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      JSON.stringify(value) !== text
    )
      return null;
    const record = value as Record<string, unknown>;
    const wanted =
      route === "password"
        ? ["email", "password"]
        : route === "totp" || route === "stepUp"
          ? ["code"]
          : [];
    const keys = Object.keys(record).sort();
    if (
      keys.join(",") !== [...wanted].sort().join(",") ||
      wanted.some((key) => typeof record[key] !== "string")
    )
      return null;
    if (route === "password") {
      const email = record.email as string;
      const password = record.password as string;
      if (
        email.length < 3 ||
        email.length > 254 ||
        /[\x00-\x20\x7f]/.test(email) ||
        password.length < 1 ||
        password.length > 128
      )
        return null;
    } else if (
      (route === "totp" || route === "stepUp") &&
      !/^[0-9]{6}$/.test(record.code as string)
    )
      return null;
    return Object.freeze(record as Record<string, string>);
  } catch {
    return null;
  }
}
