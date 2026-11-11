-- ADR-017: dormant controls only. No identity, approval or admission is seeded.
-- Upgrade of a previously hardened005 requires the owned OFFLINE administrator to
-- transfer staff.check_access and audit.staff_change to the migrator first; re-harden
-- before any purpose connection. Never grant migrator/LOGIN membership in Guard.
BEGIN;
CREATE SCHEMA control_private;
CREATE SCHEMA control_crypto;
REVOKE ALL ON SCHEMA control_private,control_crypto FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA control_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA control_private REVOKE ALL ON TABLES FROM PUBLIC;
CREATE EXTENSION pgcrypto WITH SCHEMA control_crypto;
-- Trusted extension routines may be bootstrap-superuser-owned. Their ACLs are
-- locked by the owned offline administrator, not by pretending migrate owns them.

CREATE TABLE control_private.secrets (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 realm_id uuid NOT NULL DEFAULT gen_random_uuid(),
 key_bytes bytea NOT NULL CHECK(octet_length(key_bytes)=32),
 key_checksum bytea NOT NULL CHECK(octet_length(key_checksum)=32)
);
INSERT INTO control_private.secrets(singleton,key_bytes,key_checksum)
 SELECT true,k,sha256(k) FROM (SELECT control_crypto.gen_random_bytes(32) k) s;
CREATE TABLE control_private.clock_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 realm_id uuid NOT NULL, key_checksum bytea NOT NULL,
 high_water timestamptz NOT NULL, frozen boolean NOT NULL DEFAULT false
);
INSERT INTO control_private.clock_state(singleton,realm_id,key_checksum,high_water)
 SELECT true,realm_id,key_checksum,clock_timestamp() FROM control_private.secrets;
-- Empty until the owned offline hardener verifies actual privileged configuration.
-- This is an offline configuration witness, never an SDK/MFA attestation or a
-- runtime setter. A server restart invalidates it without clearing any replay state.
CREATE TABLE control_private.configuration_witness (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 realm_id uuid NOT NULL, postmaster_started_at timestamptz NOT NULL,
 empty_preloads boolean NOT NULL CHECK(empty_preloads),
 policy_version integer NOT NULL CHECK(policy_version=1)
);
CREATE TABLE control_private.approved_generations (
 generation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id text NOT NULL CHECK(user_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
 retired boolean NOT NULL DEFAULT false,
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX control_one_live_generation ON control_private.approved_generations(user_id) WHERE NOT retired;
CREATE TABLE control_private.retired_users (
 user_id text PRIMARY KEY CHECK(user_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 retired_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- No provider/admission FK: deletion must not erase denial history.
CREATE TABLE control_private.session_observations (
 session_id text PRIMARY KEY CHECK(session_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 user_id text NOT NULL CHECK(user_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 token_mac bytea NOT NULL, first_seen_at timestamptz NOT NULL,
 retired boolean NOT NULL DEFAULT false
);
CREATE TABLE control_private.session_controls (
 session_id text PRIMARY KEY, user_id text NOT NULL,
 generation_id uuid NOT NULL, fingerprint bytea NOT NULL,
 authz_version integer NOT NULL, permission_version integer NOT NULL CHECK(permission_version=1),
 token_mac bytea NOT NULL, cookie_mac bytea NOT NULL,
 epoch_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 authenticated_at timestamptz NOT NULL, absolute_deadline timestamptz NOT NULL,
 revoked boolean NOT NULL DEFAULT false,
 CHECK(absolute_deadline=authenticated_at+interval '8 hours')
);
CREATE TABLE control_private.budgets (
 key_mac bytea PRIMARY KEY, window_start timestamptz NOT NULL,
 window_end timestamptz NOT NULL, used integer NOT NULL CHECK(used>=0),
 CHECK(window_end=window_start+interval '15 minutes')
);
CREATE TABLE control_private.replay_burns (
 code_mac bytea PRIMARY KEY, reserved_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 CHECK(expires_at=reserved_at+interval '180 seconds')
);
CREATE TABLE control_private.attempts (
 challenge_handle text PRIMARY KEY CHECK(challenge_handle ~ '^[a-f0-9]{64}$'),
 user_id text NOT NULL, generation_id uuid NOT NULL, fingerprint bytea NOT NULL,
 authz_version integer NOT NULL, permission_version integer NOT NULL CHECK(permission_version=1),
 purpose text NOT NULL CHECK(purpose IN ('login','step_up')),
 state text NOT NULL CHECK(state IN ('prepared','bound','inflight','ready','consumed','denied','expired','revoked','unknown')),
 authenticated_at timestamptz NOT NULL, primary_deadline timestamptz NOT NULL,
 ip_scope text NOT NULL, primary_cookie_mac bytea,
 prior_session_id text, prior_epoch_id uuid,
 operation_handle text UNIQUE CHECK(operation_handle IS NULL OR operation_handle ~ '^[a-f0-9]{64}$'),
 reserved_at timestamptz, deadline timestamptz,
 code_mac bytea, evidence_handle text UNIQUE CHECK(evidence_handle IS NULL OR evidence_handle ~ '^[a-f0-9]{64}$'),
 final_session_id text, final_token_mac bytea, final_cookie_mac bytea,
 consumed_at timestamptz, result jsonb,
 CHECK(primary_deadline=authenticated_at+interval '120 seconds'),
 CHECK(deadline IS NULL OR deadline=least(primary_deadline,reserved_at+interval '30 seconds'))
);
CREATE INDEX control_attempt_cookie ON control_private.attempts(primary_cookie_mac) WHERE state='bound';
CREATE INDEX control_attempt_session ON control_private.attempts(final_session_id);
CREATE INDEX control_attempt_user ON control_private.attempts(user_id);

CREATE FUNCTION control_private.reject_secret_change() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Control key is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER control_secret_immutable BEFORE UPDATE OR DELETE ON control_private.secrets
 FOR EACH ROW EXECUTE FUNCTION control_private.reject_secret_change();

-- All helpers are private; none are generic runtime HMAC/signing oracles.
CREATE FUNCTION control_private.mac(domain_name text,payload text) RETURNS bytea
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s control_private.secrets%ROWTYPE; c control_private.clock_state%ROWTYPE;
BEGIN
 SELECT * INTO s FROM control_private.secrets WHERE singleton;
 SELECT * INTO c FROM control_private.clock_state WHERE singleton;
 IF s.key_bytes IS NULL OR c.realm_id IS DISTINCT FROM s.realm_id
 OR c.key_checksum IS DISTINCT FROM s.key_checksum OR sha256(s.key_bytes) IS DISTINCT FROM s.key_checksum
 THEN RAISE EXCEPTION 'Control key unavailable' USING ERRCODE='55000'; END IF;
 RETURN control_crypto.hmac(convert_to(jsonb_build_array('BookStore.B2b.v1',domain_name,payload)::text,'UTF8'),s.key_bytes,'sha256');
END $$;
CREATE FUNCTION control_private.new_handle() RETURNS text
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT encode(control_crypto.gen_random_bytes(32),'hex')
$$;
CREATE FUNCTION control_private.security_snapshot(subject text) RETURNS bytea
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT control_private.mac('security-generation',jsonb_build_object(
 'user',(SELECT jsonb_build_array(u.id,u.email,u."emailVerified",u."twoFactorEnabled") FROM identity."User" u WHERE u.id=subject),
 'accounts',coalesce((SELECT jsonb_agg(jsonb_build_array(a.id,a."accountId",a."providerId",a."userId",a.password) ORDER BY a.id COLLATE "C") FROM identity."Account" a WHERE a."userId"=subject AND a."providerId"='credential'),'[]'::jsonb),
 'factors',coalesce((SELECT jsonb_agg(jsonb_build_array(t.id,t."userId",t.secret,t."backupCodes",t.verified) ORDER BY t.id COLLATE "C") FROM identity."TwoFactor" t WHERE t."userId"=subject),'[]'::jsonb)
 )::text)
$$;

CREATE FUNCTION control_private.clock_probe() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c control_private.clock_state%ROWTYPE; s control_private.secrets%ROWTYPE;
 w control_private.configuration_witness%ROWTYPE; n timestamptz;
BEGIN
 PERFORM staff.require_read_committed();
 PERFORM 1 FROM staff.governance WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 SELECT * INTO c FROM control_private.clock_state WHERE singleton FOR UPDATE;
 SELECT * INTO s FROM control_private.secrets WHERE singleton;
 SELECT * INTO w FROM control_private.configuration_witness WHERE singleton;
 n=clock_timestamp();
 IF c.singleton IS NULL OR s.singleton IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 -- Missing/stale offline configuration approval denies but does not change the
 -- permanent rollback latch. Runtime cannot re-attest or reset this witness.
 IF w.singleton IS NULL OR NOT w.empty_preloads OR w.policy_version<>1
 OR w.realm_id IS DISTINCT FROM s.realm_id
 OR w.postmaster_started_at IS DISTINCT FROM pg_postmaster_start_time() THEN
  RETURN jsonb_build_object('allowed',false,'reason','unavailable','databaseTime',n,'realmId',c.realm_id);
 END IF;
 IF c.frozen OR n<c.high_water OR c.realm_id IS DISTINCT FROM s.realm_id
 OR c.key_checksum IS DISTINCT FROM s.key_checksum OR sha256(s.key_bytes) IS DISTINCT FROM s.key_checksum THEN
  UPDATE control_private.clock_state SET frozen=true WHERE singleton;
  RETURN jsonb_build_object('allowed',false,'reason','unavailable','databaseTime',n,'realmId',c.realm_id);
 END IF;
 UPDATE control_private.clock_state SET high_water=n WHERE singleton;
 RETURN jsonb_build_object('allowed',true,'reason','allowed','databaseTime',n,'realmId',c.realm_id);
END $$;
CREATE FUNCTION staff.control_clock_probe() RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT control_private.clock_probe() $$;
-- Caller must perform committed probes before/after/catch OUTSIDE its finalizer
-- transaction; a failed transaction cannot durably record its own clock latch.
CREATE FUNCTION control_private.lock_time() RETURNS timestamptz
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r jsonb;
BEGIN
 r=control_private.clock_probe();
 IF NOT coalesce((r->>'allowed')::boolean,false) THEN RETURN NULL; END IF;
 RETURN (r->>'databaseTime')::timestamptz;
END $$;
CREATE FUNCTION control_private.live_generation(subject text,generation uuid,original bytea,version integer,permission_ver integer,sid text DEFAULT NULL)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM staff.governance WHERE singleton AND state='active')
 AND NOT EXISTS(SELECT 1 FROM control_private.retired_users WHERE user_id=subject)
 AND EXISTS(SELECT 1 FROM staff.principals p WHERE p.user_id=subject AND p.status='active' AND p.authz_version=version AND p.permission_version=permission_ver AND permission_ver=1)
 AND EXISTS(SELECT 1 FROM staff.role_grants r WHERE r.user_id=subject)
 AND EXISTS(SELECT 1 FROM identity."User" u WHERE u.id=subject AND u."emailVerified" AND u."twoFactorEnabled")
 AND EXISTS(SELECT 1 FROM identity."Account" a WHERE a."userId"=subject AND a."providerId"='credential' AND a.password IS NOT NULL AND a.password<>'')
 AND EXISTS(SELECT 1 FROM identity."TwoFactor" t WHERE t."userId"=subject AND t.verified AND t.secret<>'')
 AND EXISTS(SELECT 1 FROM control_private.approved_generations g WHERE g.generation_id=generation AND g.user_id=subject AND NOT g.retired AND g.fingerprint=original AND g.fingerprint=control_private.security_snapshot(subject))
 AND NOT EXISTS(SELECT 1 FROM audit.provider_events e WHERE e.user_id=subject AND e.state<>'processed' AND (e.invalidates_user OR (sid IS NOT NULL AND e.session_id=sid AND e.kind<>'session.created')));
END $$;
CREATE FUNCTION control_private.context_result(ch control_private.attempts,n timestamptz) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('allowed',true,'reason','allowed','challengeHandle',ch.challenge_handle,
 'userId',ch.user_id,'authorizationVersion',ch.authz_version,'purpose',ch.purpose,
 'factorIds',coalesce((SELECT jsonb_agg(t.id ORDER BY t.id COLLATE "C") FROM identity."TwoFactor" t WHERE t."userId"=ch.user_id),'[]'::jsonb),
 'deadline',ch.primary_deadline,'databaseTime',n)
$$;
CREATE FUNCTION control_private.charge_budget(kind text,account_scope text,ip text,n timestamptz) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE k bytea; keys bytea[]; budget_row control_private.budgets%ROWTYPE; ceiling integer;
BEGIN
 IF kind NOT IN ('password','mfa') OR ip IS NULL OR ip !~ '^[A-Za-z0-9_-]{1,64}$' THEN RETURN false; END IF;
 keys=ARRAY[control_private.mac('budget-account-'||kind,account_scope),control_private.mac('budget-ip-'||kind,ip)];
 IF (SELECT count(*) FROM control_private.budgets)+
 (SELECT count(*) FROM unnest(keys) x WHERE NOT EXISTS(SELECT 1 FROM control_private.budgets b WHERE b.key_mac=x))>20000 THEN RETURN false; END IF;
 FOR k IN SELECT x FROM unnest(keys) x ORDER BY x LOOP
  INSERT INTO control_private.budgets(key_mac,window_start,window_end,used) VALUES(k,n,n+interval '15 minutes',0) ON CONFLICT DO NOTHING;
  SELECT * INTO budget_row FROM control_private.budgets WHERE key_mac=k FOR UPDATE;
  ceiling=CASE WHEN k=keys[2] THEN 20 WHEN kind='password' THEN 5 ELSE 10 END;
  IF budget_row.window_start>n OR (budget_row.window_end>n AND budget_row.used>=ceiling) THEN RETURN false; END IF;
 END LOOP;
 UPDATE control_private.budgets SET
  used=CASE WHEN window_end<=n THEN 1 ELSE used+1 END,
  window_start=CASE WHEN window_end<=n THEN n ELSE window_start END,
  window_end=CASE WHEN window_end<=n THEN n+interval '15 minutes' ELSE window_end END
 WHERE key_mac=ANY(keys);
 RETURN true;
END $$;

-- Extend the fixed redacted vocabulary without weakening the existing constraints.
ALTER TABLE audit.events DROP CONSTRAINT events_action_check;
ALTER TABLE audit.events ADD CONSTRAINT events_action_check CHECK(action IN
 ('principal.insert','principal.update','principal.delete','roles.insert','roles.delete',
 'admission.insert','admission.update','admission.delete','governance.changed','provider.reconciled',
 'control.prepared','control.primary','control.reserved','control.evidence','control.login','control.step_up','control.revoked','control.orphan'));
ALTER TABLE audit.events DROP CONSTRAINT events_source_check;
ALTER TABLE audit.events ADD CONSTRAINT events_source_check CHECK(source IN ('staff','auth','worker','offline','verifier'));
CREATE OR REPLACE FUNCTION audit.staff_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text; action_name text; origin text; actor text;
BEGIN
 origin=CASE WHEN session_user ~ '_staff$' THEN 'staff' WHEN session_user ~ '_auth$' THEN 'auth'
 WHEN session_user ~ '_worker$' THEN 'worker' WHEN session_user ~ '_verifier$' THEN 'verifier' ELSE 'offline' END;
 actor=CASE WHEN origin='staff' THEN nullif(current_setting('bookstore.security_actor',true),'') ELSE NULL END;
 IF TG_TABLE_NAME='governance' THEN subject=NULL; action_name='governance.changed';
 ELSE subject=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
 action_name=CASE TG_TABLE_NAME WHEN 'principals' THEN 'principal.' WHEN 'role_grants' THEN 'roles.' ELSE 'admission.' END||lower(TG_OP); END IF;
 INSERT INTO audit.events(actor_id,subject_id,action,source) VALUES(actor,subject,action_name,origin);
 IF TG_TABLE_NAME='role_grants' THEN UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=subject; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION control_private.retire_subject(subject text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE control_private.approved_generations SET retired=true WHERE user_id=subject AND NOT retired;
 UPDATE control_private.attempts SET state='revoked' WHERE user_id=subject AND state NOT IN ('denied','expired','revoked','unknown');
 UPDATE control_private.session_controls SET revoked=true WHERE user_id=subject;
END $$;
CREATE FUNCTION control_private.provider_generation_change() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text; critical boolean=true;
BEGIN
 IF TG_TABLE_NAME='User' THEN
  subject=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM control_private.retired_users WHERE user_id=subject) THEN RAISE EXCEPTION 'Retired identity' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN critical=(NEW.id,NEW.email,NEW."emailVerified",NEW."twoFactorEnabled") IS DISTINCT FROM (OLD.id,OLD.email,OLD."emailVerified",OLD."twoFactorEnabled"); END IF;
  IF TG_OP='DELETE' THEN
   IF NOT EXISTS(SELECT 1 FROM control_private.retired_users WHERE user_id=subject)
   AND (SELECT count(*) FROM control_private.retired_users)>=10000 THEN RAISE EXCEPTION 'Control storage saturated' USING ERRCODE='54000'; END IF;
   INSERT INTO control_private.retired_users(user_id) VALUES(subject) ON CONFLICT DO NOTHING;
  END IF;
 ELSIF TG_TABLE_NAME='Account' THEN
  subject=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
  IF TG_OP='UPDATE' THEN critical=(NEW.id,NEW."accountId",NEW."providerId",NEW."userId",NEW.password) IS DISTINCT FROM (OLD.id,OLD."accountId",OLD."providerId",OLD."userId",OLD.password); END IF;
  -- The pinned snapshot contains only credential accounts.
  IF TG_OP='DELETE' THEN critical=critical AND OLD."providerId"='credential'; ELSE critical=critical AND NEW."providerId"='credential'; END IF;
 ELSE
  subject=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
  IF TG_OP='UPDATE' THEN critical=(NEW.id,NEW."userId",NEW.secret,NEW."backupCodes",NEW.verified) IS DISTINCT FROM (OLD.id,OLD."userId",OLD.secret,OLD."backupCodes",OLD.verified); END IF;
 END IF;
 IF critical THEN PERFORM control_private.retire_subject(subject); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER control_generation AFTER INSERT OR UPDATE OR DELETE ON identity."User" FOR EACH ROW EXECUTE FUNCTION control_private.provider_generation_change();
CREATE TRIGGER control_generation AFTER INSERT OR UPDATE OR DELETE ON identity."Account" FOR EACH ROW EXECUTE FUNCTION control_private.provider_generation_change();
CREATE TRIGGER control_generation AFTER INSERT OR UPDATE OR DELETE ON identity."TwoFactor" FOR EACH ROW EXECUTE FUNCTION control_private.provider_generation_change();

-- Explicit B.2b identity-key backstop, including sessions that have not yet
-- received admission. SDK rotation is create/delete, never a primary-key rename.
-- Reject even an id A->B->A within one transaction; snapshots are not history.
CREATE FUNCTION control_private.reject_identity_key_change() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id THEN
  RAISE EXCEPTION 'Provider identity key is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER control_identity_key BEFORE UPDATE OF id ON identity."Session"
 FOR EACH ROW EXECUTE FUNCTION control_private.reject_identity_key_change();
CREATE TRIGGER control_identity_key BEFORE UPDATE OF id ON identity."Account"
 FOR EACH ROW EXECUTE FUNCTION control_private.reject_identity_key_change();
CREATE TRIGGER control_identity_key BEFORE UPDATE OF id ON identity."TwoFactor"
 FOR EACH ROW EXECUTE FUNCTION control_private.reject_identity_key_change();

CREATE FUNCTION control_private.retire_session(sid text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE control_private.session_observations SET retired=true WHERE session_id=sid;
 UPDATE control_private.session_controls SET revoked=true WHERE session_id=sid;
 UPDATE control_private.attempts SET state='revoked' WHERE (final_session_id=sid OR prior_session_id=sid) AND state NOT IN ('denied','expired','revoked','unknown');
END $$;
CREATE FUNCTION control_private.provider_session_change() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz;
BEGIN
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM control_private.session_observations WHERE session_id=NEW.id)
  OR EXISTS(SELECT 1 FROM control_private.retired_users WHERE user_id=NEW."userId") THEN RAISE EXCEPTION 'Retired session identity' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM control_private.session_observations)>=10000 THEN RAISE EXCEPTION 'Control storage saturated' USING ERRCODE='54000'; END IF;
  n=clock_timestamp();
  INSERT INTO control_private.session_observations(session_id,user_id,token_mac,first_seen_at) VALUES(NEW.id,NEW."userId",control_private.mac('session-token',NEW.token),n);
 ELSIF TG_OP='DELETE' THEN PERFORM control_private.retire_session(OLD.id);
 ELSIF (NEW.token,NEW."expiresAt",NEW."userId") IS DISTINCT FROM (OLD.token,OLD."expiresAt",OLD."userId") THEN
  PERFORM control_private.retire_session(OLD.id);
  -- Preserve retirement and first-seen origin, while allowing a deny-only worker
  -- to compare and delete the actual current orphan rather than an obsolete token.
  UPDATE control_private.session_observations SET token_mac=control_private.mac('session-token',NEW.token) WHERE session_id=OLD.id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER control_session AFTER INSERT OR UPDATE OR DELETE ON identity."Session" FOR EACH ROW EXECUTE FUNCTION control_private.provider_session_change();
-- Existing provider rows gain observation only, NEVER approval or MFA provenance.
INSERT INTO control_private.session_observations(session_id,user_id,token_mac,first_seen_at)
 SELECT id,"userId",control_private.mac('session-token',token),clock_timestamp() FROM identity."Session";
CREATE FUNCTION control_private.admission_retirement() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sid text;
BEGIN
 IF TG_OP='DELETE' THEN sid=OLD.session_id;
 ELSIF NEW.mode='revoked' THEN sid=NEW.session_id;
 ELSE RETURN NULL; END IF;
 PERFORM control_private.retire_session(sid);
 RETURN NULL;
END $$;
CREATE TRIGGER control_admission_retirement AFTER UPDATE OR DELETE ON staff.admissions FOR EACH ROW EXECUTE FUNCTION control_private.admission_retirement();

-- Replace the entry name, not a parallel optional guard. The old predicate is
-- callable only by Guard through the wrapper; no runtime gets its EXECUTE ACL.
ALTER FUNCTION staff.check_access(text,text,text,bigint) RENAME TO check_access_b1;
CREATE FUNCTION staff.check_access(actor text,sid text,permission text,expected_version bigint DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; c control_private.session_controls%ROWTYPE; a staff.admissions%ROWTYPE; answer jsonb;
BEGIN
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 answer=staff.check_access_b1(actor,sid,permission,expected_version);
 IF NOT coalesce((answer->>'allowed')::boolean,false) THEN RETURN answer; END IF;
 SELECT * INTO c FROM control_private.session_controls WHERE session_id=sid AND user_id=actor;
 SELECT * INTO a FROM staff.admissions WHERE session_id=sid AND user_id=actor;
 IF c.session_id IS NULL OR c.revoked OR c.authenticated_at<>a.authenticated_at
 OR c.authenticated_at>n OR c.absolute_deadline<=n OR c.authz_version<>a.authz_version
 OR NOT control_private.live_generation(actor,c.generation_id,c.fingerprint,c.authz_version,c.permission_version,sid)
 OR NOT EXISTS(SELECT 1 FROM identity."Session" s JOIN control_private.session_observations o ON o.session_id=s.id
 WHERE s.id=sid AND s."userId"=actor AND s."expiresAt">n AND NOT o.retired AND o.user_id=actor
 AND o.token_mac=c.token_mac AND control_private.mac('session-token',s.token)=c.token_mac)
 THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 RETURN answer;
END $$;

CREATE FUNCTION control_private.prepare_password(email text,ip_scope text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; subject text; p staff.principals%ROWTYPE; g control_private.approved_generations%ROWTYPE; ch control_private.attempts%ROWTYPE;
BEGIN
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 IF email IS NULL OR length(email)>254 OR email !~ '^[^[:space:]@]+@[^[:space:]@]+\.invalid$' THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 IF NOT control_private.charge_budget('password',lower(email),ip_scope,n) THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 SELECT id INTO subject FROM identity."User" u WHERE u.email=lower(prepare_password.email);
 SELECT * INTO p FROM staff.principals WHERE user_id=subject;
 SELECT * INTO g FROM control_private.approved_generations WHERE user_id=subject AND NOT retired;
 IF g.generation_id IS NULL OR NOT control_private.live_generation(subject,g.generation_id,g.fingerprint,p.authz_version,p.permission_version)
 THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 IF (SELECT count(*) FROM control_private.attempts)>=10000 THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 INSERT INTO control_private.attempts(challenge_handle,user_id,generation_id,fingerprint,authz_version,permission_version,purpose,state,authenticated_at,primary_deadline,ip_scope)
 VALUES(control_private.new_handle(),subject,g.generation_id,g.fingerprint,p.authz_version,p.permission_version,'login','prepared',n,n+interval '120 seconds',ip_scope) RETURNING * INTO ch;
 INSERT INTO audit.events(subject_id,action,source) VALUES(subject,'control.prepared','verifier');
 RETURN control_private.context_result(ch,n);
END $$;
CREATE FUNCTION control_private.bind_primary(challenge_handle text,cookie_credential text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; ch control_private.attempts%ROWTYPE; cm bytea;
BEGIN
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 IF cookie_credential IS NULL OR octet_length(cookie_credential) NOT BETWEEN 1 AND 16384 OR cookie_credential ~ '[[:cntrl:]]' THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 SELECT * INTO ch FROM control_private.attempts a WHERE a.challenge_handle=bind_primary.challenge_handle FOR UPDATE;
 IF ch.challenge_handle IS NULL OR ch.purpose<>'login' OR ch.state<>'prepared' OR ch.authenticated_at>n OR ch.primary_deadline<=n
 OR NOT control_private.live_generation(ch.user_id,ch.generation_id,ch.fingerprint,ch.authz_version,ch.permission_version) THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 cm=control_private.mac('cookie',cookie_credential);
 IF EXISTS(SELECT 1 FROM control_private.attempts WHERE primary_cookie_mac=cm) THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 UPDATE control_private.attempts a SET state='bound',primary_cookie_mac=cm WHERE a.challenge_handle=ch.challenge_handle RETURNING * INTO ch;
 INSERT INTO audit.events(subject_id,action,source) VALUES(ch.user_id,'control.primary','verifier');
 RETURN control_private.context_result(ch,n);
END $$;
CREATE FUNCTION control_private.resume_primary(cookie_credential text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; ch control_private.attempts%ROWTYPE;
BEGIN
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 IF cookie_credential IS NULL OR octet_length(cookie_credential) NOT BETWEEN 1 AND 16384 OR cookie_credential ~ '[[:cntrl:]]' THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 SELECT * INTO ch FROM control_private.attempts WHERE primary_cookie_mac=control_private.mac('cookie',cookie_credential) AND state='bound' AND purpose='login' FOR UPDATE;
 IF ch.challenge_handle IS NULL OR ch.primary_deadline<=n OR ch.authenticated_at>n
 OR NOT control_private.live_generation(ch.user_id,ch.generation_id,ch.fingerprint,ch.authz_version,ch.permission_version) THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 RETURN control_private.context_result(ch,n);
END $$;
CREATE FUNCTION control_private.prepare_step_up(actor text,sid text,cookie_credential text,ip_scope text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; c control_private.session_controls%ROWTYPE; ch control_private.attempts%ROWTYPE; answer jsonb;
BEGIN
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 IF cookie_credential IS NULL OR octet_length(cookie_credential) NOT BETWEEN 1 AND 16384 OR cookie_credential ~ '[[:cntrl:]]' THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 answer=staff.check_access(actor,sid,'security.self.read',NULL);
 IF NOT coalesce((answer->>'allowed')::boolean,false) THEN RETURN answer; END IF;
 SELECT * INTO c FROM control_private.session_controls WHERE session_id=sid AND user_id=actor;
 IF c.cookie_mac<>control_private.mac('cookie',cookie_credential) THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 IF (SELECT count(*) FROM control_private.attempts)>=10000 OR ip_scope IS NULL OR ip_scope !~ '^[A-Za-z0-9_-]{1,64}$' THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 INSERT INTO control_private.attempts(challenge_handle,user_id,generation_id,fingerprint,authz_version,permission_version,purpose,state,authenticated_at,primary_deadline,ip_scope,primary_cookie_mac,prior_session_id,prior_epoch_id)
 VALUES(control_private.new_handle(),actor,c.generation_id,c.fingerprint,c.authz_version,c.permission_version,'step_up','bound',n,n+interval '120 seconds',ip_scope,c.cookie_mac,sid,c.epoch_id) RETURNING * INTO ch;
 INSERT INTO audit.events(subject_id,action,source) VALUES(actor,'control.prepared','verifier');
 RETURN control_private.context_result(ch,n);
END $$;
CREATE FUNCTION control_private.reserve_mfa(challenge_handle text,cookie_credential text,raw_code text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; ch control_private.attempts%ROWTYPE; code_digest bytea; burn control_private.replay_burns%ROWTYPE; answer jsonb;
BEGIN
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 IF cookie_credential IS NULL OR octet_length(cookie_credential) NOT BETWEEN 1 AND 16384 OR cookie_credential ~ '[[:cntrl:]]'
 OR raw_code IS NULL OR raw_code !~ '^[0-9]{6}$' THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 -- Governance serializes all runtime writers; acquire budget keys before the
 -- later challenge CAS, rather than reversing the documented lock order.
 SELECT * INTO ch FROM control_private.attempts a WHERE a.challenge_handle=reserve_mfa.challenge_handle;
 IF ch.challenge_handle IS NULL OR ch.state<>'bound' OR ch.primary_deadline<=n OR ch.authenticated_at>n
 OR ch.primary_cookie_mac<>control_private.mac('cookie',cookie_credential)
 OR NOT control_private.live_generation(ch.user_id,ch.generation_id,ch.fingerprint,ch.authz_version,ch.permission_version,ch.prior_session_id)
 THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 IF ch.purpose='step_up' THEN
  answer=staff.check_access(ch.user_id,ch.prior_session_id,'security.self.read',ch.authz_version);
  IF NOT coalesce((answer->>'allowed')::boolean,false) OR NOT EXISTS(SELECT 1 FROM control_private.session_controls WHERE session_id=ch.prior_session_id AND epoch_id=ch.prior_epoch_id AND NOT revoked)
  THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 END IF;
 IF NOT control_private.charge_budget('mfa',ch.user_id,ch.ip_scope,n) THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 code_digest=control_private.mac('user-code',jsonb_build_array(ch.user_id,raw_code)::text);
 SELECT * INTO burn FROM control_private.replay_burns WHERE code_mac=code_digest FOR UPDATE;
 IF burn.code_mac IS NOT NULL AND (burn.expires_at>n OR burn.reserved_at>n) THEN
  UPDATE control_private.attempts a SET state='denied' WHERE a.challenge_handle=ch.challenge_handle;
  RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb;
 END IF;
 IF burn.code_mac IS NULL AND (SELECT count(*) FROM control_private.replay_burns)>=10000 THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 INSERT INTO control_private.replay_burns(code_mac,reserved_at,expires_at) VALUES(code_digest,n,n+interval '180 seconds')
 ON CONFLICT(code_mac) DO UPDATE SET reserved_at=EXCLUDED.reserved_at,expires_at=EXCLUDED.expires_at;
 UPDATE control_private.attempts a SET state='inflight',operation_handle=control_private.new_handle(),reserved_at=n,
 deadline=least(primary_deadline,n+interval '30 seconds'),code_mac=code_digest WHERE a.challenge_handle=ch.challenge_handle RETURNING * INTO ch;
 INSERT INTO audit.events(subject_id,action,source) VALUES(ch.user_id,'control.reserved','verifier');
 RETURN jsonb_build_object('allowed',true,'reason','allowed','operationHandle',ch.operation_handle,'deadline',ch.deadline,'databaseTime',n);
END $$;
CREATE FUNCTION control_private.issue_evidence(operation_handle text,actual_sid text,final_cookie_credential text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; ch control_private.attempts%ROWTYPE; s identity."Session"%ROWTYPE; o control_private.session_observations%ROWTYPE; cm bytea; answer jsonb;
BEGIN
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 IF final_cookie_credential IS NULL OR octet_length(final_cookie_credential) NOT BETWEEN 1 AND 16384 OR final_cookie_credential ~ '[[:cntrl:]]' THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 SELECT * INTO ch FROM control_private.attempts a WHERE a.operation_handle=issue_evidence.operation_handle FOR UPDATE;
 IF ch.challenge_handle IS NULL OR ch.state<>'inflight' OR ch.deadline<=n OR ch.reserved_at>n
 OR NOT control_private.live_generation(ch.user_id,ch.generation_id,ch.fingerprint,ch.authz_version,ch.permission_version,actual_sid)
 OR NOT EXISTS(SELECT 1 FROM control_private.replay_burns WHERE code_mac=ch.code_mac AND reserved_at=ch.reserved_at AND expires_at>n)
 THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 SELECT * INTO s FROM identity."Session" WHERE id=actual_sid AND "userId"=ch.user_id;
 SELECT * INTO o FROM control_private.session_observations WHERE session_id=actual_sid AND user_id=ch.user_id;
 cm=control_private.mac('cookie',final_cookie_credential);
 IF s.id IS NULL OR s."expiresAt"<=n OR o.session_id IS NULL OR o.retired OR o.token_mac<>control_private.mac('session-token',s.token)
 THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 IF ch.purpose='login' THEN
  IF o.first_seen_at<ch.authenticated_at OR EXISTS(SELECT 1 FROM control_private.session_controls WHERE session_id=actual_sid)
  OR EXISTS(SELECT 1 FROM control_private.attempts a WHERE a.final_session_id=actual_sid AND a.state IN ('ready','consumed')) THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 ELSE
  answer=staff.check_access(ch.user_id,ch.prior_session_id,'security.self.read',ch.authz_version);
  IF actual_sid IS DISTINCT FROM ch.prior_session_id OR cm IS DISTINCT FROM ch.primary_cookie_mac
  OR NOT coalesce((answer->>'allowed')::boolean,false)
  OR NOT EXISTS(SELECT 1 FROM control_private.session_controls WHERE session_id=actual_sid AND epoch_id=ch.prior_epoch_id AND NOT revoked)
  THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 END IF;
 UPDATE control_private.attempts a SET state='ready',evidence_handle=control_private.new_handle(),final_session_id=actual_sid,
 final_token_mac=o.token_mac,final_cookie_mac=cm WHERE a.challenge_handle=ch.challenge_handle RETURNING * INTO ch;
 INSERT INTO audit.events(subject_id,action,source) VALUES(ch.user_id,'control.evidence','verifier');
 RETURN jsonb_build_object('allowed',true,'reason','allowed','evidenceHandle',ch.evidence_handle,'sessionId',actual_sid,'userId',ch.user_id,'deadline',ch.deadline,'databaseTime',n);
END $$;

CREATE FUNCTION staff.finalize_control(evidence_handle text,actual_sid text,final_cookie_credential text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; ch control_private.attempts%ROWTYPE; answer jsonb;
BEGIN
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 PERFORM set_config('bookstore.security_actor','',true);
 IF final_cookie_credential IS NULL OR octet_length(final_cookie_credential) NOT BETWEEN 1 AND 16384 OR final_cookie_credential ~ '[[:cntrl:]]' THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 SELECT * INTO ch FROM control_private.attempts a WHERE a.evidence_handle=finalize_control.evidence_handle FOR UPDATE;
 IF ch.challenge_handle IS NULL OR ch.state NOT IN ('ready','consumed') OR ch.deadline<=n OR ch.reserved_at>n
 OR ch.final_session_id IS DISTINCT FROM actual_sid OR ch.final_cookie_mac IS DISTINCT FROM control_private.mac('cookie',final_cookie_credential)
 OR NOT control_private.live_generation(ch.user_id,ch.generation_id,ch.fingerprint,ch.authz_version,ch.permission_version,actual_sid)
 OR NOT EXISTS(SELECT 1 FROM identity."Session" s JOIN control_private.session_observations o ON o.session_id=s.id
 WHERE s.id=actual_sid AND s."userId"=ch.user_id AND s."expiresAt">n AND NOT o.retired AND o.token_mac=ch.final_token_mac AND control_private.mac('session-token',s.token)=ch.final_token_mac)
 OR NOT EXISTS(SELECT 1 FROM control_private.replay_burns WHERE code_mac=ch.code_mac AND reserved_at=ch.reserved_at AND expires_at>n)
 THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 IF ch.state='consumed' THEN
  answer=staff.check_access(ch.user_id,actual_sid,'security.self.read',ch.authz_version);
  IF coalesce((answer->>'allowed')::boolean,false) THEN RETURN ch.result; END IF;
  RETURN answer;
 END IF;
 IF ch.purpose='step_up' THEN
  answer=staff.check_access(ch.user_id,actual_sid,'security.self.read',ch.authz_version);
  IF NOT coalesce((answer->>'allowed')::boolean,false) OR NOT EXISTS(SELECT 1 FROM control_private.session_controls WHERE session_id=actual_sid AND epoch_id=ch.prior_epoch_id AND NOT revoked)
  THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM control_private.session_controls WHERE session_id=actual_sid)
  OR EXISTS(SELECT 1 FROM staff.admissions WHERE session_id=actual_sid) THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 END IF;
 PERFORM set_config('bookstore.security_actor',ch.user_id,true);
 IF ch.purpose='login' THEN
  INSERT INTO control_private.session_controls(session_id,user_id,generation_id,fingerprint,authz_version,permission_version,token_mac,cookie_mac,authenticated_at,absolute_deadline)
  VALUES(actual_sid,ch.user_id,ch.generation_id,ch.fingerprint,ch.authz_version,ch.permission_version,ch.final_token_mac,ch.final_cookie_mac,ch.authenticated_at,ch.authenticated_at+interval '8 hours');
  INSERT INTO staff.admissions(session_id,user_id,authz_version,mode,authenticated_at,last_seen_at,mfa_at)
  VALUES(actual_sid,ch.user_id,ch.authz_version,'verified',ch.authenticated_at,n,ch.reserved_at);
 ELSE
  UPDATE staff.admissions SET mfa_at=greatest(mfa_at,ch.reserved_at) WHERE session_id=actual_sid AND user_id=ch.user_id;
 END IF;
 INSERT INTO audit.events(actor_id,subject_id,action,source) VALUES(ch.user_id,ch.user_id,CASE ch.purpose WHEN 'login' THEN 'control.login' ELSE 'control.step_up' END,'staff');
 PERFORM set_config('bookstore.security_actor','',true);
 answer=staff.check_access(ch.user_id,actual_sid,'security.self.read',ch.authz_version);
 IF NOT coalesce((answer->>'allowed')::boolean,false) THEN RAISE EXCEPTION 'Control finalization failed' USING ERRCODE='55000'; END IF;
 UPDATE control_private.attempts a SET state='consumed',consumed_at=n,result=answer WHERE a.challenge_handle=ch.challenge_handle;
 RETURN answer;
END $$;
CREATE FUNCTION staff.touch_control(actor text,sid text,expected_version bigint) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; answer jsonb;
BEGIN
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN '{"allowed":false,"reason":"unavailable"}'::jsonb; END IF;
 PERFORM set_config('bookstore.security_actor','',true);
 answer=staff.check_access(actor,sid,'security.self.read',expected_version);
 IF NOT coalesce((answer->>'allowed')::boolean,false) THEN RETURN answer; END IF;
 -- Only a trusted explicit foreground use-case may invoke this capability.
 PERFORM set_config('bookstore.security_actor',actor,true);
 UPDATE staff.admissions SET last_seen_at=greatest(last_seen_at,n) WHERE session_id=sid AND user_id=actor;
 PERFORM set_config('bookstore.security_actor','',true);
 RETURN answer;
END $$;
CREATE FUNCTION audit.cleanup_control_orphans(batch_limit integer) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; candidate record; removed integer=0;
BEGIN
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN 0; END IF;
 IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid cleanup bound' USING ERRCODE='22023'; END IF;
 FOR candidate IN SELECT o.session_id,o.user_id,o.token_mac FROM control_private.session_observations o
 JOIN identity."Session" s ON s.id=o.session_id AND s."userId"=o.user_id
 WHERE o.first_seen_at+interval '5 minutes'<n
 AND NOT EXISTS(SELECT 1 FROM staff.admissions a WHERE a.session_id=o.session_id)
 AND NOT EXISTS(SELECT 1 FROM control_private.attempts a WHERE (a.final_session_id=o.session_id OR a.prior_session_id=o.session_id OR (a.user_id=o.user_id AND a.final_session_id IS NULL)) AND a.state IN ('prepared','bound','inflight','ready') AND coalesce(a.deadline,a.primary_deadline)>n)
 AND control_private.mac('session-token',s.token)=o.token_mac
 ORDER BY o.first_seen_at,o.session_id LIMIT batch_limit LOOP
  PERFORM control_private.retire_session(candidate.session_id);
  DELETE FROM identity."Session" s WHERE s.id=candidate.session_id AND s."userId"=candidate.user_id AND control_private.mac('session-token',s.token)=candidate.token_mac;
  IF FOUND THEN
   INSERT INTO audit.events(subject_id,action,source) VALUES(candidate.user_id,'control.orphan','worker');
   removed=removed+1;
  END IF;
 END LOOP;
 RETURN removed;
END $$;
CREATE FUNCTION audit.expire_control_attempts(batch_limit integer) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n timestamptz; removed integer;
BEGIN
 n=control_private.lock_time();
 IF n IS NULL THEN RETURN 0; END IF;
 IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid cleanup bound' USING ERRCODE='22023'; END IF;
 WITH gone AS (DELETE FROM control_private.attempts WHERE challenge_handle IN
  (SELECT challenge_handle FROM control_private.attempts WHERE coalesce(deadline,primary_deadline)<=n ORDER BY coalesce(deadline,primary_deadline),challenge_handle LIMIT batch_limit) RETURNING 1)
 SELECT count(*)::integer INTO removed FROM gone;
 -- Replay expiry is independent of proof lifetime, never released by finalization.
 DELETE FROM control_private.replay_burns WHERE code_mac IN (SELECT code_mac FROM control_private.replay_burns WHERE expires_at<=n ORDER BY expires_at LIMIT batch_limit);
 DELETE FROM control_private.budgets WHERE key_mac IN (SELECT key_mac FROM control_private.budgets WHERE window_end<=n ORDER BY window_end LIMIT batch_limit);
 RETURN removed;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA control_private FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_private FROM PUBLIC;
-- On a hardened005 upgrade, untouched foundation helpers remain Guard-owned.
-- Their PUBLIC ACLs were already revoked by005/offline hardening; migrate must
-- neither acquire that ownership nor attempt a schema-wide REVOKE on them.
-- Revoke only the new/replaced functions owned by this reviewed migration.
REVOKE ALL ON FUNCTION staff.check_access_b1(text,text,text,bigint),
 staff.check_access(text,text,text,bigint),staff.control_clock_probe(),
 staff.finalize_control(text,text,text),staff.touch_control(text,text,bigint),
 audit.staff_change(),audit.cleanup_control_orphans(integer),
 audit.expire_control_attempts(integer) FROM PUBLIC;
-- Exact runtime grants, extension ACLs and Guard ownership are installed by the
-- owned offline hardener only; migration alone never enables runtime controls.
COMMIT;
