import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createDormantAdmissionControls } from "../../../src/server/security/provider-proof";
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
} from "../../../src/server/security/https-transport-policy";
import {
  securityHost,
  type ActionPurpose,
  type CookieResult,
  type NextSecurityService,
  type SecurityResult,
  type SecurityState,
  type TrustedWire,
} from "./context";

const result = (status: number, state?: SecurityState): SecurityResult =>
  Object.freeze({
    status,
    state:
      state ??
      (status === 429
        ? "rate-limited"
        : status >= 500
          ? "unavailable"
          : "denied"),
    applicationAdmission: "disabled",
  });
const cookieResult = (
  value: SecurityResult,
  cookies: readonly string[] = [],
): CookieResult =>
  Object.freeze({ ...value, cookies: Object.freeze([...cookies]) });
const reasonStatus = (reason: string) =>
  reason === "rate_limited" ? 429 : reason === "unavailable" ? 503 : 401;
let initialization: Promise<void> | undefined;

/** Next instrumentation only. No trusted custom-host carrier => no pools/I/O. */
export async function initializeNextSecurityService(): Promise<void> {
  const host = securityHost();
  if (!host || host.service) return;
  if (initialization) return initialization;
  initialization = (async () => {
    if (
      process.env.BOOKSTORE_ISOLATED_NEXT_TEST !== "1" ||
      process.env.NODE_ENV !== "production"
    )
      throw new Error("Isolated Next security configuration rejected.");
    const config = host.config;
    let controls: Awaited<ReturnType<typeof createDormantAdmissionControls>>;
    try {
      controls = await createDormantAdmissionControls({
        authUrl: config.authUrl,
        staffUrl: config.staffUrl,
        verifierUrl: config.verifierUrl,
        secret: config.secret,
      });
    } catch (error) {
      // Match ONLY the canonical factory's fixed redacted strings. Never print
      // an error/stack/SQL/URL/configuration or infer a clock cause from a path.
      const message = error instanceof Error ? error.message : "";
      const phase =
        message === "metadataUnavailable"
          ? "authority-probe"
          : message === "Dormant native provider unavailable."
            ? "native-provider"
            : message === "Invalid dormant provider configuration."
              ? "configuration"
              : "unclassified";
      console.info(
        `BookStore Next canonical construction rejected phase=${phase}.`,
      );
      throw new Error("Isolated Next canonical construction unavailable.");
    }
    try {
      if (!controls.transportSupported) throw new Error();
      const policy = providerCookiePolicy(controls.cookieNames);
      let closed = false;
      const cleanup = new Set<Promise<unknown>>();
      const cancelUndelivered = async (cookie: string) => {
        // Only a captured browser credential, never a claimed actor/session ID.
        try {
          await controls.signOut(cookie);
        } catch {
          /* Static unavailable at caller. */
        }
      };
      const service: NextSecurityService = Object.freeze({
        forRequest(wire: TrustedWire) {
          const jar = parseTransportCookie(wire.cookie, policy);
          const cookie = jar && canonicalTransportCookie(jar);
          let readAllowed = false;
          const viable = () =>
            !closed && !wire.aborted() && wire.complete() && cookie !== null;
          const checkedCookie = () =>
            viable() &&
            jar !== null &&
            isActiveTransportJar(jar, policy, "session");
          const mac = (purpose: ActionPurpose, issued: string, nonce: string) =>
            createHmac("sha256", config.csrfSecret)
              .update(
                JSON.stringify([
                  "bookstore-next-action-csrf-v1",
                  purpose,
                  config.origin,
                  cookie,
                  issued,
                  nonce,
                ]),
              )
              .digest("hex");
          const budget = async (): Promise<SecurityResult | null> => {
            if (!viable()) return result(503);
            const charged = await controls.reserveTransport();
            return charged.allowed
              ? null
              : result(reasonStatus(charged.reason));
          };
          const read = async (): Promise<SecurityResult> => {
            try {
              const limited = await budget();
              if (limited) return limited;
              if (!checkedCookie()) return result(401);
              const live = await controls.check(cookie);
              if (!viable()) return result(503);
              readAllowed = live.allowed;
              return live.allowed
                ? result(200, "verified-test-session")
                : result(reasonStatus(live.reason));
            } catch {
              return result(503);
            }
          };
          const signOut = async (): Promise<SecurityResult> => {
            try {
              if (!viable() || jar === null) return result(503);
              const charged = await controls.reserveTransport();
              const contexts = [policy.session, policy.challenge]
                .filter((name) => jar.has(name))
                .map((name) =>
                  canonicalTransportCookie(new Map([[name, jar.get(name)!]])),
                );
              if (!contexts.length) contexts.push("");
              let confirmed = true;
              for (const context of contexts)
                if (!(await controls.signOut(context)).response.ok)
                  confirmed = false;
              if (!confirmed || !viable()) return result(503);
              return charged.allowed
                ? result(200, "signed-out")
                : result(reasonStatus(charged.reason));
            } catch {
              return result(503);
            }
          };
          return Object.freeze({
            path: wire.path,
            method: wire.method,
            cookieNames: policy.names,
            cookiesMatch(nextCookieHeader: string) {
              if (!viable()) return false;
              const next = parseTransportCookie(nextCookieHeader, policy);
              return next !== null && canonicalTransportCookie(next) === cookie;
            },
            issueCsrf(purpose: ActionPurpose) {
              if (
                !viable() ||
                !["probe", "revoke-self", "sign-out"].includes(purpose) ||
                (purpose !== "sign-out" && !readAllowed)
              )
                throw new Error("Isolated Action request denied.");
              const issued = String(Date.now()),
                nonce = randomBytes(16).toString("hex");
              // Public anti-forgery data; no credential, OTP, identity or proof.
              return `v1.${issued}.${nonce}.${mac(purpose, issued, nonce)}`;
            },
            verifyCsrf(purpose: ActionPurpose, value: unknown) {
              if (
                !viable() ||
                wire.method !== "POST" ||
                wire.path !== "/__bookstore_next_security" ||
                !["probe", "revoke-self", "sign-out"].includes(purpose) ||
                typeof value !== "string"
              )
                return false;
              const fields =
                /^v1\.([0-9]{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value);
              if (!fields) return false;
              const age = Date.now() - Number(fields[1]);
              if (age < -1000 || age > 120000) return false;
              return timingSafeEqual(
                Buffer.from(fields[3], "hex"),
                Buffer.from(mac(purpose, fields[1], fields[2]), "hex"),
              );
            },
            read,
            signOut,
            async revokeSelf(): Promise<SecurityResult> {
              try {
                const limited = await budget();
                if (limited) return limited;
                if (!checkedCookie()) return result(401);
                const revoked = await controls.revoke(cookie); // No target/body actor.
                return !viable()
                  ? result(503)
                  : revoked.response.ok
                    ? result(200, "revoked")
                    : result(revoked.response.status);
              } catch {
                return result(503);
              }
            },
            async auth(
              route: TransportRoute,
              bytes: Uint8Array,
            ): Promise<CookieResult> {
              let pending: string | null = null;
              try {
                if (
                  !viable() ||
                  jar === null ||
                  wire.method !== "POST" ||
                  bytes.byteLength !== wire.contentLength
                )
                  return cookieResult(result(400));
                const body = parseTransportBody(bytes, route);
                if (!body) return cookieResult(result(400));
                if (route === "signOut")
                  return cookieResult(
                    await signOut(),
                    clearTransportCookies(policy),
                  );
                const limited = await budget();
                if (limited) return cookieResult(limited);
                if (route === "password") {
                  const primary = await controls.password(
                    body.email,
                    body.password,
                  );
                  if (!primary.response.ok)
                    return cookieResult(result(primary.response.status));
                  const updates = cleanLoginCookies(
                    primary.response.headers.getSetCookie(),
                    policy,
                  );
                  const effective = applyTransportCookies(
                    new Map(),
                    primary.response.headers.getSetCookie(),
                    policy,
                  );
                  pending = canonicalTransportCookie(effective.jar);
                  if (!viable()) {
                    await cancelUndelivered(pending);
                    return cookieResult(result(503));
                  }
                  wire.stageCookie(pending);
                  return cookieResult(result(200, "mfa-required"), updates);
                }
                if (
                  !isActiveTransportJar(
                    jar,
                    policy,
                    route === "totp" ? "challenge" : "session",
                  )
                )
                  return cookieResult(result(401));
                if (route === "session") {
                  const live = await controls.check(cookie);
                  return cookieResult(
                    !viable()
                      ? result(503)
                      : live.allowed
                        ? result(200, "verified-test-session")
                        : result(reasonStatus(live.reason)),
                  );
                }
                const native =
                  route === "totp"
                    ? await controls.verifyTotp(body.code, cookie)
                    : await controls.stepUp(body.code, cookie);
                if (!native.response.ok || !native.evidenceHandle)
                  return cookieResult(
                    result(native.response.ok ? 503 : native.response.status),
                  );
                const effective = applyTransportCookies(
                  jar,
                  native.response.headers.getSetCookie(),
                  policy,
                );
                if (!isActiveTransportJar(effective.jar, policy, "session"))
                  throw new Error();
                pending = canonicalTransportCookie(effective.jar);
                if (!viable()) {
                  await cancelUndelivered(pending);
                  return cookieResult(result(503));
                }
                const finalized = await controls.finalize(
                  native.evidenceHandle,
                  pending,
                );
                if (!finalized.response.ok)
                  return cookieResult(result(finalized.response.status));
                if (!viable()) {
                  await cancelUndelivered(pending);
                  return cookieResult(result(503));
                }
                wire.stageCookie(pending);
                return cookieResult(
                  result(200, "verified-test-session"),
                  effective.updates,
                );
              } catch {
                if (pending) {
                  const work = cancelUndelivered(pending);
                  cleanup.add(work);
                  void work.finally(() => cleanup.delete(work));
                }
                return cookieResult(
                  result(503),
                  route === "signOut" ? clearTransportCookies(policy) : [],
                );
              }
            },
          });
        },
        cancelUndelivered,
        async close() {
          closed = true;
          await Promise.allSettled([...cleanup]);
          await controls.close();
        },
      });
      host.publish(service);
    } catch {
      await controls.close();
      throw new Error("Isolated Next security initialization unavailable.");
    }
  })();
  return initialization;
}
