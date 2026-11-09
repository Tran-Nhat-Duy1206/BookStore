-- B3.2B.1: persistence only. No identity, eligible Owner or verified admission is seeded.
CREATE SCHEMA staff;
CREATE SCHEMA audit;
REVOKE ALL ON SCHEMA staff, audit FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA staff, audit REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE staff.roles (name text PRIMARY KEY);
INSERT INTO staff.roles VALUES ('Owner'),('CatalogManager'),('Editor'),('Publisher'),('InventoryManager'),('Analyst');
CREATE TABLE staff.permissions (
 name text PRIMARY KEY, definition_version integer NOT NULL CHECK(definition_version=1), active boolean NOT NULL
);
INSERT INTO staff.permissions VALUES
 ('security.self.read',1,true),('security.self.revoke',1,true),
 ('security.staff.status',1,true),('security.staff.roles',1,true),('security.audit.read',1,true),
 ('catalog.write',1,false),('content.draft',1,false),('content.publish',1,false),
 ('inventory.adjust',1,false),('analytics.read',1,false);
CREATE TABLE staff.role_permissions (
 role_name text NOT NULL REFERENCES staff.roles(name), permission_name text NOT NULL REFERENCES staff.permissions(name),
 PRIMARY KEY(role_name,permission_name)
);
INSERT INTO staff.role_permissions SELECT name,'security.self.read' FROM staff.roles;
INSERT INTO staff.role_permissions SELECT name,'security.self.revoke' FROM staff.roles;
INSERT INTO staff.role_permissions VALUES ('Owner','security.staff.status'),('Owner','security.staff.roles'),('Owner','security.audit.read');
CREATE TABLE staff.governance (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 state text NOT NULL DEFAULT 'uninitialized' CHECK(state IN ('uninitialized','bootstrap','active','recovery_locked')),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO staff.governance(singleton) VALUES(true);
CREATE TABLE staff.principals (
 user_id text PRIMARY KEY REFERENCES identity."User"(id) ON DELETE CASCADE ON UPDATE RESTRICT,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended','disabled','recovery')),
 authz_version integer NOT NULL DEFAULT 0 CHECK(authz_version>=0),
 permission_version integer NOT NULL DEFAULT 1 CHECK(permission_version=1),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE staff.role_grants (
 user_id text NOT NULL REFERENCES staff.principals(user_id) ON DELETE CASCADE,
 role_name text NOT NULL REFERENCES staff.roles(name), PRIMARY KEY(user_id,role_name)
);
ALTER TABLE identity."Session" ADD CONSTRAINT "Session_id_userId_key" UNIQUE(id,"userId");
CREATE TABLE staff.admissions (
 session_id text PRIMARY KEY, user_id text NOT NULL REFERENCES staff.principals(user_id) ON DELETE CASCADE,
 authz_version integer NOT NULL CHECK(authz_version>=0),
 mode text NOT NULL DEFAULT 'pending' CHECK(mode IN ('pending','verified','recovery','revoked')),
 authenticated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 mfa_at timestamptz,
 CHECK(last_seen_at>=authenticated_at),
 CHECK(mfa_at IS NULL OR mfa_at>=authenticated_at),
 CHECK(mode<>'verified' OR mfa_at IS NOT NULL),
 FOREIGN KEY(session_id,user_id) REFERENCES identity."Session"(id,"userId") ON DELETE CASCADE ON UPDATE RESTRICT
);
-- Explicitly NOT an admission writer: no runtime grants or function can create verified MFA evidence in B.1.

CREATE TABLE audit.events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 actor_id text CHECK(actor_id IS NULL OR actor_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 subject_id text CHECK(subject_id IS NULL OR subject_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 action text NOT NULL CHECK(action IN ('principal.insert','principal.update','principal.delete','roles.insert','roles.delete',
 'admission.insert','admission.update','admission.delete','governance.changed','provider.reconciled')),
 outcome text NOT NULL DEFAULT 'success' CHECK(outcome='success'),
 source text NOT NULL CHECK(source IN ('staff','auth','worker','offline')),
 transition_id bigint UNIQUE
);
CREATE TABLE audit.provider_events (
 id bigserial PRIMARY KEY,
 user_id text NOT NULL CHECK(user_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 session_id text CHECK(session_id IS NULL OR session_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 kind text NOT NULL CHECK(kind IN ('identity.changed','credential.changed','factor.changed','session.created','session.changed','session.deleted')),
 invalidates_user boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processed','blocked')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 failure_code text CHECK(failure_code IN ('storage_unavailable','apply_failed')),
 processed_at timestamptz,
 CHECK((state='processed')=(processed_at IS NOT NULL))
);
CREATE INDEX provider_events_pending ON audit.provider_events(user_id,state) WHERE state<>'processed';
CREATE INDEX provider_events_ready ON audit.provider_events(id) WHERE state='pending' AND attempts<5;
CREATE TABLE audit.denials (
 id uuid PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason text NOT NULL CHECK(reason IN ('unauthenticated','forbidden','stale','unavailable')),
 outcome text NOT NULL DEFAULT 'denied' CHECK(outcome IN ('denied','rolled_back','unavailable'))
);

-- All definer functions are re-owned by an isolated marked NOLOGIN guard before runtime grants.
-- Fresh offline/legacy migration paths have NO public EXECUTE or runtime activation.
CREATE FUNCTION staff.require_read_committed() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 -- A mutex alone cannot refresh REPEATABLE READ snapshots. Unsupported isolation fails before mutation/admission.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Security foundation requires READ COMMITTED isolation' USING ERRCODE='0A000';
 END IF;
END $$;
CREATE FUNCTION staff.security_lock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM staff.require_read_committed();
 PERFORM 1 FROM staff.governance WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Security governance unavailable' USING ERRCODE='55000'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION staff.eligible_owner_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT count(*) FROM staff.principals p JOIN identity."User" u ON u.id=p.user_id
 WHERE p.status='active' AND u."emailVerified" AND u."twoFactorEnabled"
 AND EXISTS(SELECT 1 FROM staff.role_grants r WHERE r.user_id=p.user_id AND r.role_name='Owner')
 AND EXISTS(SELECT 1 FROM identity."TwoFactor" t WHERE t."userId"=p.user_id AND t.verified AND t.secret<>'')
 AND EXISTS(SELECT 1 FROM identity."Account" a WHERE a."userId"=p.user_id AND a."providerId"='credential' AND a.password IS NOT NULL AND a.password<>'')
$$;
CREATE FUNCTION staff.enforce_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF (SELECT state FROM staff.governance WHERE singleton)='active' AND staff.eligible_owner_count()<1 THEN
  RAISE EXCEPTION 'Last eligible Owner cannot be removed' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION staff.governance_transition() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Governance singleton is permanent' USING ERRCODE='23514'; END IF;
 IF NEW.singleton<>OLD.singleton OR NEW.revision<>OLD.revision THEN RAISE EXCEPTION 'Invalid governance update' USING ERRCODE='23514'; END IF;
 IF NOT ((OLD.state='uninitialized' AND NEW.state='bootstrap') OR (OLD.state='bootstrap' AND NEW.state='active' AND staff.eligible_owner_count()=1)) THEN
  RAISE EXCEPTION 'Governance transition not enabled in this batch' USING ERRCODE='23514';
 END IF;
 NEW.revision=OLD.revision+1;
 RETURN NEW;
END $$;
CREATE TRIGGER governance_transition BEFORE UPDATE OR DELETE ON staff.governance FOR EACH ROW EXECUTE FUNCTION staff.governance_transition();

CREATE FUNCTION staff.version_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.status,NEW.permission_version) IS DISTINCT FROM (OLD.status,OLD.permission_version) THEN NEW.authz_version=OLD.authz_version+1; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER principal_version BEFORE UPDATE ON staff.principals FOR EACH ROW EXECUTE FUNCTION staff.version_change();

CREATE FUNCTION audit.staff_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text; action_name text; origin text; actor text;
BEGIN
 origin=CASE WHEN session_user ~ '_staff$' THEN 'staff' WHEN session_user ~ '_auth$' THEN 'auth' WHEN session_user ~ '_worker$' THEN 'worker' ELSE 'offline' END;
 -- Only the reviewed staff functions set actor context; auth/worker cannot forge attribution with a custom GUC.
 actor=CASE WHEN origin='staff' THEN nullif(current_setting('bookstore.security_actor',true),'') ELSE NULL END;
 IF TG_TABLE_NAME='governance' THEN subject=NULL; action_name='governance.changed';
 ELSE
  subject=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  action_name=CASE TG_TABLE_NAME WHEN 'principals' THEN 'principal.' WHEN 'role_grants' THEN 'roles.' ELSE 'admission.' END || lower(TG_OP);
 END IF;
 INSERT INTO audit.events(actor_id,subject_id,action,source) VALUES(actor,subject,action_name,origin);
 IF TG_TABLE_NAME='role_grants' THEN
  UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=subject;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER principal_audit AFTER INSERT OR UPDATE OR DELETE ON staff.principals FOR EACH ROW EXECUTE FUNCTION audit.staff_change();
CREATE TRIGGER role_audit AFTER INSERT OR DELETE ON staff.role_grants FOR EACH ROW EXECUTE FUNCTION audit.staff_change();
CREATE TRIGGER admission_audit AFTER INSERT OR UPDATE OR DELETE ON staff.admissions FOR EACH ROW EXECUTE FUNCTION audit.staff_change();
CREATE TRIGGER governance_audit AFTER UPDATE ON staff.governance FOR EACH ROW EXECUTE FUNCTION audit.staff_change();

CREATE FUNCTION audit.provider_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text; sid text; event_kind text; invalidates boolean=true;
BEGIN
 IF TG_TABLE_NAME='User' THEN
  subject=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  IF TG_OP='UPDATE' AND (NEW."emailVerified",NEW."twoFactorEnabled",NEW.email) IS NOT DISTINCT FROM (OLD."emailVerified",OLD."twoFactorEnabled",OLD.email) THEN RETURN NULL; END IF;
  event_kind='identity.changed';
 ELSIF TG_TABLE_NAME='Account' THEN
  subject=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
  IF TG_OP='UPDATE' AND (NEW.password,NEW."userId",NEW."providerId") IS NOT DISTINCT FROM (OLD.password,OLD."userId",OLD."providerId") THEN RETURN NULL; END IF;
  event_kind='credential.changed';
 ELSIF TG_TABLE_NAME='TwoFactor' THEN
  subject=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
  IF TG_OP='UPDATE' AND (NEW.secret,NEW."backupCodes",NEW.verified,NEW."userId") IS NOT DISTINCT FROM (OLD.secret,OLD."backupCodes",OLD.verified,OLD."userId") THEN RETURN NULL; END IF;
  event_kind='factor.changed';
 ELSE
  subject=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
  sid=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  IF TG_OP='UPDATE' AND (NEW."expiresAt",NEW."userId",NEW.token) IS NOT DISTINCT FROM (OLD."expiresAt",OLD."userId",OLD.token) THEN RETURN NULL; END IF;
  event_kind=CASE TG_OP WHEN 'INSERT' THEN 'session.created' WHEN 'DELETE' THEN 'session.deleted' ELSE 'session.changed' END;
  invalidates=false;
 END IF;
 IF (SELECT count(*) FROM audit.provider_events WHERE state<>'processed')>=1000 THEN
  RAISE EXCEPTION 'Security transition backlog saturated' USING ERRCODE='54000';
 END IF;
 -- Only opaque identifiers and fixed event kinds are retained. Never OLD/NEW JSON or secret values.
 INSERT INTO audit.provider_events(user_id,session_id,kind,invalidates_user) VALUES(subject,sid,event_kind,invalidates);
 RETURN NULL;
END $$;

-- Statement-level BEFORE locking precedes tuple locks; all actor/Owner-affecting paths share this singleton.
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['User','Account','TwoFactor','Session'] LOOP
  EXECUTE format('CREATE TRIGGER security_lock BEFORE INSERT OR UPDATE OR DELETE ON identity.%I FOR EACH STATEMENT EXECUTE FUNCTION staff.security_lock()',tab);
  EXECUTE format('CREATE TRIGGER owner_invariant AFTER INSERT OR UPDATE OR DELETE ON identity.%I FOR EACH STATEMENT EXECUTE FUNCTION staff.enforce_owner()',tab);
  EXECUTE format('CREATE TRIGGER durable_transition AFTER INSERT OR UPDATE OR DELETE ON identity.%I FOR EACH ROW EXECUTE FUNCTION audit.provider_change()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['principals','role_grants','admissions'] LOOP
  EXECUTE format('CREATE TRIGGER security_lock BEFORE INSERT OR UPDATE OR DELETE ON staff.%I FOR EACH STATEMENT EXECUTE FUNCTION staff.security_lock()',tab);
  EXECUTE format('CREATE TRIGGER owner_invariant AFTER INSERT OR UPDATE OR DELETE ON staff.%I FOR EACH STATEMENT EXECUTE FUNCTION staff.enforce_owner()',tab);
 END LOOP;
END $$;

CREATE FUNCTION staff.check_access(actor text, sid text, permission text, expected_version bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p staff.principals%ROWTYPE; a staff.admissions%ROWTYPE; role_names jsonb;
 checked_at timestamptz=clock_timestamp();
BEGIN
 PERFORM staff.require_read_committed();
 IF actor IS NULL OR sid IS NULL THEN RETURN '{"allowed":false,"reason":"unauthenticated"}'::jsonb; END IF;
 IF NOT EXISTS(SELECT 1 FROM staff.governance WHERE singleton AND state='active') THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 SELECT * INTO p FROM staff.principals WHERE user_id=actor;
 IF NOT FOUND OR p.status<>'active' OR p.permission_version<>1 THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 IF expected_version IS NOT NULL AND expected_version<>p.authz_version THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 IF NOT EXISTS(SELECT 1 FROM identity."Session" WHERE id=sid AND "userId"=actor AND "expiresAt">checked_at)
 THEN RETURN '{"allowed":false,"reason":"unauthenticated"}'::jsonb; END IF;
 SELECT * INTO a FROM staff.admissions WHERE session_id=sid AND user_id=actor;
 IF NOT FOUND OR a.mode<>'verified' OR a.authz_version<>p.authz_version OR a.authenticated_at>checked_at
 OR a.authenticated_at+interval '8 hours'<=checked_at OR a.last_seen_at+interval '30 minutes'<=checked_at
 OR a.last_seen_at>checked_at OR a.mfa_at>checked_at THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 IF NOT EXISTS(SELECT 1 FROM identity."User" u WHERE u.id=actor AND u."emailVerified" AND u."twoFactorEnabled")
 OR NOT EXISTS(SELECT 1 FROM identity."TwoFactor" t WHERE t."userId"=actor AND t.verified) THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 IF EXISTS(SELECT 1 FROM audit.provider_events e WHERE e.user_id=actor AND e.state<>'processed' AND (e.invalidates_user OR (e.session_id=sid AND e.kind<>'session.created'))) THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 IF NOT EXISTS(SELECT 1 FROM staff.role_grants r JOIN staff.role_permissions rp ON rp.role_name=r.role_name
 JOIN staff.permissions pm ON pm.name=rp.permission_name
 WHERE r.user_id=actor AND pm.name=permission AND pm.active AND pm.definition_version=1) THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 IF permission IN ('security.staff.status','security.staff.roles','security.audit.read') AND a.mfa_at+interval '5 minutes'<=checked_at THEN RETURN '{"allowed":false,"reason":"stale"}'::jsonb; END IF;
 SELECT jsonb_agg(role_name ORDER BY role_name) INTO role_names FROM staff.role_grants WHERE user_id=actor;
 RETURN jsonb_build_object('allowed',true,'reason','allowed','authorizationVersion',p.authz_version,'roles',coalesce(role_names,'[]'::jsonb));
END $$;

CREATE FUNCTION staff.set_status(actor text,sid text,expected_version bigint,target text,new_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE decision jsonb;
BEGIN
 PERFORM staff.require_read_committed();
 PERFORM 1 FROM staff.governance WHERE singleton FOR UPDATE;
 decision=staff.check_access(actor,sid,'security.staff.status',expected_version);
 IF NOT (decision->>'allowed')::boolean THEN RETURN decision; END IF;
 IF new_status NOT IN ('active','suspended','disabled') OR NOT EXISTS(SELECT 1 FROM staff.principals WHERE user_id=target AND status IN ('active','suspended','disabled')) THEN RAISE EXCEPTION 'Invalid status transition' USING ERRCODE='22023'; END IF;
 PERFORM set_config('bookstore.security_actor',actor,true);
 UPDATE staff.principals SET status=new_status WHERE user_id=target;
 PERFORM set_config('bookstore.security_actor','',true);
 RETURN jsonb_build_object('allowed',true,'reason','allowed','authorizationVersion',(SELECT authz_version FROM staff.principals WHERE user_id=actor));
END $$;
CREATE FUNCTION staff.replace_roles(actor text,sid text,expected_version bigint,target text,new_roles text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE decision jsonb;
BEGIN
 PERFORM staff.require_read_committed();
 PERFORM 1 FROM staff.governance WHERE singleton FOR UPDATE;
 decision=staff.check_access(actor,sid,'security.staff.roles',expected_version);
 IF NOT (decision->>'allowed')::boolean THEN RETURN decision; END IF;
 IF new_roles IS NULL OR cardinality(new_roles)>6 OR EXISTS(SELECT 1 FROM unnest(new_roles) n WHERE n IS NULL OR NOT EXISTS(SELECT 1 FROM staff.roles r WHERE r.name=n)) OR NOT EXISTS(SELECT 1 FROM staff.principals WHERE user_id=target) THEN RAISE EXCEPTION 'Invalid fixed roles' USING ERRCODE='22023'; END IF;
 PERFORM set_config('bookstore.security_actor',actor,true);
 -- Insert first: replacing an unchanged Owner grant must not create a transient zero-Owner state.
 INSERT INTO staff.role_grants SELECT target,n FROM unnest(new_roles) n ON CONFLICT DO NOTHING;
 DELETE FROM staff.role_grants WHERE user_id=target AND NOT(role_name=ANY(new_roles));
 PERFORM set_config('bookstore.security_actor','',true);
 RETURN jsonb_build_object('allowed',true,'reason','allowed','authorizationVersion',(SELECT authz_version FROM staff.principals WHERE user_id=actor));
END $$;
CREATE FUNCTION staff.revoke_admission(actor text,sid text,expected_version bigint,target_sid text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE decision jsonb;
BEGIN
 PERFORM staff.require_read_committed();
 PERFORM 1 FROM staff.governance WHERE singleton FOR UPDATE;
 decision=staff.check_access(actor,sid,'security.self.revoke',expected_version);
 IF NOT (decision->>'allowed')::boolean THEN RETURN decision; END IF;
 IF NOT EXISTS(SELECT 1 FROM staff.admissions WHERE session_id=target_sid AND user_id=actor) THEN RETURN '{"allowed":false,"reason":"forbidden"}'::jsonb; END IF;
 PERFORM set_config('bookstore.security_actor',actor,true);
 UPDATE staff.admissions SET mode='revoked' WHERE session_id=target_sid AND user_id=actor;
 PERFORM set_config('bookstore.security_actor','',true);
 RETURN decision;
END $$;

CREATE FUNCTION audit.record_denial(request_id uuid,denial_reason text,denial_outcome text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM staff.require_read_committed();
 PERFORM 1 FROM staff.governance WHERE singleton FOR UPDATE;
 IF denial_reason IS NULL OR denial_reason NOT IN ('unauthenticated','forbidden','stale','unavailable') THEN RAISE EXCEPTION 'Invalid denial reason' USING ERRCODE='22023'; END IF;
 IF denial_outcome IS NULL OR denial_outcome NOT IN ('denied','rolled_back','unavailable') THEN RAISE EXCEPTION 'Invalid denial outcome' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM audit.denials)>=1000 THEN RAISE EXCEPTION 'Durable denial sink saturated' USING ERRCODE='54000'; END IF;
 INSERT INTO audit.denials(id,reason,outcome) VALUES(request_id,denial_reason,denial_outcome) ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION audit.pending_provider_events(batch_limit integer) RETURNS TABLE(id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF batch_limit IS NULL OR batch_limit<1 OR batch_limit>100 THEN RAISE EXCEPTION 'Invalid reconciliation batch bound' USING ERRCODE='22023'; END IF;
 RETURN QUERY SELECT e.id FROM audit.provider_events e WHERE e.state='pending' AND e.attempts<5 ORDER BY e.id LIMIT batch_limit;
END $$;
CREATE FUNCTION audit.reconcile_provider_event(event_id bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e audit.provider_events%ROWTYPE;
BEGIN
 PERFORM staff.require_read_committed();
 PERFORM 1 FROM staff.governance WHERE singleton FOR UPDATE;
 SELECT * INTO e FROM audit.provider_events WHERE id=event_id FOR UPDATE;
 IF NOT FOUND OR e.state<>'pending' OR e.attempts>=5 THEN RETURN false; END IF;
 IF e.invalidates_user THEN
  UPDATE staff.principals SET authz_version=authz_version+1 WHERE user_id=e.user_id;
  DELETE FROM staff.admissions WHERE user_id=e.user_id;
 ELSIF e.kind<>'session.created' THEN
  DELETE FROM staff.admissions WHERE session_id=e.session_id AND user_id=e.user_id;
 END IF;
 INSERT INTO audit.events(subject_id,action,source,transition_id) VALUES(e.user_id,'provider.reconciled','worker',e.id);
 UPDATE audit.provider_events SET state='processed',processed_at=clock_timestamp(),failure_code=NULL WHERE id=e.id;
 RETURN true;
END $$;
CREATE FUNCTION audit.record_reconcile_failure(event_id bigint,reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM staff.require_read_committed();
 PERFORM 1 FROM staff.governance WHERE singleton FOR UPDATE;
 IF reason IS NULL OR reason NOT IN ('storage_unavailable','apply_failed') THEN RAISE EXCEPTION 'Invalid failure code' USING ERRCODE='22023'; END IF;
 UPDATE audit.provider_events SET attempts=attempts+1,failure_code=reason,state=CASE WHEN attempts+1>=5 THEN 'blocked' ELSE 'pending' END
 WHERE id=event_id AND state='pending' AND attempts<5;
END $$;

-- Provider identifiers/ownership are immutable; moving a row must not hide invalidation of its old owner.
CREATE FUNCTION audit.reject_provider_rebind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Provider identity key is immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME<>'User' THEN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" THEN RAISE EXCEPTION 'Provider ownership is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='Account' THEN
  IF (NEW."providerId",NEW."accountId") IS DISTINCT FROM (OLD."providerId",OLD."accountId") THEN RAISE EXCEPTION 'Provider account binding is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_binding BEFORE UPDATE ON identity."User" FOR EACH ROW EXECUTE FUNCTION audit.reject_provider_rebind();
CREATE TRIGGER immutable_binding BEFORE UPDATE ON identity."Account" FOR EACH ROW EXECUTE FUNCTION audit.reject_provider_rebind();
CREATE TRIGGER immutable_binding BEFORE UPDATE ON identity."TwoFactor" FOR EACH ROW EXECUTE FUNCTION audit.reject_provider_rebind();
CREATE TRIGGER immutable_binding BEFORE UPDATE ON identity."Session" FOR EACH ROW EXECUTE FUNCTION audit.reject_provider_rebind();

REVOKE ALL ON ALL TABLES IN SCHEMA staff,audit FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA staff,audit FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA staff,audit FROM PUBLIC;
