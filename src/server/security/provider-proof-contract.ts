/**
 * Proposed B.2a metadata comparison only: NOT authentication or admission proof.
 * A private server-only parent factory must construct observations only after real
 * SDK TOTP success and actual cookie-authoritative SDK session resolution, and
 * reject references absent from its private WeakSet BEFORE calling this function.
 * A structurally valid client forgery/serialized copy can match these bindings.
 * Candidate factories default to no staff admission and null versions; neither
 * SDK success nor matching metadata establishes staff authority.
 *
 * Missing future proof protocol (B.2b, not implemented here): issuer/audience/jti,
 * private challenge, credential + factor + original session lineage, expiry,
 * authenticated signature, cross-challenge/cross-purpose OTP replay protection,
 * and atomic durable consumption + admission + audit. No issuer, signer,
 * cryptographic verifier, replay cache or persistence is provided by this module.
 * Keep server-only markers on the provider/kernel parents, not this pure module.
 */
export type ProviderMfaObservation = {
  readonly kind: "sdk-totp-observation";
  readonly observationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly purpose:
    | "login-investigation"
    | "active-session-investigation"
    | "enrollment-investigation";
  /** Conservative MFA freshness lower bound, NOT the algorithm's exact clock. */
  readonly operationStartedAt: string;
  readonly operationCompletedAt: string;
  readonly authorizationVersionBefore: number | null;
  readonly authorizationVersionAfter: number | null;
  readonly priorSessionId: string | null;
  readonly factorIdsBefore: readonly string[];
  readonly factorIdsAfter: readonly string[];
  readonly staffAdmission: "not-established";
  readonly durable: false;
};

export type ProviderProofBindingContext = {
  readonly userId: string;
  readonly sessionId: string;
  readonly authorizationVersion: number;
  readonly purpose: ProviderMfaObservation["purpose"];
  readonly factorIds: readonly string[];
  readonly revoked: boolean;
};

export type ProposedMfaBindingReason =
  | "bindings-match-not-authorizing"
  | "malformed"
  | "identity-mismatch"
  | "session-mismatch"
  | "purpose-mismatch"
  | "version-mismatch"
  | "factor-lineage-mismatch"
  | "revoked"
  | "enrollment-reverification-required";

export type ProposedMfaBindingAssessment = {
  readonly bindingsMatch: boolean;
  readonly admissionAllowed: false;
  readonly reason: ProposedMfaBindingReason;
};

const observationKeys = [
  "kind",
  "observationId",
  "userId",
  "sessionId",
  "purpose",
  "operationStartedAt",
  "operationCompletedAt",
  "authorizationVersionBefore",
  "authorizationVersionAfter",
  "priorSessionId",
  "factorIdsBefore",
  "factorIdsAfter",
  "staffAdmission",
  "durable",
] as const;
const contextKeys = [
  "userId",
  "sessionId",
  "authorizationVersion",
  "purpose",
  "factorIds",
  "revoked",
] as const;

// Only own data fields: do not execute getters or accept inherited/private flags.
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    value.trim() === value &&
    (/^[A-Za-z0-9]+$/.test(value) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      ))
  );
}

function version(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function purpose(value: unknown): value is ProviderMfaObservation["purpose"] {
  return (
    value === "login-investigation" ||
    value === "active-session-investigation" ||
    value === "enrollment-investigation"
  );
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function factors(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return null;
  const copy: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !id(descriptor.value))
      return null;
    copy.push(descriptor.value);
  }
  return new Set(copy).size === copy.length ? copy : null;
}

function sameFactors(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((factor) => right.includes(factor))
  );
}

function result(
  reason: ProposedMfaBindingReason,
): ProposedMfaBindingAssessment {
  return Object.freeze({
    bindingsMatch: reason === "bindings-match-not-authorizing",
    admissionAllowed: false,
    reason,
  });
}

/** Pure design comparison; never authenticates callers, issues proof or authorizes admission. */
export function assessProposedMfaBinding(
  observation: unknown,
  context: unknown,
): ProposedMfaBindingAssessment {
  try {
    const observed = record(observation, observationKeys);
    const current = record(context, contextKeys);
    if (!observed || !current) return result("malformed");
    const beforeFactors = factors(observed.factorIdsBefore);
    const afterFactors = factors(observed.factorIdsAfter);
    const currentFactors = factors(current.factorIds);
    if (
      observed.kind !== "sdk-totp-observation" ||
      !id(observed.observationId) ||
      !id(observed.userId) ||
      !id(observed.sessionId) ||
      !purpose(observed.purpose) ||
      !timestamp(observed.operationStartedAt) ||
      !timestamp(observed.operationCompletedAt) ||
      observed.operationStartedAt > observed.operationCompletedAt ||
      (observed.authorizationVersionBefore !== null &&
        !version(observed.authorizationVersionBefore)) ||
      (observed.authorizationVersionAfter !== null &&
        !version(observed.authorizationVersionAfter)) ||
      (observed.priorSessionId !== null && !id(observed.priorSessionId)) ||
      !beforeFactors ||
      !afterFactors ||
      observed.staffAdmission !== "not-established" ||
      observed.durable !== false ||
      !id(current.userId) ||
      !id(current.sessionId) ||
      !version(current.authorizationVersion) ||
      !purpose(current.purpose) ||
      !currentFactors ||
      typeof current.revoked !== "boolean"
    )
      return result("malformed");

    // Enrollment is invalidating, even if a caller supplies the new current version.
    // Never rebase authorizationVersionBefore to authorizationVersionAfter.
    if (observed.purpose === "enrollment-investigation")
      return result("enrollment-reverification-required");
    if (current.revoked) return result("revoked");
    if (observed.userId !== current.userId) return result("identity-mismatch");
    if (observed.sessionId !== current.sessionId)
      return result("session-mismatch");
    if (observed.purpose !== current.purpose) return result("purpose-mismatch");
    if (
      observed.authorizationVersionBefore === null ||
      observed.authorizationVersionAfter === null ||
      observed.authorizationVersionBefore !==
        observed.authorizationVersionAfter ||
      observed.authorizationVersionBefore !== current.authorizationVersion
    )
      return result("version-mismatch");
    if (
      beforeFactors.length === 0 ||
      !sameFactors(beforeFactors, afterFactors) ||
      !sameFactors(beforeFactors, currentFactors)
    )
      return result("factor-lineage-mismatch");
    return result("bindings-match-not-authorizing");
  } catch {
    // Hostile proxies/descriptor traps must never leak values or exception details.
    return result("malformed");
  }
}
