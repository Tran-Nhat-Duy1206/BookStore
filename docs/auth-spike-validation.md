# Batch 3.2A — Authentication compatibility/security spike evidence

## Scope and provenance

Baseline main `ce8165d8f7f8905378b36728e6c07b04ba20d9e9`; branch `feat/phase3-b2a-auth-spike`. Only isolated, non-production Better Auth evaluation is authorized. Final commit, Draft PR and exact-HEAD CI run are recorded in the final PR acceptance comment; workflow configuration alone does not establish CI success.

All executable experiments are under [auth-spike](../experiments/auth-spike/README.md). There is no authentication HTTP listener, Next auth route, admin application, customer identity or operational mutation. Application source, three catalog migrations/schema, original scripts/tests and Vietnamese UI/CSS/motion are unchanged. Grep found no experimental/provider imports in source or the built browser chunks; no application route handlers exist. Default fixture behavior is preserved.

## Exact versions and compatibility

| Component | Version/evidence |
|---|---|
| Better Auth / Prisma adapter | **1.7.18 /1.7.18**, stable release and matching peer ranges |
| OTP/Base32 test utility | **@better-auth/utils0.5.1**, maintained library utility, no homemade crypto |
| Prisma / client / adapter-pg | Existing **7.10.1**, separate generated experimental client |
| pg / PostgreSQL | Existing **8.23.1** / native18 locally; CI image18.3-alpine configured |
| Next / React / TypeScript | Existing **16.4.5 /19.3.1 /6.0.3** |
| Node / pnpm | **24.19.0 /11.7.0** |

Dependencies are dev-only. Real Prisma queries, password/factor operations and the real Next adapter execute against PostgreSQL; no mocked auth backend. The adapter is exercised with in-memory Request/Response objects at a non-resolving `.invalid` origin. No actual Next RSC/server-action/browser login flow was mounted; that compatibility remains a full-implementation test gate. Peer compatibility is not substituted for the tests.

## Isolation and privilege proof

Created a brand-new marker-owned native cluster at the ignored BookStore auth-spike directory on checked-free127.0.0.1:55434. Did not reuse the existing5432 service or accepted catalog cluster for experiments. CI uses another disposable service on55435. Each run creates one fresh marked database and four random marked LOGIN roles; cleanup never uses FORCE, global resets or connection termination.

- **Reader:** actual public catalog SELECT and exact DTO parity; no identity/staff access or writes/DDL. Turning transaction-readonly off still cannot bypass SQL grants.
- **Auth:** identity DML only; cannot modify staff roles, append audit, read catalog or perform DDL.
- **Staff/audit:** staff DML plus audit INSERT/SELECT; cannot read provider sessions/secrets, write catalog, mutate/truncate audit or perform DDL.
- **Migration:** owns only the disposable database/schema, separate from runtime. Bootstrap alone creates/drops run-owned databases/roles on the fresh experimental instance.
- Runtime-role attribute and membership queries prove no superuser/createdb/createrole/bypassrls/inherit or role memberships.

The test orchestrator necessarily holds offline bootstrap/migration credentials; the runtime-like clients use only their validated limited roles. This does not prove process-secret isolation in a deployed application. Full runtime must run with only purpose credentials and reject bootstrap/migration/superuser inputs. Existing catalog URL guard/factory are unchanged; replacement credential/CLI/test wiring needs separate approved implementation.

After final local spike tests, bootstrap queries confirmed **0 remaining disposable databases and0 generated purpose roles**. The owned spike cluster and catalog regression cluster were stopped using their scoped helpers. Only the pre-existing5432 service remained listening; this work did not connect to or modify it.

## Actual local validation

| Check | Actual result |
|---|---|
| Frozen install / generated clients / exact peer check | PASS |
| Independent spike TypeScript check | PASS |
| Real-library/security/database spike | **78/78 PASS**, no skips |
| Application TypeScript / ESLint | PASS |
| Existing unit suite | **69/69 PASS** |
| Existing catalog PostgreSQL integration | **44/44 PASS**, empty replay/no-op and seeded upgrade retained |
| Production build | PASS |
| Fixture-mode complete browser suite, catalog DB stopped | **56 PASS,6 intentional pointer/project SKIP** |
| Database-mode complete browser suite | **56 PASS,6 intentional pointer/project SKIP** |
| Existing missing-DB/invalid-source HTTP probes | PASS:500, no fixture fallback/response credential leakage |
| Independent static source review | No concrete actionable in-scope findings; not runtime/security certification |
| Production-only dependency audit | No known vulnerabilities reported |
| **Full dev+runtime dependency audit** | **NONZERO1: one open moderate baseline minimatch finding**, zero high/critical; not waived |

Same62 browser project cases run twice in different modes; not124 unique scenarios. Test assertions were not weakened and existing tests were not edited. Local XML lives in ignored auth-spike-test-results; CI retains independent JUnit evidence for7days. Original mode-specific CI screenshot/report artifacts remain. CI has four checks: existing frontend/catalog jobs, isolated SDK/security tests, and a separate full-graph audit. The audit check has no suppression/continue-on-error and retains actual nonzero findings; passing tests must not be presented as an all-green pipeline or audit clearance.

## Demonstrated authentication/security behavior

- Maintained-library password hashing/authentication; wrong-password and forged-cookie rejection.
- TOTP enrollment/verification against the real SDK; first-factor-only, unapproved identity and provider-only MFA sessions never imply staff admission.
- Explicit encrypted TOTP/backup storage; secret values absent from the minimal audit DTO.
- Live suspended/disabled staff and stale authorization versions denied even while provider session remains valid.
- Real sign-out revocation rejects old-cookie replay; expired database session is rejected.
- Proposed8h library expiry without sliding refresh, and simulated30m inactivity/5m recent-MFA checks. These are candidate fixture values, NOT approved application policy.
- Sequential and concurrent backup-code reuse denied: only one independent concurrent challenge consumes a code. The application admission proof confines backup verification to recovery state and invalidates old admission; no recovery-to-admin shortcut.
- Trusted-device TTL0: even manual replay of the returned expired cookie still requires a new TOTP challenge.
- Registration, double-slash aliases and unintended social/magic-link/OTP/anonymous/link/disable-factor/admin/generate-secret paths rejected without creating users.
- Foreign-origin handler rejection, enabled PostgreSQL rate-budget concurrency bound and failed-MFA account lockout across fresh challenges/IPs.
- Audit INSERT failure rolls back admission. A provider session may already exist, but cannot authorize staff access. Closed staff persistence returns sanitized503/deny; no fixture/role fallback.
- Cross-account admission association rejected by a composite FK. Raw provider get-session JSON contains a bearer token; the minimal admission result does not. Therefore exposing a generic raw handler is NOT acceptable future BFF design.

## Findings discovered and resolved in the harness

Initial run:54passed/17failed. Better Auth defaults origin checking off in test mode; the spike now explicitly sets origin/CSRF checks on, and retains strict foreign-origin rejection. Missing trusted-IP metadata placed independent synthetic clients in one shared per-path limiter bucket; distinct fixture-only IP metadata now models clients while concurrent-budget tests prove limits remain enabled. Two SQL denial checks referenced a nonexistent Product.title; corrected to the actual merchandisingTitle column while retaining SQLSTATE42501 assertions. No security test was removed/relaxed.

Later strengthened runs passed76 then78cases, adding actual handler rate concurrency/account lockout, raw-token DTO projection, unavailable-staff persistence, concurrent backup consumption and trusted-device replay checks. Synthetic IP headers are not a production proxy trust solution. Direct auth.api functions bypass HTTP origin/CSRF/rate controls; they are used only for offline setup or private session lookup in this harness, never as an exposed BFF boundary.

## Advisories and residual risks

[Official advisory inventory](./auth-spike-advisories.md):50 unique IDs across global/publisher queries,49 nonwithdrawn, including publisher-only recent cache/revocation findings and conflicting metadata. Core1.7.18 lies outside listed affected ranges. Unused sibling plugins and unknown vulnerabilities are not declared safe by inference.

[Full audit snapshot](../experiments/auth-spike/evidence/dependency-audit.json): GHSA-g3hv-75wg-m249/CVE-2026-118764, minimatch10.2.6 in dev lint tooling, affected>=7,<11.0.1. Baseline lockfile contained the same version. Do not hide this with a prod-only scan or blind cross-major override11. Remediation or explicit bounded-development risk disposition requires owner review. Existing ESLint9 compatibility debt and pg8 query-queue deprecation remain documented; no warnings were suppressed for green tests.

Full BFF path/method/CSRF/redirect/rate/cookie projection, actual browser/RSC/server-action behavior, invitation/email ownership and delivery, full single-/last-Owner concurrency/recovery, complete role/object authorization, revocation-versus-write races, durable failure logging/outbox, key rotation, operational credentials, backups and deployment are NOT implemented or certified. No real identity, mail service, production/cloud credential or paid resource was provisioned.

## Security decisions and recommendation

- [ADR-011](./adr-011-authentication-spike-provider.md): provider/exact versions/evaluation scope.
- [ADR-012](./adr-012-staff-session-and-mfa.md): session/MFA/admission and candidate values.
- [ADR-013](./adr-013-staff-bootstrap-and-owner-recovery.md): closed provisioning, initial single Owner, offline recovery-lock procedure.
- [ADR-014](./adr-014-auth-privileges-rbac-and-audit.md): exact purpose privileges, RBAC boundary and audit/revocation transactions.

**GO for Better Auth1.7.18 + Prisma7 provider fit and review of this isolated spike evidence. NO-GO for unconditional full Batch3.2 implementation while the full audit is nonzero and ADR/policy/recovery/credential decisions remain unapproved. Any later development requires separate owner authorization and reviewed remediation/disposition of the open audit finding; this spike does not waive the failing check. NO-GO for operational/production authentication activation.**

Leave the PR Draft/unmerged. Do not proceed to full authentication, Batch3.3 CRUD, commerce or deployment.
