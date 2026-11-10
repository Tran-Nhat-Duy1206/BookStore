import { describe, expect, it } from "vitest";
import {
  assessProposedMfaBinding,
  type ProviderMfaObservation,
  type ProviderProofBindingContext,
  type ProposedMfaBindingReason,
} from "../../src/server/security/provider-proof-contract";

const observation: ProviderMfaObservation = {
  kind: "sdk-totp-observation",
  observationId: "11111111-1111-4111-8111-111111111111",
  userId: "sdkUser01",
  sessionId: "sdkSession01",
  purpose: "login-investigation",
  operationStartedAt: "2026-01-01T00:00:00.000Z",
  operationCompletedAt: "2026-01-01T00:00:01.000Z",
  authorizationVersionBefore: 2,
  authorizationVersionAfter: 2,
  priorSessionId: null,
  factorIdsBefore: ["factor01"],
  factorIdsAfter: ["factor01"],
  staffAdmission: "not-established",
  durable: false,
};
const context: ProviderProofBindingContext = {
  userId: observation.userId,
  sessionId: observation.sessionId,
  authorizationVersion: 2,
  purpose: observation.purpose,
  factorIds: ["factor01"],
  revoked: false,
};

function check(
  observed: unknown,
  current: unknown,
  reason: ProposedMfaBindingReason,
) {
  expect(assessProposedMfaBinding(observed, current)).toEqual({
    bindingsMatch: reason === "bindings-match-not-authorizing",
    admissionAllowed: false,
    reason,
  });
}

describe("proposed provider MFA binding metadata, never authentication", () => {
  it("compares valid bindings without authorizing admission", () => {
    check(observation, context, "bindings-match-not-authorizing");
  });

  it("serialized-copy comparison does not constitute an authenticity guarantee; private parent WeakSet is required", () => {
    const forgedCopy: unknown = JSON.parse(JSON.stringify(observation));
    check(forgedCopy, context, "bindings-match-not-authorizing");
    const parentRecognized = new WeakSet<object>([observation]);
    expect(parentRecognized.has(observation)).toBe(true);
    expect(parentRecognized.has(forgedCopy as object)).toBe(false);
  });

  it("supports active-session investigation, still not admission", () => {
    check(
      {
        ...observation,
        purpose: "active-session-investigation",
        priorSessionId: "sdkSession01",
      },
      { ...context, purpose: "active-session-investigation" },
      "bindings-match-not-authorizing",
    );
  });

  const mismatchCases: [string, object, object, ProposedMfaBindingReason][] = [
    ["identity", { userId: "otherUser" }, {}, "identity-mismatch"],
    ["session", { sessionId: "otherSession" }, {}, "session-mismatch"],
    [
      "purpose",
      {},
      { purpose: "active-session-investigation" },
      "purpose-mismatch",
    ],
    [
      "current version differs from before",
      {},
      { authorizationVersion: 3 },
      "version-mismatch",
    ],
    [
      "after bumped to current cannot rebase before",
      { authorizationVersionAfter: 3 },
      { authorizationVersion: 3 },
      "version-mismatch",
    ],
    [
      "after bumped with old current",
      { authorizationVersionAfter: 3 },
      {},
      "version-mismatch",
    ],
    [
      "no staff version defaults",
      { authorizationVersionBefore: null, authorizationVersionAfter: null },
      {},
      "version-mismatch",
    ],
    [
      "before null",
      { authorizationVersionBefore: null },
      {},
      "version-mismatch",
    ],
    ["after null", { authorizationVersionAfter: null }, {}, "version-mismatch"],
    [
      "new factor",
      { factorIdsAfter: ["factor01", "factor02"] },
      {},
      "factor-lineage-mismatch",
    ],
    ["removed factor", { factorIdsAfter: [] }, {}, "factor-lineage-mismatch"],
    [
      "replaced factor",
      { factorIdsAfter: ["factor02"] },
      {},
      "factor-lineage-mismatch",
    ],
    [
      "current factor changed",
      {},
      { factorIds: ["factor02"] },
      "factor-lineage-mismatch",
    ],
    [
      "zero factors",
      { factorIdsBefore: [], factorIdsAfter: [] },
      { factorIds: [] },
      "factor-lineage-mismatch",
    ],
    ["revocation", {}, { revoked: true }, "revoked"],
    [
      "enrollment even with matching post-version",
      { purpose: "enrollment-investigation", authorizationVersionAfter: 3 },
      { purpose: "enrollment-investigation", authorizationVersion: 3 },
      "enrollment-reverification-required",
    ],
    [
      "enrollment even with stable versions",
      { purpose: "enrollment-investigation" },
      { purpose: "enrollment-investigation" },
      "enrollment-reverification-required",
    ],
    [
      "enrollment cannot become login",
      { purpose: "enrollment-investigation" },
      {},
      "enrollment-reverification-required",
    ],
  ];
  it.each(mismatchCases)("rejects %s", (_name, observed, current, reason) => {
    check({ ...observation, ...observed }, { ...context, ...current }, reason);
  });

  const malformedObservations: [string, object][] = [
    ["caller private authority flag", { privatelyObserved: true }],
    ["secret extra property", { token: "syntheticSecretNeverEcho" }],
    ["claimed staff admission", { staffAdmission: "verified" }],
    ["claimed durability", { durable: true }],
    ["wrong kind", { kind: "verified-proof" }],
    ["unknown purpose", { purpose: "admin" }],
    ["blank ID", { userId: " " }],
    ["trailing newline ID", { userId: "sdkUser01\n" }],
    ["oversized ID", { observationId: "a".repeat(129) }],
    ["token-like ID", { sessionId: "not/a/token" }],
    ["invalid prior ID", { priorSessionId: "" }],
    ["missing timestamp", { operationStartedAt: undefined }],
    [
      "impossible calendar date",
      { operationStartedAt: "2026-02-30T00:00:00.000Z" },
    ],
    [
      "noncanonical offset",
      { operationStartedAt: "2026-01-01T00:00:00.000+00:00" },
    ],
    ["missing milliseconds", { operationStartedAt: "2026-01-01T00:00:00Z" }],
    ["reversed interval", { operationStartedAt: "2026-01-01T00:00:02.000Z" }],
    ["negative version", { authorizationVersionBefore: -1 }],
    ["fractional version", { authorizationVersionAfter: 2.5 }],
    ["infinite version", { authorizationVersionAfter: Infinity }],
    ["NaN version", { authorizationVersionAfter: NaN }],
    [
      "unsafe version",
      { authorizationVersionAfter: Number.MAX_SAFE_INTEGER + 1 },
    ],
    ["string version", { authorizationVersionBefore: "2" }],
    ["duplicate factors", { factorIdsBefore: ["factor01", "factor01"] }],
    [
      "too many factors",
      { factorIdsAfter: Array.from({ length: 9 }, (_, i) => `factor${i}`) },
    ],
    ["invalid factor ID", { factorIdsBefore: ["factor 1"] }],
    ["sparse factor array", { factorIdsAfter: new Array(1) }],
    ["non-array factors", { factorIdsAfter: "factor01" }],
  ];
  it.each(malformedObservations)(
    "rejects malformed observation: %s",
    (_name, patch) => {
      check({ ...observation, ...patch }, context, "malformed");
    },
  );

  it.each([
    { authorizationVersion: -1 },
    { authorizationVersion: 1.5 },
    { authorizationVersion: null },
    { revoked: "false" },
    { factorIds: ["factor01", "factor01"] },
    { userId: "" },
    { purpose: "unknown" },
    { secret: "syntheticSecretNeverEcho" },
  ])("strictly validates context %#", (patch) => {
    check(observation, { ...context, ...patch }, "malformed");
  });

  it("treats factor IDs as sets and does not mutate inputs", () => {
    const before = Object.freeze(["factor01", "factor02"]);
    const after = Object.freeze(["factor02", "factor01"]);
    const observed = Object.freeze({
      ...observation,
      factorIdsBefore: before,
      factorIdsAfter: after,
    });
    const current = Object.freeze({ ...context, factorIds: after });
    check(observed, current, "bindings-match-not-authorizing");
    expect(observed.factorIdsBefore).toBe(before);
    expect(before).toEqual(["factor01", "factor02"]);
  });

  it("permits equal canonical endpoints and safe version zero, not a clock freshness assertion", () => {
    check(
      {
        ...observation,
        operationCompletedAt: observation.operationStartedAt,
        authorizationVersionBefore: 0,
        authorizationVersionAfter: 0,
      },
      { ...context, authorizationVersion: 0 },
      "bindings-match-not-authorizing",
    );
  });

  it("rejects missing, inherited, symbol, array-extra and accessor fields without invoking getters", () => {
    const { durable: omitted, ...missing } = observation;
    expect(omitted).toBe(false);
    check(missing, context, "malformed");
    check(Object.create(observation), context, "malformed");
    check({ ...observation, [Symbol("private")]: true }, context, "malformed");
    const factorIds = Object.assign(["factor01"], { privateFlag: true });
    check({ ...observation, factorIdsBefore: factorIds }, context, "malformed");
    let invoked = false;
    const accessor = { ...observation };
    Object.defineProperty(accessor, "userId", {
      get() {
        invoked = true;
        return observation.userId;
      },
    });
    check(accessor, context, "malformed");
    expect(invoked).toBe(false);
  });

  it("returns only static failure metadata for unknowns and hostile reflection", () => {
    for (const value of [
      null,
      undefined,
      true,
      2,
      "syntheticSecretNeverEcho",
      [],
      () => observation,
    ]) {
      check(value, context, "malformed");
      check(observation, value, "malformed");
    }
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("syntheticSecretNeverEcho");
        },
      },
    );
    check(hostile, context, "malformed");
    expect(
      Object.isFrozen(assessProposedMfaBinding(observation, context)),
    ).toBe(true);
  });
});
