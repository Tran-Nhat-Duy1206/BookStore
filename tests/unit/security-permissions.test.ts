import { describe, expect, it } from "vitest";
import {
  hasPermission,
  isActivePermission,
  isSecurityRole,
  PERMISSION_REGISTRY,
  PERMISSION_VERSION,
  SECURITY_POLICY_TEST_VALUES,
  SECURITY_ROLES,
} from "../../src/server/security/permissions";

const roles = [
  "Owner",
  "CatalogManager",
  "Editor",
  "Publisher",
  "InventoryManager",
  "Analyst",
] as const;
const selfActions = ["security.self.read", "security.self.revoke"];
const ownerActions = [
  "security.staff.status",
  "security.staff.roles",
  "security.audit.read",
];
const futureActions = [
  "catalog.write",
  "content.draft",
  "content.publish",
  "inventory.adjust",
  "analytics.read",
];

describe("explicit version-one foundation permissions (not authentication)", () => {
  it("defines exactly six roles and the enumerated permission vocabulary", () => {
    expect(PERMISSION_VERSION).toBe(1);
    expect(SECURITY_ROLES).toEqual(roles);
    expect(Object.keys(PERMISSION_REGISTRY).sort()).toEqual(
      [...selfActions, ...ownerActions, ...futureActions].sort(),
    );
  });

  for (const role of roles) {
    for (const action of [...selfActions, ...ownerActions, ...futureActions]) {
      it(`${role} / ${action} has only its explicit active grant`, () => {
        const expected =
          selfActions.includes(action) ||
          (role === "Owner" && ownerActions.includes(action));
        expect(hasPermission(role, action)).toBe(expected);
      });
    }
  }

  it("keeps every future domain grant inactive, even for Owner", () => {
    for (const action of futureActions) {
      expect(isActivePermission(action)).toBe(false);
      for (const role of roles) expect(hasPermission(role, action)).toBe(false);
    }
    expect(hasPermission("Publisher", "content.draft")).toBe(false);
    expect(hasPermission("Editor", "content.publish")).toBe(false);
    expect(PERMISSION_REGISTRY["security.staff.roles"].roles).toEqual([
      "Owner",
    ]);
  });

  it("denies unknown roles, inherited property names and wildcards", () => {
    for (const role of [
      "owner",
      "Administrator",
      "*",
      "toString",
      "__proto__",
      "",
      null,
      undefined,
      1,
    ]) {
      expect(isSecurityRole(role)).toBe(false);
      for (const action of selfActions)
        expect(hasPermission(role, action)).toBe(false);
    }
    for (const action of [
      "*",
      "security.*",
      "security.self.READ",
      "security.self.read ",
      "toString",
      "constructor",
      "__proto__",
      "",
      null,
      undefined,
      1,
    ]) {
      expect(isActivePermission(action)).toBe(false);
      for (const role of roles) expect(hasPermission(role, action)).toBe(false);
    }
  });

  it("does not coerce forged role/action objects or authority flags", () => {
    const forged = {
      role: "Owner",
      roles: ["Owner"],
      mfaVerified: true,
      toString() {
        throw new Error("must not coerce untrusted objects");
      },
    };
    expect(hasPermission(forged, "security.staff.roles")).toBe(false);
    expect(hasPermission(["Owner"], "security.staff.roles")).toBe(false);
    expect(hasPermission("Owner", forged)).toBe(false);
    expect(hasPermission(new String("Owner"), "security.staff.roles")).toBe(
      false,
    );
    expect(hasPermission("Publisher", "security.staff.roles")).toBe(false);
    expect(hasPermission("Editor", "security.staff.roles")).toBe(false);
  });

  it("keeps policy data frozen and candidate values explicitly test-only", () => {
    expect(Object.isFrozen(SECURITY_ROLES)).toBe(true);
    expect(Object.isFrozen(PERMISSION_REGISTRY)).toBe(true);
    for (const entry of Object.values(PERMISSION_REGISTRY)) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.roles)).toBe(true);
    }
    expect(SECURITY_POLICY_TEST_VALUES).toEqual({
      absoluteSessionMs: 28_800_000,
      inactivityMs: 1_800_000,
      recentMfaMs: 300_000,
      pendingOperationMs: 86_400_000,
      auditRetentionMs: 31_536_000_000,
    });
  });
});
