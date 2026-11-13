import "server-only";
import type { AsyncLocalStorage } from "node:async_hooks";
import type { TransportRoute } from "../../../src/server/security/https-transport-policy";

/** Nonshipping test-host descriptor; not a header, MFA receipt or client API. */
export const NEXT_SECURITY_HOST = Symbol.for(
  "bookstore.isolated-next-security.host.v1",
);
export type ActionPurpose = "probe" | "revoke-self" | "sign-out";
export type SecurityState =
  | "denied"
  | "unavailable"
  | "rate-limited"
  | "mfa-required"
  | "verified-test-session"
  | "signed-out"
  | "revoked";
export interface SecurityResult {
  readonly status: number;
  readonly state: SecurityState;
  readonly applicationAdmission: "disabled";
}
export interface CookieResult extends SecurityResult {
  readonly cookies: readonly string[];
}
export interface NextSecurityConfig {
  readonly enabled: true;
  readonly origin: string;
  readonly authUrl: string;
  readonly staffUrl: string;
  readonly verifierUrl: string;
  readonly secret: string;
  readonly csrfSecret: string;
  readonly tls: Readonly<{ key: string; cert: string; ca: string }>;
}
export interface TrustedWire {
  readonly path: string;
  readonly method: string;
  readonly origin: string;
  readonly cookie: string;
  readonly contentLength: number;
  readonly complete: () => boolean;
  readonly aborted: () => boolean;
  /** Denial-only cleanup binding, never evidence/identity authority. */
  readonly stageCookie: (cookie: string) => void;
}
/** Functions are server-only. None accepts a claimed actor, permission or target. */
export interface NextSecurityRequest {
  readonly path: string;
  readonly method: string;
  readonly cookieNames: readonly string[];
  cookiesMatch(nextCookieHeader: string): boolean;
  issueCsrf(purpose: ActionPurpose): string;
  verifyCsrf(purpose: ActionPurpose, value: unknown): boolean;
  read(): Promise<SecurityResult>;
  auth(route: TransportRoute, body: Uint8Array): Promise<CookieResult>;
  revokeSelf(): Promise<SecurityResult>;
  signOut(): Promise<SecurityResult>;
}
export interface NextSecurityService {
  forRequest(wire: TrustedWire): NextSecurityRequest;
  cancelUndelivered(cookie: string): Promise<void>;
  close(): Promise<void>;
}
export interface NextSecurityHost {
  readonly config: NextSecurityConfig;
  readonly requests: AsyncLocalStorage<TrustedWire>;
  readonly service: NextSecurityService | null;
  publish(service: NextSecurityService): void;
}
export function securityHost(): NextSecurityHost | null {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    NEXT_SECURITY_HOST,
  );
  if (
    !descriptor ||
    descriptor.enumerable ||
    descriptor.configurable ||
    descriptor.writable ||
    !("value" in descriptor)
  )
    return null;
  return descriptor.value as NextSecurityHost;
}
export function nextSecurityRequest(): NextSecurityRequest {
  const host = securityHost();
  const wire = host?.requests.getStore();
  if (!host?.service || !wire)
    throw new Error("Isolated security request unavailable.");
  return host.service.forRequest(wire);
}
export const deniedSecurityResult: SecurityResult = Object.freeze({
  status: 403,
  state: "denied",
  applicationAdmission: "disabled",
});
