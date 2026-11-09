# Batch 3.2B.1 — Security foundation validation

## Scope and provenance

Owner-authorized branch `feat/phase3-b2b1-security-foundation`, based on verified/fetched main `62a5c9293b5029a1f78937bb4fcd90f09aea92f7` in the official repository. The local full plan was found, reviewed and preserved as a [sanitized planning baseline](./batch-3-2b-plan.md). [ADR-015](./adr-015-security-foundation.md) records the implemented foundation contract, trust boundaries and deferred approvals.

No HTTP authentication route, browser MFA/login page, actual Owner/staff/customer account, operational bootstrap/recovery/invitation, business CRUD, commerce, production database/service, paid infrastructure or deployment is introduced. Keep the implementation PR Draft and unmerged; this does not complete Batch3.2B.

## Implemented persistence and authority

- [004 identity](../prisma/migrations/004_security_identity/migration.sql) and [005 foundation](../prisma/migrations/005_security_foundation/migration.sql) extend the sole application SQL history. All three accepted catalog migrations and public model/IDs/DTOs remain unchanged.
- Six pinned provider models, staff status/v1 role bindings/versioning, same-user/session admission, dormant governance singleton, redacted append-only success/denial facts and bounded source transition processing.
- Five separate LOGIN purposes plus a NOLOGIN definer owner, no memberships or runtime superuser/migration/DDL/TEMP authority. Auth cannot grant staff access; staff/worker cannot read credential/token/factor tables; reader cannot write with read-only disabled.
- Server-only deny-default kernel; explicit six-role permissions, no wildcard/inheritance, future domain grants inactive. Actual provider session resolution is deliberately absent/default-null, and no runtime capability writes verified admission.
- Statement-level governance serialization and READ COMMITTED-only security contract; last eligible Owner backstops also cover provider deletion, final-factor/credential changes and cascades. Initialization/recovery is not activated.
- Atomic local security state/success audit; provider-side transactional transition evidence followed by separate idempotent fail-closed reconciliation. Pending/blocked effects never automatically create privileged admission.

## Actual local validation

The final serial full local rerun completed successfully after all source-review fixes. The table records that rerun, not earlier partial results; exact-HEAD CI remains a separate gate. Windows, Node24.19.0, pnpm11.7.0, installed native PostgreSQL18. New foundation cluster is marker-owned loopback55436; catalog55432 and accepted spike55434 are started only by their original owned helpers for regression and stopped afterward. Existing5432 is neither connected to nor modified/stopped. Synthetic `example.invalid` data lives only in disposable run-owned databases; no real identities or operational keys are seeded.

| Check                                                | Actual result so far                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Frozen dependency installation                       | PASS; unchanged dependency lock/pins                                                                     |
| Application TypeScript / ESLint                      | PASS                                                                                                     |
| Unit suite                                           | 153/153PASS, including65new permission cases and19preserved minimatch/plugin compatibility cases         |
| Foundation SQL/security                              | **184/184PASS**, no skips, after isolation/time/fsync fixes                                              |
| Catalog migration/integration                        | **44/44PASS**; fresh replay/seeded upgrade and all original DTO/identity checks retained                 |
| Independent auth-spike TypeScript /78security cases  | PASS; **78/78PASS**, unchanged experimental source/assertions                                            |
| Production build                                     | PASS; original public route set, no authentication/admin route                                           |
| Full fixture-mode browser suite                      | **56PASS,6existing project/pointer SKIP**                                                                |
| Full database-mode browser suite                     | **56PASS,6existing project/pointer SKIP**                                                                |
| Missing-database/invalid-source HTTP probes          | PASS;500without fixture fallback or response credential leakage; owned servers stopped                   |
| Unfiltered full development+runtime dependency audit | EXIT0; all five vulnerability severities0across687dependencies; no suppression or production-only filter |
| Exact-final-HEAD GitHub CI                           | Pending Draft PR/push; all four old jobs preserved plus isolated foundation job                          |

Final source SHA, Draft PR and exact-HEAD Actions run/job results will be recorded in the final PR verification comment. Local execution and workflow text alone are never substituted for that evidence.

## Security evidence coverage

The [foundation cases](../tests/security-foundation/security.test.ts) and [SQL privilege/cleanup cases](../tests/security-foundation/privileges.test.ts) exercise pristine replay/idempotence, accepted-main seeded upgrade, full catalog DTO parity under the actual reader role, all purpose SQL grants/denials, definer owner/search_path/PUBLIC restrictions, admission composite ownership, role/status/version matrix, no operational Owner seed, invalid governance/recovery transitions, password-only actual provider-adapter denial, immutable audit privileges, redaction, audit rollback and outage fallback, bounded queue/five-attempt blocking and replay idempotence.

Deterministic real-connection races observe actual PostgreSQL lock barriers: simultaneous Owner self-disables/role removal, provider factor loss versus staff disable, provider revocation winning before a write and a committed write preceding later revocation. Two stale repeatable-read Owner snapshots and unsupported isolation levels are rejected, not assumed fresh. Four precise deadline barriers cross provider, absolute, idle and recent-MFA expiry while blocked on governance; checks must use time after the wait. No retry/sleep/skip is used to conceal a race. Explicit pg_sleep_until waits only for the tested server deadline.

The maintained provider SDK/adapter is exercised against the new canonical generated model in a never-mounted synthetic fixture. Verified admission and Owner fixtures are explicitly migration-only structural states; they do NOT certify actual MFA-to-admission binding, browser cookies, RSC or Server Actions.

## Review findings and failures retained

- Initial test TypeScript errors used the wrong repository factory shape and widened malicious-payload literals; corrected before execution, not excluded.
- First expanded foundation run passed174cases. Independent source review then found stale REPEATABLE READ snapshots, statement-start expiry after lock waits and missing POSIX parent-directory fsync. Explicit isolation rejection, post-lock wall-clock capture and regressions fixed the SQL issues.
- A host/session runtime resume left the owned foundation cluster stopped. The next184cases did not execute because bootstrap failed; they were not counted as passing/skipped acceptance. Scoped status verified the stopped instance; only its marked helper restarted it, then184/184ran successfully.
- The first full catalog regression returned43/44 because one legacy upgrade assertion still expected exactly3migrations. It now expects all5canonical migrations while retaining every original DTO/UUID/public-ID preservation assertion; no test was removed or loosened to ignore extra history.
- A follow-up source review found the concurrent spool initializer could skip parent fsync. All appenders now sync the validated marker and directory chain, including existing roots; partial/invalid journals are rejected without repair. The final serial full rerun passed after this refinement. Final independent baseline/source review reported no actionable B.1 P1/P2 findings; it did not execute tests.
- Existing pg8 query-queue deprecation remains visible; no warning/audit suppression added. Source review is not an independent execution or production certification.

## Guarantees, limitations and acceptance gates

Success audit and local changes share one SQL transaction. Source provider commit and local reconciliation do not: a committed provider effect can remain pending, with privileged access denied. Reconciliation never grants roles/admission and cannot silently abandon failed events. Capacity1000pending/blocked records,100IDs/call and5recorded failures are foundation bounds, not approved production sizing. Worker scheduling/monitoring, offline incident resolution and retention/purge are not activated.

Success/denial evidence is runtime append-only, not immutable against an offline database owner. Denial outcomes distinguish denial, confirmed rollback and ambiguous/unavailable completion. The optional fixed owned1MiB journal uses redaction, exclusive locking, bounded validation and fsync. Both sinks unavailable means503 plus a latched operational failure, not silent durability or authorization fallback. Stale locks/corrupt/full journals require approved operator handling. Windows ACL/directory-sync/power-loss guarantees and malicious same-OS-user resistance are not claimed.

Existing catalog URL guard/client/demo wiring is intentionally unchanged. The ordinary storefront remains fixture-backed without DB credentials; new foundation profiles never accept legacy bootstrap URLs. This is not a production or operational reader/auth credential cutover. Real SDK resolution, observed-MFA writer, restricted transport, browser/RSC/Action cookies/CSRF/origin/rate controls, full invitation and sole-Owner recovery, keys/restore and privacy/retention remain later separately approved gates.

Owner decisions remain: actual initial identity and independent proof, operators/approvals, recovery/key custody, real delivery, final policy values and privacy/retention.8h/30m/5m,24h invitation and365d retention are candidate values only. No customer authentication or business endpoints become active.

The same62browser project cases ran in each data-source mode, not124unique scenarios. Only the six pre-existing project/pointer skips remain; no new skip/retry or UI workaround was introduced. Original styling/fonts/motion and storefront source are unchanged. Owned catalog/spike clusters were stopped in the full-run finally block; the foundation helper is stopped separately after final inspection.

**Local decision: GO for B.1 owner review only, conditional on all five exact-final-HEAD CI jobs passing. This is not acceptance of full Batch3.2B, authentication integration or production activation. Stop after B.1; keep the PR Draft and unmerged.**
