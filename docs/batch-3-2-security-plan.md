# Batch 3.2 — Secure Admin Boundary: approved planning baseline

## Authorization status

PR #2 merged normally at main `ce8165d8f7f8905378b36728e6c07b04ba20d9e9`, preserving reviewed tree `27411bf09fde0c664383845d809414b3ccf8a1fa`. The owner authorized **Batch 3.2A: isolated Better Auth compatibility/security spike only**. The following preserves the security plan delivered before that authorization. It does not authorize a production login, administrative application, customer identity, operational CRUD, deployment or paid infrastructure.

## Proposed architecture

Retain Next.js16, React19, TypeScript6, Prisma7.10.1 and PostgreSQL18 modular monolith. Recommend maintained Better Auth with Prisma persistence and mandatory TOTP, conditional on actual compatibility and advisory review. Supabase Auth remains an alternative with a separate identity-service/runtime and hosted-plan considerations. No homemade password cryptography.

A restricted staff-only transport would call the provider behind a server-only admission/authorization facade. Do not expose an unrestricted provider catch-all. Layout/proxy/cookie-presence checks are never authorization. Every protected handler/action/loader and application use case must validate live staff, session and MFA state. Clients receive minimal DTOs, not tokens/provider/ORM records. All staff UI remains Vietnamese and respects the existing Cozy Bookstore appearance and accessibility.

## Explicit permissions and object policy

Fixed versioned roles; no implicit hierarchy or arbitrary permission editor. Role grants union explicit permissions; unknown actions/scopes/fields deny. Owner gets enumerated permissions, not an unchecked wildcard. All roles get only admitted shell and narrowly scoped self-security actions.

| Role | Intended future domain grant | Security management |
|---|---|---|
| Owner | Explicit catalog/editorial/publishing/inventory/report grants | Staff access, recovery approval, security audit; no audit editing |
| CatalogManager | Catalog metadata read/write | Own security only |
| Editor | Own/assigned editorial draft editing; catalog references | Own security only |
| Publisher | Approved-scope draft review and approved-revision publication/scheduling | Own security only |
| InventoryManager | Assigned-location inventory operations and summaries | Own security only |
| Analyst | Approved read-only aggregates/reports; no raw security audit or staff PII | Own security only |

These domain grants are inert until their separately approved batches. Derive object ownership/assignment/location from trusted records. Persist typed resource assignments with real FKs only when those domain tables exist; no fake inventory/content tables or unchecked scope IDs now. Staff access management may start as audited offline tooling; no operational administration is approved.

## Identity, sessions and recovery

Invite/offline bootstrap only; no first-signup Owner, public registration, anonymous identity, social auto-provisioning, account linking or impersonation. Verify selected-provider hidden/alternate endpoints and normalization behavior, not just navigation.

Mandatory TOTP precedes privileged admission. Enrollment and recovery use purpose-limited state, not an ordinary admin session. A provider's enrolled-factor boolean or cached cookie is not proof of MFA completion. No remembered-device bypass. Recovery/factor/access changes revoke admission and require new verification. Use maintained provider password/encryption primitives and reviewed key rotation; no custom password hashing.

Proposed values (not approved runtime policy):8-hour absolute session,30-minute inactivity,5-minute recent MFA for sensitive changes. Secure HttpOnly host-only SameSite cookies, no authentication localStorage, private/no-store responses and explicit CSRF/origin/callback protections. Session/cache/refresh behavior must be tested against the real selected SDK, not inferred from documentation.

## Database, governance and consistency

Keep the three catalog migrations immutable and public IDs/data/read behavior unchanged. Prefer same isolated database with identity/staff/audit schemas, purpose-specific runtime credentials and offline migration ownership. Schema naming is not privilege separation. Do not reuse the catalog readonly factory for auth writes. New exact-role validators/CLI/test wiring require review and cannot relax host, port or owned-database safeguards. Runtime must not use superuser/bootstrap/migration credentials.

Staff status and authorization version are authoritative. Role/scope/status changes invalidate sessions. Protected writes must revalidate under the same lock protocol used for revocation; a committed write cannot be retroactively revoked.

All Owner-removal/demotion/disable/factor-reset paths serialize governance and preserve at least one eligible, enabled, MFA-enrolled Owner. Pending invitations do not count. Initial bootstrap is offline/serialized. Sole-Owner lost-factor recovery needs a separately approved, audited offline recovery-lock procedure; no public backdoor.

Successful local access changes and their audit insert commit atomically. Provider changes may not share that transaction: keep admission pending and use explicit compensation/outbox/reconciliation rather than claiming distributed atomicity. Failed/denied attempts need bounded redacted logging after rollback. Audit outage blocks privileged changes; no credential/token/MFA/recovery material is logged. Runtime cannot UPDATE/DELETE/TRUNCATE audit evidence.

## Proposed sequence and gates

1. Security ADR, exact-version/advisory review and isolated compatibility spike.
2. Additive identity/staff/audit persistence and purpose-specific privilege/upgrade tests.
3. Controlled provisioning, password/TOTP admission, revocation and recovery.
4. Restricted Vietnamese shell/self-security only.
5. Adversarial, race and storefront regression CI; separate owner acceptance before exposure.

Tests must cover unauthorized/expired/revoked/first-factor-only access; MFA and recovery restrictions/replay; forged roles/custom fields and cross-account requests; hidden registration/linking paths; last-Owner/revocation races; CSRF/redirect/session fixation; audit rollback/redaction/outage; runtime SQL privilege denial; empty replay/upgrade/catalog parity; and existing fixture/database storefront regressions. Keep the two existing CI jobs, add isolated synthetic-identity security checks, never production secrets or auth bypasses.

## Owner decisions still required

Final provider/version and full implementation approval; new purpose credential/bootstrap design; initial Owner count and sole-Owner recovery ceremony; MFA/session/rate thresholds; invitation/email/recovery delivery; audit/privacy retention; and security-management CLI versus UI. Batch3.2A tests may simulate candidate policies but must not silently approve them.
