import { Pool } from "pg";
import { validatePurposeUrl } from "./database";
import { proposedPolicy, type SyntheticBrowser } from "./provider";

export type AdmissionResult = {
  allowed: boolean;
  status: 200 | 401 | 403 | 503;
  reason: string;
};
type Principal = {
  user_id: string;
  status: string;
  role: string;
  authz_version: number;
};
const denied = (status: 401 | 403 | 503, reason: string): AdmissionResult => ({
  allowed: false,
  status,
  reason,
});

/**
 * Experimental admission proof only. No route/UI/caller outside this harness.
 * Candidate time policy is simulated, not enabled in the application.
 */
export class AdmissionProof {
  private pool: Pool;
  constructor(
    url: string,
    private clock = () => new Date(),
  ) {
    this.pool = new Pool({
      connectionString: validatePurposeUrl(url, "staff"),
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
  }
  close() {
    return this.pool.end();
  }

  async verify(
    browser: SyntheticBrowser,
    code: string,
    mode: "totp" | "recovery" = "totp",
  ): Promise<AdmissionResult> {
    try {
      const response = await browser.call(
        mode === "totp"
          ? "/two-factor/verify-totp"
          : "/two-factor/verify-backup-code",
        { code, trustDevice: false },
      );
      if (!response.ok) return denied(401, "verification_failed");
      // Only this successful real-provider flow can create an admission record.
      // Neither a caller's MFA boolean nor the presence of a session suffices.
      const session = await browser.session();
      if (!session || session.user.twoFactorEnabled !== true)
        return denied(401, "verification_failed");
      const db = await this.pool.connect();
      try {
        await db.query("BEGIN");
        const result = await db.query<Principal>(
          "SELECT * FROM staff.principals WHERE user_id=$1 FOR UPDATE",
          [session.user.id],
        );
        const principal = result.rows[0];
        if (
          !principal ||
          !["active", "enrollment"].includes(principal.status)
        ) {
          await db.query("ROLLBACK");
          return denied(403, "staff_not_eligible");
        }
        let version = principal.authz_version;
        if (mode === "recovery") {
          const changed = await db.query<{ authz_version: number }>(
            "UPDATE staff.principals SET status='recovery',authz_version=authz_version+1 WHERE user_id=$1 RETURNING authz_version",
            [principal.user_id],
          );
          version = changed.rows[0].authz_version;
        } else if (principal.status === "enrollment") {
          await db.query(
            "UPDATE staff.principals SET status='active' WHERE user_id=$1",
            [principal.user_id],
          );
        }
        const now = this.clock();
        await db.query(
          `INSERT INTO staff.admissions(session_id,user_id,authz_version,mode,mfa_at,last_seen_at,admitted_at)
          VALUES($1,$2,$3,$4,$5,$5,$5)
          ON CONFLICT(session_id) DO UPDATE SET authz_version=EXCLUDED.authz_version,mode=EXCLUDED.mode,mfa_at=EXCLUDED.mfa_at,last_seen_at=EXCLUDED.last_seen_at`,
          [session.session.id, principal.user_id, version, mode, now],
        );
        await db.query(
          "INSERT INTO audit.events(actor_id,action,details) VALUES($1,$2,$3)",
          [
            principal.user_id,
            mode === "totp" ? "ADMISSION_TOTP" : "ADMISSION_RECOVERY",
            JSON.stringify({ mode }),
          ],
        );
        await db.query("COMMIT");
        return {
          allowed: true,
          status: 200,
          reason: mode === "totp" ? "mfa_admitted" : "recovery_only",
        };
      } catch {
        await db.query("ROLLBACK");
        return denied(503, "security_unavailable");
      } finally {
        db.release();
      }
    } catch {
      return denied(503, "security_unavailable");
    }
  }

  async authorize(
    browser: SyntheticBrowser,
    purpose: "admin" | "sensitive" | "recovery" = "admin",
  ): Promise<AdmissionResult> {
    try {
      const session = await browser.session();
      if (!session) return denied(401, "authentication_required");
      const result = await this.pool.query<
        Principal & {
          mode: string | null;
          admitted_version: number | null;
          mfa_at: Date | null;
          last_seen_at: Date | null;
          admitted_at: Date | null;
        }
      >(
        `SELECT p.*,a.mode,a.authz_version AS admitted_version,a.mfa_at,a.last_seen_at,a.admitted_at
        FROM staff.principals p LEFT JOIN staff.admissions a ON a.user_id=p.user_id AND a.session_id=$2
        WHERE p.user_id=$1`,
        [session.user.id, session.session.id],
      );
      const state = result.rows[0];
      if (
        !state ||
        ["disabled", "suspended", "enrollment"].includes(state.status)
      )
        return denied(403, "staff_not_eligible");
      if (
        !state.mode ||
        state.admitted_version !== state.authz_version ||
        !state.mfa_at ||
        !state.last_seen_at ||
        !state.admitted_at
      )
        return denied(403, "mfa_required");
      const now = this.clock().getTime();
      if (
        now - session.session.createdAt.getTime() >=
          proposedPolicy.absoluteSeconds * 1000 ||
        now - state.last_seen_at.getTime() >=
          proposedPolicy.idleSeconds * 1000 ||
        now < state.mfa_at.getTime()
      )
        return denied(401, "session_expired");
      if (state.mode === "recovery" || state.status === "recovery") {
        return purpose === "recovery" && state.mode === "recovery"
          ? { allowed: true, status: 200, reason: "recovery_only" }
          : denied(403, "recovery_only");
      }
      if (state.status !== "active" || state.mode !== "totp")
        return denied(403, "mfa_required");
      if (
        purpose === "sensitive" &&
        (state.role !== "Owner" ||
          now - state.mfa_at.getTime() >=
            proposedPolicy.recentMfaSeconds * 1000)
      )
        return denied(403, "step_up_required");
      await this.pool.query(
        "UPDATE staff.admissions SET last_seen_at=$2 WHERE session_id=$1",
        [session.session.id, this.clock()],
      );
      return { allowed: true, status: 200, reason: "authorized" };
    } catch {
      return denied(503, "security_unavailable");
    }
  }
}
