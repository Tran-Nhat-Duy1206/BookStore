import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SYNTHETIC transaction/driver fault evidence ONLY, never MFA/authentication proof.
// The production kernel accepts NO fake client/provider/clock injection seam.
// This file-local module mock cannot replace real PG/SDK suites in acceptance.
const model = vi.hoisted(() => ({
  mode: "denial",
  transaction: false,
  pendingBusiness: false,
  committedBusiness: false,
  pendingFence: false,
  committedFence: false,
  commits: 0,
  rollbacks: 0,
  mutations: 0,
  outcomes: [] as string[],
}));
vi.mock("pg", () => ({
  Pool: class {
    on() {
      return this;
    }
    async connect() {
      return {
        async query(text: string, values?: readonly unknown[]) {
          if (text.includes("FROM pg_catalog.pg_roles"))
            return { rows: [{ safe: true }] };
          if (text === "BEGIN") {
            model.transaction = true;
            return { rows: [] };
          }
          if (text === "ROLLBACK") {
            model.rollbacks++;
            model.transaction = false;
            model.pendingBusiness = false;
            model.pendingFence = false;
            return { rows: [] };
          }
          if (text === "COMMIT") {
            model.commits++;
            model.transaction = false;
            model.committedBusiness ||= model.pendingBusiness;
            model.committedFence ||= model.pendingFence;
            model.pendingBusiness = false;
            model.pendingFence = false;
            if (model.mode.endsWith("commit-loss"))
              throw new Error("Synthetic lost acknowledgement");
            return { rows: [] };
          }
          if (text.includes("SELECT audit.record_denial")) {
            model.outcomes.push(String(values?.[2]));
            return { rows: [] };
          }
          if (text.includes("SELECT staff.check_access")) {
            if (model.mode === "malformed-guard")
              return {
                rows: [
                  {
                    decision: {
                      allowed: true,
                      reason: "allowed",
                      authorizationVersion: "invalid",
                    },
                  },
                ],
              };
            if (
              model.mode === "denial" ||
              model.mode === "denial-commit-loss"
            ) {
              model.pendingFence = true;
              return {
                rows: [{ decision: { allowed: false, reason: "unavailable" } }],
              };
            }
            return {
              rows: [
                {
                  decision: {
                    allowed: true,
                    reason: "allowed",
                    authorizationVersion: 1,
                  },
                },
              ],
            };
          }
          if (text.includes("SELECT staff.set_status")) {
            model.mutations++;
            model.pendingBusiness = true;
            if (model.mode === "malformed-mutation")
              return {
                rows: [
                  {
                    decision: {
                      allowed: true,
                      reason: "allowed",
                      authorizationVersion: -1,
                    },
                  },
                ],
              };
            if (model.mode === "unknown-denial-after-dml")
              return {
                rows: [
                  { decision: { allowed: false, reason: "unrecognized" } },
                ],
              };
            if (model.mode === "extra-denial-after-dml")
              return {
                rows: [
                  {
                    decision: {
                      allowed: false,
                      reason: "forbidden",
                      unexpected: true,
                    },
                  },
                ],
              };
            if (model.mode === "mutation-exception")
              throw new Error("Synthetic SQL audit failure");
            return {
              rows: [
                {
                  decision: {
                    allowed: true,
                    reason: "allowed",
                    authorizationVersion: 2,
                  },
                },
              ],
            };
          }
          throw new Error("Unsupported synthetic transaction operation");
        },
        release() {},
      };
    }
    async end() {}
  },
}));
import { createSecurityKernel } from "../../src/server/security/kernel";

const kernels = new Set<ReturnType<typeof createSecurityKernel>>();
const url =
  "postgresql://bf_0123456789ab_staff:synthetic-unit-only-password-0123456789abcdef@127.0.0.1:55436/bookstore_security_test_0123456789ab";
function kernel() {
  const result = createSecurityKernel(url, async () => ({
    userId: "synthetic-unit-actor",
    sessionId: "synthetic-unit-session",
  }));
  kernels.add(result);
  return result;
}
beforeEach(() => {
  model.mode = "denial";
  model.transaction = false;
  model.pendingBusiness = false;
  model.committedBusiness = false;
  model.pendingFence = false;
  model.committedFence = false;
  model.commits = 0;
  model.rollbacks = 0;
  model.mutations = 0;
  model.outcomes = [];
});
afterEach(async () => {
  for (const subject of kernels) {
    await subject.close();
    kernels.delete(subject);
  }
});

describe("SYNTHETIC kernel decision and commit-uncertainty protocol (not authentication evidence)", () => {
  it("commits only the canonical denial fence without business success", async () => {
    const result = await kernel().authorize("security.self.read");
    expect(!result.allowed && result.reason === "unavailable").toBe(true);
    expect(model.commits).toBe(1);
    expect(model.rollbacks).toBe(0);
    expect(
      model.committedFence && !model.committedBusiness && model.mutations === 0,
    ).toBe(true);
    expect(model.outcomes.join(",")).toBe("unavailable");
  });
  it("denial COMMIT acknowledgement loss is unavailable, never certain rollback or retry", async () => {
    model.mode = "denial-commit-loss";
    const result = await kernel().authorize("security.self.read");
    expect(!result.allowed && result.reason === "unavailable").toBe(true);
    expect(model.commits).toBe(1);
    expect(model.committedFence).toBe(true);
    expect(!model.committedBusiness && model.mutations === 0).toBe(true);
    expect(model.outcomes.join(",")).toBe("unavailable");
  });
  it("business COMMIT acknowledgement loss remains unknown even if later rollback responds", async () => {
    model.mode = "business-commit-loss";
    const result = await kernel().setStatus(
      "synthetic-unit-target",
      "suspended",
    );
    expect(!result.allowed && result.reason === "unavailable").toBe(true);
    expect(
      model.commits === 1 && model.committedBusiness && model.mutations === 1,
    ).toBe(true);
    expect(model.outcomes.join(",")).toBe("unavailable");
  });
  it("malformed initial SQL success cannot invoke a mutation or be committed as a denial", async () => {
    model.mode = "malformed-guard";
    const result = await kernel().setStatus(
      "synthetic-unit-target",
      "suspended",
    );
    expect(!result.allowed && result.reason === "unavailable").toBe(true);
    expect(
      model.commits === 0 &&
        model.rollbacks === 1 &&
        model.mutations === 0 &&
        !model.committedBusiness,
    ).toBe(true);
    expect(model.outcomes.join(",")).toBe("unavailable");
  });
  for (const mode of [
    "malformed-mutation",
    "unknown-denial-after-dml",
    "extra-denial-after-dml",
  ]) {
    it(`rolls back ${mode} rather than treating normalized false as nonmutating proof`, async () => {
      model.mode = mode;
      const result = await kernel().setStatus(
        "synthetic-unit-target",
        "suspended",
      );
      expect(!result.allowed && result.reason === "unavailable").toBe(true);
      expect(
        model.commits === 0 &&
          model.rollbacks === 1 &&
          model.mutations === 1 &&
          !model.committedBusiness,
      ).toBe(true);
      expect(model.outcomes.join(",")).toBe("rolled_back");
    });
  }
  it("SQL/audit exceptions still roll back the attempted business transaction", async () => {
    model.mode = "mutation-exception";
    const result = await kernel().setStatus(
      "synthetic-unit-target",
      "suspended",
    );
    expect(!result.allowed && result.reason === "unavailable").toBe(true);
    expect(
      model.commits === 0 &&
        model.rollbacks === 1 &&
        model.mutations === 1 &&
        !model.committedBusiness,
    ).toBe(true);
    expect(model.outcomes.join(",")).toBe("rolled_back");
  });
});
