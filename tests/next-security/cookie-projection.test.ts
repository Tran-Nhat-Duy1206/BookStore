import { describe, expect, it } from "vitest";
import {
  RequestCookies,
  ResponseCookies,
} from "next/dist/compiled/@edge-runtime/cookies";
import { nextCookieHeader } from "../../experiments/next-security/app/_lib/cookie-header";
import {
  canonicalTransportCookie,
  parseTransportCookie,
  providerCookiePolicy,
} from "../../src/server/security/https-transport-policy";
const prefix = "__Secure-bookstore-provider-proof.";
const names = [
  "account_data",
  "dont_remember",
  "session_data",
  "session_token",
  "two_factor",
].map((name) => prefix + name);
const policy = providerCookiePolicy(names),
  name = prefix + "two_factor",
  value = "public-fixture.token+signature=",
  raw = `${name}=${encodeURIComponent(value)}`;
function same(header: string) {
  const parsed = parseTransportCookie(header, policy);
  return parsed !== null && canonicalTransportCookie(parsed) === raw;
}
describe("pinned Next awaited-cookie name/value projection only", () => {
  it("preserves readonly RSC request-cookie grammar", () => {
    const store = new RequestCookies(new Headers({ cookie: raw }));
    expect(same(nextCookieHeader(store))).toBe(true);
  });
  it("demonstrates mutable Next serialization is Set-Cookie not request grammar", () => {
    const store = new ResponseCookies(new Headers());
    store.set(name, value, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
    });
    expect(
      store.toString().includes("Path=/") &&
        parseTransportCookie(store.toString(), policy) === null,
    ).toBe(true);
  });
  it("projects mutable Route cookies without dropping original value/signature", () => {
    const store = new ResponseCookies(new Headers());
    store.set(name, value, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
    });
    expect(same(nextCookieHeader(store))).toBe(true);
  });
  it("projects mutable Action cookies identically to readonly RSC cookies", () => {
    const readonly = new RequestCookies(new Headers({ cookie: raw })),
      mutable = new ResponseCookies(new Headers());
    for (const cookie of readonly.getAll()) mutable.set(cookie);
    expect(nextCookieHeader(mutable) === nextCookieHeader(readonly)).toBe(true);
  });
  it("retains entire jar while strict existing policy canonicalizes ordering", () => {
    const store = new ResponseCookies(new Headers());
    for (const name of [...names].reverse()) store.set(name, "public-value");
    const parsed = parseTransportCookie(nextCookieHeader(store), policy);
    expect(
      parsed !== null &&
        parsed.size === 5 &&
        [...parsed.values()].every((value) => value === "public-value"),
    ).toBe(true);
  });
  it("rejects more than five names rather than filtering them", () => {
    expect(() =>
      nextCookieHeader({
        getAll: () =>
          Array.from({ length: 6 }, (_, index) => ({
            name: `fixture${index}`,
            value: "public",
          })),
      }),
    ).toThrow("Isolated Next cookie projection denied.");
  });
  it("does not treat an unknown projected name as authority", () => {
    const header = nextCookieHeader({
      getAll: () => [{ name: "forged_actor", value: "public" }],
    });
    expect(parseTransportCookie(header, policy) === null).toBe(true);
  });
  it("original duplicate cookie grammar still denies independently of Next deduplication", () => {
    const original = `${raw}; ${raw}`,
      store = new RequestCookies(new Headers({ cookie: original }));
    expect(
      store.getAll().length === 1 &&
        parseTransportCookie(original, policy) === null,
    ).toBe(true);
  });
  it("percent-encodes decoded values exactly once", () => {
    const store = new RequestCookies(new Headers({ cookie: raw }));
    expect(nextCookieHeader(store) === raw).toBe(true);
  });
  it("empty Next jar remains empty and never becomes an actor claim", () => {
    expect(nextCookieHeader(new ResponseCookies(new Headers()))).toBe("");
  });
});
