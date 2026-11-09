-- Experimental admission model ONLY. Not an application migration.
BEGIN;
CREATE SCHEMA staff;
CREATE SCHEMA audit;
REVOKE ALL ON SCHEMA staff, audit, identity FROM PUBLIC;
ALTER TABLE identity."Session" ADD CONSTRAINT "Session_id_userId_owned" UNIQUE (id, "userId");
CREATE TABLE staff.principals (
  user_id TEXT PRIMARY KEY REFERENCES identity."User"(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('enrollment','active','suspended','disabled','recovery')),
  role TEXT NOT NULL CHECK (role IN ('Owner','CatalogManager','Editor','Publisher','InventoryManager','Analyst')),
  authz_version INTEGER NOT NULL DEFAULT 0 CHECK (authz_version >= 0)
);
CREATE TABLE staff.admissions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES staff.principals(user_id) ON DELETE RESTRICT,
  authz_version INTEGER NOT NULL CHECK (authz_version >= 0),
  mode TEXT NOT NULL CHECK (mode IN ('totp','recovery')),
  mfa_at TIMESTAMPTZ(3) NOT NULL,
  last_seen_at TIMESTAMPTZ(3) NOT NULL,
  admitted_at TIMESTAMPTZ(3) NOT NULL,
  FOREIGN KEY (session_id,user_id) REFERENCES identity."Session"(id,"userId") ON DELETE CASCADE
);
CREATE INDEX admissions_user_id ON staff.admissions(user_id);
CREATE TABLE audit.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id TEXT REFERENCES staff.principals(user_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('ADMISSION_TOTP','ADMISSION_RECOVERY','ACCESS_CHANGED')),
  occurred_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object')
);
COMMIT;
