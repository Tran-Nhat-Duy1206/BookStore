# ADR-014 — Purpose privileges, RBAC and audit/revocation consistency

Status: experimental privilege proof and proposed full architecture. Existing application/catalog safeguards are not replaced or weakened.

## Isolation and purpose credentials

Use a fresh, marker-owned BookStore auth-spike cluster, not an existing project's service or the catalog development database. Local55434 and CI55435 are distinct from catalog55432/55433 and existing5432. Each run creates a new database and matching random-role suffix. The bootstrap connection may only administer that new cluster/base; four independently validated URLs bind exact purpose, role and owned database suffix. No query/hash/external host/default port or role inheritance.

| Purpose | Experimental grants | Forbidden |
|---|---|---|
| Catalog reader | SELECT public catalog tables | Identity/staff/audit access, catalog writes, DDL/TEMP |
| Auth persistence | DML identity tables and required sequence access | Staff/role/audit/catalog authority, DDL/TEMP |
| Staff/audit service | DML staff tables; INSERT/SELECT audit | Identity secrets/catalog writes, audit UPDATE/DELETE/TRUNCATE, DDL/TEMP |
| Offline migration | Own new database/schema DDL | Runtime use |

Runtime roles are NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS/NOINHERIT and have no memberships. Revoke PUBLIC database/schema/object defaults. Migration ownership is separate; naming schemas alone provides no privilege isolation. The readonly catalog role must still reject writes after changing its transaction-readonly setting off.

Apply unchanged catalog SQL and original seed only to the disposable experimental database to prove DTO parity under the reader role. The experimental identity schema/client/SQL is separate from the application Prisma schema and its three immutable migrations. No runtime imports or credentials are added to the storefront. Cleanup requires in-memory ownership plus matching database/role markers, closes all owned clients and never uses FORCE/terminate/global resets.

A future auth-enabled application must use dedicated purpose clients, reject bootstrap/migration/superuser credentials and keep secrets out of client bundles. Replacing current bootstrap-oriented CLI/test credential wiring requires an approved migration/privilege ADR implementation; this experiment is not permission to widen the [catalog URL guard](../src/server/database/config.ts). Cluster-role creation is offline bootstrap, not an ordinary app migration or public endpoint. PostgreSQL shared service-role credentials do not themselves enforce actor-level RBAC.

## Server authorization boundary

Fixed roles and explicit grants follow [the security plan](./batch-3-2-security-plan.md). No implicit Publisher→Editor inheritance, Owner wildcard or client-provided actor/scope. Object/field permission checks occur in use cases against trusted records. Future domain permissions remain inert; no operational endpoints are created. Typed resource-scope relations gain real FKs with their future domain models, not generic unchecked IDs now.

The experiment's minimal staff/admission gate is NOT complete role management or production RBAC. It demonstrates current staff state, session ownership, authorization-version and MFA/recovery checks only. Runtime auth persistence cannot promote itself by writing staff roles.

## Consistency and auditing

Local staff admission/access changes and redacted audit insertion must commit together. Failed audit insertion rolls back admission. Provider sessions may already exist in their own transaction: they remain non-privileged until local admission commits. Do not claim provider operation + application audit is atomic across independent clients/providers. Complete compensation/outbox/reconciliation and bounded failure logging remain a full-implementation gate.

Revocation/version changes deny old admission immediately at the next checked request; do not automatically re-admit an old provider session. Sensitive writes share locking and transaction revalidation with revocation. Define and test the winning linearization point, not an impossible retroactive revocation guarantee.

Audit is append-only for runtime roles, not cryptographically immutable against an offline database owner. Retain actor/target identifiers and redacted action/outcome/request correlation; no tokens/passwords/MFA seeds/codes/provider payload dumps. Successful actions and failures must be distinguished. Log denied/rolled-back attempts through a separate bounded sink after rollback, never a success event in a doomed transaction. Audit unavailability denies privileged changes and emits a non-sensitive operational signal.

The spike verifies local success-admission rollback and SQL append-only privileges. It does not implement the complete durable denial sink, outbox worker, audit UI/export, retention, backups or production role deployment.
