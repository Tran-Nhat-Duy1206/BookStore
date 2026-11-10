import type { Client } from "pg";

/** OFFLINE MIGRATION-OWNER SYNTHETIC FIXTURE ONLY. Never a runtime approval API. */
export async function pinOfflineGeneration(
  migration: Client,
  userId: string,
): Promise<string> {
  const current = await migration.query<{
    generation_id: string;
    matches: boolean;
  }>(
    `SELECT generation_id,fingerprint=control_private.security_snapshot($1) AS matches
     FROM control_private.approved_generations WHERE user_id=$1 AND NOT retired`,
    [userId],
  );
  if (current.rowCount === 1 && current.rows[0].matches)
    return current.rows[0].generation_id;
  await migration.query(
    "UPDATE control_private.approved_generations SET retired=true WHERE user_id=$1 AND NOT retired",
    [userId],
  );
  const inserted = await migration.query<{ generation_id: string }>(
    `INSERT INTO control_private.approved_generations(user_id,fingerprint)
     VALUES($1,control_private.security_snapshot($1)) RETURNING generation_id`,
    [userId],
  );
  if (inserted.rowCount !== 1)
    throw new Error("Offline synthetic generation setup failed.");
  return inserted.rows[0].generation_id;
}

/** Compatibility ONLY for preexisting migration-inserted B.1 admission fixtures.
 * Does NOT claim real MFA, cookie possession or operational approval. Proper B2b
 * tests must use the private maintained SDK facade instead of this helper.
 */
export async function seedOfflineAdmissionControls(
  migration: Client,
  binding: { userId: string; sessionId: string },
): Promise<void> {
  const generation = await pinOfflineGeneration(migration, binding.userId);
  await migration.query(
    `INSERT INTO control_private.session_observations(session_id,user_id,token_mac,first_seen_at,retired)
     SELECT s.id,s."userId",control_private.mac('session-token',s.token),clock_timestamp(),false
     FROM identity."Session" s WHERE s.id=$1 AND s."userId"=$2
     ON CONFLICT(session_id) DO UPDATE SET retired=false,token_mac=EXCLUDED.token_mac`,
    [binding.sessionId, binding.userId],
  );
  const seeded = await migration.query(
    `INSERT INTO control_private.session_controls(
       session_id,user_id,generation_id,fingerprint,authz_version,permission_version,
       token_mac,cookie_mac,authenticated_at,absolute_deadline,revoked)
     SELECT s.id,s."userId",g.generation_id,g.fingerprint,p.authz_version,p.permission_version,
       control_private.mac('session-token',s.token),control_private.mac('cookie','fixture-only-private-channel'),
       a.authenticated_at,a.authenticated_at+interval '8 hours',false
     FROM identity."Session" s JOIN staff.principals p ON p.user_id=s."userId"
     JOIN staff.admissions a ON a.session_id=s.id AND a.user_id=s."userId"
     JOIN control_private.approved_generations g ON g.generation_id=$3 AND g.user_id=s."userId" AND NOT g.retired
     WHERE s.id=$1 AND s."userId"=$2
     ON CONFLICT(session_id) DO UPDATE SET generation_id=EXCLUDED.generation_id,fingerprint=EXCLUDED.fingerprint,
       authz_version=EXCLUDED.authz_version,permission_version=EXCLUDED.permission_version,
       token_mac=EXCLUDED.token_mac,cookie_mac=EXCLUDED.cookie_mac,authenticated_at=EXCLUDED.authenticated_at,
       absolute_deadline=EXCLUDED.absolute_deadline,revoked=false`,
    [binding.sessionId, binding.userId, generation],
  );
  if (seeded.rowCount !== 1)
    throw new Error("Existing offline admission fixture is missing.");
}
