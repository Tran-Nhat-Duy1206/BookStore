import "server-only";

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { assertFoundationUrl } from "./database-config";
import type {
  DenialFallback,
  DenialOutcome,
  DenialReason,
  DenialRecord,
} from "./denial-spool";
import { isActivePermission, isSecurityRole } from "./permissions";

/** Server-composition trust boundary, NOT an HTTP/body/session-ID authenticator.
 * B2 must supply a real provider SDK resolver. B1 defaults to no identity; only
 * tests inject synthetic resolvers. Never derive this dependency from claims.
 */
export type TrustedProviderSessionReader = () => Promise<{
  userId: string;
  sessionId: string;
} | null>;

export type MinimalPermissionDecision =
  | { allowed: true; reason: "allowed"; authorizationVersion: number }
  | { allowed: false; status: 401 | 403 | 503; reason: DenialReason };
export type FoundationStaffStatus = "active" | "suspended" | "disabled";

type Session = { userId: string; sessionId: string };
type Allowed = Extract<MinimalPermissionDecision, { allowed: true }>;
type Denied = Extract<MinimalPermissionDecision, { allowed: false }>;
type DecisionRow = { decision: unknown };

function deny(reason: DenialReason): Denied {
  return {
    allowed: false,
    status:
      reason === "unauthenticated" ? 401 : reason === "unavailable" ? 503 : 403,
    reason,
  };
}

function decisionFrom(value: unknown): MinimalPermissionDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return deny("unavailable");
  }
  const result = value as Record<string, unknown>;
  if (result.allowed === true) {
    if (
      result.reason !== "allowed" ||
      typeof result.authorizationVersion !== "number" ||
      !Number.isSafeInteger(result.authorizationVersion) ||
      result.authorizationVersion < 0
    )
      return deny("unavailable");
    return {
      allowed: true,
      reason: "allowed",
      authorizationVersion: result.authorizationVersion,
    };
  }
  if (result.allowed !== false) return deny("unavailable");
  switch (result.reason) {
    case "unauthenticated":
      return deny("unauthenticated");
    case "stale":
      return deny("stale");
    case "unavailable":
      return deny("unavailable");
    default:
      return deny("forbidden");
  }
}

function validReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("\0")
  );
}

/** Permission kernel only, not authentication, transport, or operational CRUD.
 * No env loading, provider admission writer, password/token mechanism or HTTP API.
 * Target IDs are authorized context references, never authentication proof.
 * SQL owns live admission/MFA/governance/permission checks and write-lock rechecks.
 */
export function createSecurityKernel(
  staffUrl: string,
  sessionReader: TrustedProviderSessionReader = async () => null,
  denialFallback?: DenialFallback,
) {
  // Validate purpose before constructing a pool or making any connection.
  let validatedUrl: string;
  let expectedRole: string;
  try {
    validatedUrl = assertFoundationUrl(staffUrl, "staff");
    expectedRole = decodeURIComponent(new URL(validatedUrl).username);
  } catch {
    throw new Error("Security foundation configuration unavailable");
  }
  const pool = new Pool({
    connectionString: validatedUrl,
    max: 4,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 5_000,
    statement_timeout: 1_500,
    query_timeout: 2_000,
    application_name: "bookstore-security-foundation",
  });
  // Idle connection faults must not emit an unhandled EventEmitter error or leak
  // connection details. Every subsequent checkout still verifies its own role.
  pool.on("error", () => {
    /* No secrets or raw provider/database errors logged. */
  });
  let closed = false;
  let activeDenialWrites = 0;
  let closing: Promise<void> | undefined;
  // Latched static operational signal, never provider/error/identity data.
  let denialEvidenceUnavailable = false;

  async function connect(): Promise<PoolClient> {
    if (closed) throw new Error("Unavailable");
    const client = await pool.connect();
    try {
      const result = await client.query<{ safe: boolean }>(
        `SELECT (
          current_user::text = $1 AND session_user::text = $1
          AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
          AND NOT r.rolbypassrls AND NOT r.rolinherit
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
          AND NOT pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE')
          AND NOT pg_catalog.has_database_privilege(current_user, current_database(), 'TEMP')
        ) AS safe FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
        [expectedRole],
      );
      if (result.rows.length !== 1 || result.rows[0]?.safe !== true) {
        throw new Error("Unavailable");
      }
      return client;
    } catch {
      client.release(true);
      throw new Error("Unavailable");
    }
  }

  /** Separate bounded audit query after authorization rollback/release. Only the
   * whitelist envelope reaches either sink; never input identities/claims/errors.
   * DB outage/saturation always returns 503, even if opt-in local evidence synced.
   */
  async function recordDenial(
    decision: Denied,
    outcome: DenialOutcome,
  ): Promise<Denied> {
    const record: DenialRecord = Object.freeze({
      requestId: randomUUID(),
      occurredAt: new Date().toISOString(),
      reason: decision.reason,
      outcome,
    });
    if (!closed && activeDenialWrites < 8) {
      activeDenialWrites += 1;
      let client: PoolClient | undefined;
      let discard = false;
      let recorded = false;
      try {
        client = await connect();
        await client.query(
          "SELECT audit.record_denial($1::uuid, $2::text, $3::text)",
          [record.requestId, record.reason, record.outcome],
        );
        recorded = true;
      } catch {
        discard = true;
      } finally {
        client?.release(discard);
        activeDenialWrites -= 1;
      }
      if (recorded) return decision;
    }
    // Exactly one optional fallback call with the same correlation UUID. It
    // cannot grant access, change outcome, or be mistaken for primary DB audit.
    let fallbackRecorded = false;
    try {
      fallbackRecorded = denialFallback
        ? (await denialFallback.append(record)) === true
        : false;
    } catch {
      /* Static failure state only; no sink exception is surfaced. */
    }
    if (!fallbackRecorded) denialEvidenceUnavailable = true;
    return deny("unavailable");
  }

  type Mutation = (
    client: PoolClient,
    session: Session,
    check: Allowed,
    markAttempted: () => void,
  ) => Promise<MinimalPermissionDecision>;

  async function execute(
    permission: string,
    mutation?: Mutation,
  ): Promise<MinimalPermissionDecision> {
    let result: MinimalPermissionDecision = deny("unavailable");
    let client: PoolClient | undefined;
    let transaction = false;
    let mutationAttempted = false;
    let commitAttempted = false;
    let rollbackSucceeded = false;
    let discard = false;
    try {
      if (!isActivePermission(permission)) {
        result = deny("forbidden");
      } else {
        // No caller-supplied userId/sessionId/roles/MFA flags are consulted.
        const session = await sessionReader();
        if (
          !session ||
          !validReference(session.userId) ||
          !validReference(session.sessionId)
        ) {
          result = deny("unauthenticated");
        } else {
          client = await connect();
          await client.query("BEGIN");
          transaction = true;
          const checked = await client.query<DecisionRow>(
            "SELECT staff.check_access($1::text, $2::text, $3::text, NULL::bigint) AS decision",
            [session.userId, session.sessionId, permission],
          );
          result = decisionFrom(checked.rows[0]?.decision);
          if (result.allowed && mutation) {
            result = await mutation(client, session, result, () => {
              mutationAttempted = true;
            });
          }
          if (result.allowed) {
            commitAttempted = true;
            await client.query("COMMIT");
            transaction = false;
          }
        }
      }
    } catch {
      // No SQL errors, URLs, provider state or untrusted input in public results.
      result = deny("unavailable");
      discard = true;
    } finally {
      if (client && transaction) {
        try {
          await client.query("ROLLBACK");
          rollbackSucceeded = true;
        } catch {
          discard = true;
          result = deny("unavailable");
        }
      }
      client?.release(discard);
    }
    if (result.allowed) return result;
    // A failed/ambiguous COMMIT is never described as rolled back, even if a
    // subsequent ROLLBACK query succeeds on a connection of uncertain state.
    const outcome: DenialOutcome =
      mutationAttempted && rollbackSucceeded && !commitAttempted
        ? "rolled_back"
        : result.reason === "unavailable" || commitAttempted
          ? "unavailable"
          : "denied";
    return recordDenial(result, outcome);
  }

  return Object.freeze({
    /** Claims are deliberately ignored; only the server-composed reader identifies actor. */
    authorize(
      permission: string,
      untrustedClaims?: unknown,
    ): Promise<MinimalPermissionDecision> {
      void untrustedClaims;
      return execute(permission);
    },

    /** Internal foundation primitive, not a staff administration endpoint. */
    setStatus(
      targetUserId: string,
      status: FoundationStaffStatus,
    ): Promise<MinimalPermissionDecision> {
      return execute(
        "security.staff.status",
        async (client, session, checked, markAttempted) => {
          if (
            !validReference(targetUserId) ||
            !["active", "suspended", "disabled"].includes(status)
          ) {
            return deny("forbidden");
          }
          markAttempted();
          const result = await client.query<DecisionRow>(
            "SELECT staff.set_status($1::text, $2::text, $3::bigint, $4::text, $5::text) AS decision",
            [
              session.userId,
              session.sessionId,
              checked.authorizationVersion,
              targetUserId,
              status,
            ],
          );
          return decisionFrom(result.rows[0]?.decision);
        },
      );
    },

    replaceRoles(
      targetUserId: string,
      roles: readonly string[],
    ): Promise<MinimalPermissionDecision> {
      return execute(
        "security.staff.roles",
        async (client, session, checked, markAttempted) => {
          if (
            !validReference(targetUserId) ||
            !Array.isArray(roles) ||
            roles.length > 6 ||
            !roles.every(isSecurityRole) ||
            new Set(roles).size !== roles.length
          ) {
            return deny("forbidden");
          }
          markAttempted();
          const result = await client.query<DecisionRow>(
            "SELECT staff.replace_roles($1::text, $2::text, $3::bigint, $4::text, $5::text[]) AS decision",
            [
              session.userId,
              session.sessionId,
              checked.authorizationVersion,
              targetUserId,
              [...roles],
            ],
          );
          return decisionFrom(result.rows[0]?.decision);
        },
      );
    },

    /** SQL must bind the target admission to this same actor; not another user's session. */
    revokeOwnSession(
      targetSessionId: string,
    ): Promise<MinimalPermissionDecision> {
      return execute(
        "security.self.revoke",
        async (client, session, checked, markAttempted) => {
          if (!validReference(targetSessionId)) return deny("forbidden");
          markAttempted();
          const result = await client.query<DecisionRow>(
            "SELECT staff.revoke_admission($1::text, $2::text, $3::bigint, $4::text) AS decision",
            [
              session.userId,
              session.sessionId,
              checked.authorizationVersion,
              targetSessionId,
            ],
          );
          return decisionFrom(result.rows[0]?.decision);
        },
      );
    },

    /** Latched true if neither primary audit nor the optional fallback confirmed
     * evidence. It is an operational failure signal, never a durability claim.
     */
    getOperationalStatus(): Readonly<{ denialEvidenceUnavailable: boolean }> {
      return Object.freeze({ denialEvidenceUnavailable });
    },

    close(): Promise<void> {
      closed = true;
      closing ??= pool.end();
      return closing;
    },
  });
}
