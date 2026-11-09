/** Pure version-one policy data. No authentication, provider or database imports. */
export const PERMISSION_VERSION = 1 as const;

export const SECURITY_ROLES = Object.freeze([
  "Owner",
  "CatalogManager",
  "Editor",
  "Publisher",
  "InventoryManager",
  "Analyst",
] as const);
export type SecurityRole = (typeof SECURITY_ROLES)[number];

const ownerOnly = Object.freeze(["Owner"] as const);
const noRoles = Object.freeze([] as const);

/** Enumerated grants only: no role hierarchy, wildcard or implicit Owner grant. */
export const PERMISSION_REGISTRY = Object.freeze({
  "security.self.read": Object.freeze({ active: true, roles: SECURITY_ROLES }),
  "security.self.revoke": Object.freeze({
    active: true,
    roles: SECURITY_ROLES,
  }),
  "security.staff.status": Object.freeze({ active: true, roles: ownerOnly }),
  "security.staff.roles": Object.freeze({ active: true, roles: ownerOnly }),
  "security.audit.read": Object.freeze({ active: true, roles: ownerOnly }),
  "catalog.write": Object.freeze({ active: false, roles: noRoles }),
  "content.draft": Object.freeze({ active: false, roles: noRoles }),
  "content.publish": Object.freeze({ active: false, roles: noRoles }),
  "inventory.adjust": Object.freeze({ active: false, roles: noRoles }),
  "analytics.read": Object.freeze({ active: false, roles: noRoles }),
});
export type SecurityPermission = keyof typeof PERMISSION_REGISTRY;

export function isSecurityRole(value: unknown): value is SecurityRole {
  return (
    typeof value === "string" && SECURITY_ROLES.some((role) => role === value)
  );
}

export function isActivePermission(
  value: unknown,
): value is SecurityPermission {
  return (
    typeof value === "string" &&
    Object.hasOwn(PERMISSION_REGISTRY, value) &&
    PERMISSION_REGISTRY[value as SecurityPermission].active
  );
}

/** Tests policy membership, never an identity/session or caller's authority. */
export function hasPermission(role: unknown, permission: unknown): boolean {
  if (!isSecurityRole(role) || !isActivePermission(permission)) return false;
  return PERMISSION_REGISTRY[permission].roles.some((grant) => grant === role);
}

/** Candidate fixture values ONLY; not approved application/runtime policy. */
export const SECURITY_POLICY_TEST_VALUES = Object.freeze({
  absoluteSessionMs: 8 * 60 * 60 * 1000,
  inactivityMs: 30 * 60 * 1000,
  recentMfaMs: 5 * 60 * 1000,
  pendingOperationMs: 24 * 60 * 60 * 1000,
  auditRetentionMs: 365 * 24 * 60 * 60 * 1000,
});
