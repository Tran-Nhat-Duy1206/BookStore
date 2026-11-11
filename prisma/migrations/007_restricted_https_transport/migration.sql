-- ADR-018: test-only transport denial controls. No positive issuer, identity,
-- approval, replay reset or admission creation authority is added.
BEGIN;

ALTER TABLE audit.events DROP CONSTRAINT events_action_check;
ALTER TABLE audit.events ADD CONSTRAINT events_action_check CHECK(action IN
 ('principal.insert','principal.update','principal.delete','roles.insert','roles.delete',
 'admission.insert','admission.update','admission.delete','governance.changed','provider.reconciled',
 'control.prepared','control.primary','control.reserved','control.evidence','control.login','control.step_up','control.revoked','control.orphan',
 'transport.cancel'));

CREATE FUNCTION staff.reserve_transport_request() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; k bytea; b control_private.budgets%ROWTYPE;
BEGIN
 -- lock_time enforces READ COMMITTED, governance-first and a post-wait clock,
 -- including the immutable key/realm and offline configuration witness checks.
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 k=control_private.mac('transport-ingress-v1','common-loopback');
 IF NOT EXISTS(SELECT 1 FROM control_private.budgets WHERE key_mac=k)
 AND (SELECT count(*) FROM control_private.budgets)>=20000 THEN
  RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb;
 END IF;
 INSERT INTO control_private.budgets(key_mac,window_start,window_end,used)
 VALUES(k,n,n+interval '15 minutes',0) ON CONFLICT DO NOTHING;
 SELECT * INTO b FROM control_private.budgets WHERE key_mac=k FOR UPDATE;
 IF b.key_mac IS NULL OR b.window_start>n THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 IF b.window_end>n AND b.used>=120 THEN RETURN '{"allowed":false,"reason":"rate_limited"}'::jsonb; END IF;
 UPDATE control_private.budgets SET
  used=CASE WHEN window_end<=n THEN 1 ELSE used+1 END,
  window_start=CASE WHEN window_end<=n THEN n ELSE window_start END,
  window_end=CASE WHEN window_end<=n THEN n+interval '15 minutes' ELSE window_end END
 WHERE key_mac=k;
 RETURN '{"allowed":true,"reason":"allowed"}'::jsonb;
END $$;

CREATE FUNCTION staff.cancel_transport_context(canonical_cookie text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; cm bytea; attempt_handles text[]; session_ids text[];
BEGIN
 PERFORM staff.require_read_committed();
 -- Empty/invalid credentials can never select an anonymous or broad context.
 -- The private facade supplies the exact native canonical cookie projection.
 IF canonical_cookie IS NULL OR octet_length(canonical_cookie) NOT BETWEEN 1 AND 16384
 OR canonical_cookie ~ '[[:cntrl:]]'
 OR canonical_cookie !~ '^[A-Za-z0-9_.-]+=[^[:space:];]+(; [A-Za-z0-9_.-]+=[^[:space:];]+)*$' THEN
  RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb;
 END IF;
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 PERFORM set_config('bookstore.security_actor','',true);
 cm=control_private.mac('cookie',canonical_cookie);
 -- Collect ALL bindings BEFORE changing any row. Governance serializes issue,
 -- finalization, provider mutations, revocation and this cancellation operation.
 SELECT coalesce(array_agg(a.challenge_handle),'{}'::text[]) INTO attempt_handles
 FROM control_private.attempts a WHERE a.primary_cookie_mac=cm OR a.final_cookie_mac=cm;
 SELECT coalesce(array_agg(DISTINCT candidate.sid),'{}'::text[]) INTO session_ids
 FROM (
  SELECT a.prior_session_id AS sid FROM control_private.attempts a WHERE a.challenge_handle=ANY(attempt_handles)
  UNION ALL SELECT a.final_session_id FROM control_private.attempts a WHERE a.challenge_handle=ANY(attempt_handles)
  UNION ALL SELECT c.session_id FROM control_private.session_controls c WHERE c.cookie_mac=cm
 ) candidate WHERE candidate.sid IS NOT NULL;
 -- Include consumed proofs: their duplicate-finalization result must not revive
 -- an admission. Inflight operations without a final SID become terminal too.
 UPDATE control_private.attempts SET state='revoked'
 WHERE challenge_handle=ANY(attempt_handles) AND state NOT IN ('denied','expired','revoked','unknown');
 UPDATE control_private.session_controls SET revoked=true WHERE session_id=ANY(session_ids);
 UPDATE control_private.session_observations SET retired=true WHERE session_id=ANY(session_ids);
 -- Retire sibling proofs derived from the same exact sessions as well.
 UPDATE control_private.attempts SET state='revoked'
 WHERE (prior_session_id=ANY(session_ids) OR final_session_id=ANY(session_ids))
 AND state NOT IN ('denied','expired','revoked','unknown');
 UPDATE staff.admissions SET mode='revoked' WHERE session_id=ANY(session_ids) AND mode<>'revoked';
 -- No caller actor/subject/credential enters audit. An unknown valid cookie has
 -- the same fixed result and audit shape. Any audit error rolls ALL denial
 -- mutations back; the facade must return unavailable and still clear cookies.
 INSERT INTO audit.events(action,source) VALUES('transport.cancel','staff');
 RETURN '{"allowed":true,"reason":"allowed"}'::jsonb;
END $$;

REVOKE ALL ON FUNCTION staff.reserve_transport_request(),staff.cancel_transport_context(text) FROM PUBLIC;
-- Exact STAFF grants and NOLOGIN Guard ownership are installed only by the
-- owned offline hardener. VERIFIER retains exactly its existing seven functions.
COMMIT;
