import { describe, expect, it } from "vitest";
import {
  applyTransportCookies,
  canonicalTransportCookie,
  cleanLoginCookies,
  clearTransportCookies,
  isActiveTransportJar,
  parseTransportBody,
  parseTransportCookie,
  providerCookiePolicy,
  type TransportRoute,
} from "../../src/server/security/https-transport-policy";

const prefix = "__Secure-bookstore-provider-proof.";
const names = [
  "account_data",
  "dont_remember",
  "session_data",
  "session_token",
  "two_factor",
].map((name) => prefix + name);
const policy = providerCookiePolicy(names);
const line = (name: string, value = "dummy.signature", extras = "") =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict${extras}`;
const encode = (text: string) => new TextEncoder().encode(text);

describe("restricted transport flat JSON grammar is not client authority", () => {
  it.each([
    [
      "password",
      '{"email":"synthetic@example.invalid","password":"synthetic fixture only"}',
    ],
    ["totp", '{"code":"000000"}'],
    ["stepUp", '{"code":"000000"}'],
    ["session", "{}"],
    ["signOut", "{}"],
  ] as const)("accepts only the reviewed %s shape", (route, body) => {
    expect(parseTransportBody(encode(body), route) !== null).toBe(true);
  });
  const rejected: [string, TransportRoute, string][] = [
    ["first duplicate key", "totp", '{"code":"111111","code":"000000"}'],
    ["equal duplicate key", "totp", '{"code":"000000","code":"000000"}'],
    [
      "escaped duplicate key",
      "totp",
      '{"code":"111111","co\\u0064e":"000000"}',
    ],
    ["escaped key alias", "totp", '{"co\\u0064e":"000000"}'],
    ["unknown verified flag", "totp", '{"code":"000000","verified":true}'],
    ["user claim", "session", '{"userId":"synthetic"}'],
    ["session claim", "session", '{"sessionId":"synthetic"}'],
    ["role claim", "session", '{"roles":["Owner"]}'],
    [
      "callback field",
      "password",
      '{"email":"synthetic@example.invalid","password":"fixture","callbackURL":"https://foreign.invalid"}',
    ],
    ["redirect field", "signOut", '{"returnTo":"https://foreign.invalid"}'],
    ["nested code", "totp", '{"code":{"value":"000000"}}'],
    ["number code", "totp", '{"code":0}'],
    ["boolean code", "totp", '{"code":true}'],
    ["short code", "totp", '{"code":"00000"}'],
    ["long code", "totp", '{"code":"0000000"}'],
    ["unicode digits", "totp", '{"code":"００００００"}'],
    ["array", "session", "[]"],
    ["null", "session", "null"],
    ["prototype key", "session", '{"__proto__":{}}'],
    ["trailing ambiguity", "session", "{}{}"],
    ["noncanonical whitespace", "session", "{ }"],
    ["oversized body", "session", " ".repeat(1025)],
    [
      "empty password",
      "password",
      '{"email":"synthetic@example.invalid","password":""}',
    ],
    [
      "oversized password",
      "password",
      JSON.stringify({
        email: "synthetic@example.invalid",
        password: "x".repeat(129),
      }),
    ],
    [
      "email control",
      "password",
      JSON.stringify({
        email: "synthetic\n@example.invalid",
        password: "fixture",
      }),
    ],
  ];
  it.each(rejected)("rejects %s", (_name, route, body) => {
    expect(parseTransportBody(encode(body), route) === null).toBe(true);
  });
  it("rejects malformed UTF8 rather than replacement decoding", () => {
    expect(
      parseTransportBody(new Uint8Array([0xc3, 0x28]), "session") === null,
    ).toBe(true);
  });
});

describe("exact SDK cookie scope and final projection", () => {
  it("freezes names and rejects an SDK manifest addition", () => {
    expect(Object.isFrozen(policy) && Object.isFrozen(policy.names)).toBe(true);
    expect(() =>
      providerCookiePolicy([
        ...names,
        "__Secure-bookstore-provider-proof.new_authority",
      ]),
    ).toThrow("Transport cookie policy unavailable.");
  });
  it.each([
    ["duplicate", `${policy.session}=dummy; ${policy.session}=other`],
    ["unknown", "claimed_verified=true"],
    ["control", `${policy.session}=dummy\n`],
    ["encoded control", `${policy.session}=dummy%0a`],
    ["broken URI escape", `${policy.session}=dummy%ZZ`],
    ["empty", `${policy.session}=`],
    ["oversized", `${policy.session}=${"x".repeat(2049)}`],
    ["missing separator", "dummy"],
  ])("rejects %s request cookie", (_label, header) => {
    expect(parseTransportCookie(header, policy) === null).toBe(true);
  });
  it("does not infer a normal session from a mixed challenge/session jar", () => {
    const jar = new Map([
      [policy.session, "dummy"],
      [policy.challenge, "other"],
    ]);
    expect(isActiveTransportJar(jar, policy, "session")).toBe(false);
    expect(isActiveTransportJar(jar, policy, "challenge")).toBe(false);
  });
  it("uses exactly native localeCompare ordering", () => {
    const jar = new Map([
      [policy.session, "dummy"],
      [policy.challenge, "other"],
    ]);
    expect(
      canonicalTransportCookie(jar) ===
        [...jar]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
    ).toBe(true);
  });
  it("cleans all stale owned scopes then emits one replacement per name", () => {
    const output = cleanLoginCookies([line(policy.challenge)], policy);
    expect(output.length === names.length).toBe(true);
    const jar = applyTransportCookies(
      new Map([[policy.session, "stale"]]),
      output,
      policy,
    ).jar;
    expect(isActiveTransportJar(jar, policy, "challenge")).toBe(true);
    expect(
      new Set(output.map((cookie) => cookie.split("=", 1)[0])).size ===
        names.length,
    ).toBe(true);
  });
  it("applies actual rotation and deletion before final binding", () => {
    const next = applyTransportCookies(
      new Map([[policy.challenge, "old"]]),
      [
        line(policy.challenge, "", "; Max-Age=0"),
        line(policy.session, "new.signature", "; Max-Age=28800"),
      ],
      policy,
    );
    expect(isActiveTransportJar(next.jar, policy, "session")).toBe(true);
    expect(next.jar.get(policy.session) === "new.signature").toBe(true);
  });
  it("preserves an Expires comma as one header", () => {
    const update = line(
      policy.session,
      "dummy.signature",
      "; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Max-Age=300",
    );
    const next = applyTransportCookies(new Map(), [update], policy);
    expect(next.updates.length === 1 && next.updates[0] === update).toBe(true);
  });
  const bad = [
    ["missing secure", line(policy.session).replace("; Secure", "")],
    ["missing httponly", line(policy.session).replace("; HttpOnly", "")],
    ["lax", line(policy.session).replace("Strict", "Lax")],
    ["none", line(policy.session).replace("Strict", "None")],
    ["other path", line(policy.session).replace("Path=/", "Path=/other")],
    ["domain", line(policy.session) + "; Domain=bookstore-transport.invalid"],
    ["duplicate path", line(policy.session) + "; Path=/"],
    ["duplicate secure", line(policy.session) + "; Secure"],
    ["conflicting samesite", line(policy.session) + "; SameSite=Lax"],
    ["duplicate maxage", line(policy.session) + "; Max-Age=0; Max-Age=60"],
    ["bad maxage", line(policy.session) + "; Max-Age=-1"],
    ["long maxage", line(policy.session) + "; Max-Age=28801"],
    ["invalid expiry", line(policy.session) + "; Expires=not-a-date"],
    ["cache authority", line(prefix + "session_data")],
    ["account cache authority", line(prefix + "account_data")],
    ["remember authority", line(prefix + "dont_remember")],
    ["unknown SDK authority", line(prefix + "new_authority")],
    ["CRLF", line(policy.session) + "\r\nX-Other: value"],
  ];
  it.each(bad)("rejects %s response cookie", (_label, update) => {
    expect(() => applyTransportCookies(new Map(), [update], policy)).toThrow(
      "Transport cookie projection denied.",
    );
  });
  it("rejects duplicate Set-Cookie names rather than flattening", () => {
    expect(() =>
      applyTransportCookies(
        new Map(),
        [line(policy.session), line(policy.session)],
        policy,
      ),
    ).toThrow("Transport cookie projection denied.");
  });
  it("allows clearing only for otherwise non-authorizing helper names", () => {
    expect(
      applyTransportCookies(new Map(), clearTransportCookies(policy), policy)
        .jar.size === 0,
    ).toBe(true);
  });
});
