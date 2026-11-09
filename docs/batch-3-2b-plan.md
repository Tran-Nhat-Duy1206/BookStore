# BookStore — Batch 3.2B Secure Admin Implementation Plan

**Reviewed planning baseline, preserved and sanitized for Batch 3.2B.1.**

The original local plan was located and reviewed at the owner-referenced path. This documentation copy contains no credentials, real staff data or raw test artifacts. The owner has now authorized only Batch 3.2B.1 foundations from main `62a5c9293b5029a1f78937bb4fcd90f09aea92f7`; the later integration/UI/ceremony batches below remain proposals, not permissions. Session/invitation/retention numbers are candidate implementation/test values only. No real identity, invitation delivery, recovery activation, login route, admin UI, business CRUD or deployment is authorized.

## 1. Accepted baseline and merge evidence

- PR #3: https://github.com/Tran-Nhat-Duy1206/BookStore/pull/3 — marked ready, then normally merged on 2026-11-09 at 11:48:30 UTC; no squash, rebase, force push or administrative bypass.
- Reviewed HEAD: `73d588acbe833339f557a8ea90e44189c41243a7`.
- Verified CI: https://github.com/Tran-Nhat-Duy1206/BookStore/actions/runs/42602986438 — all four jobs successful on that exact HEAD. This is not a claim that a separate CI run executed on the merge SHA.
- Final synchronized main: `62a5c9293b5029a1f78937bb4fcd90f09aea92f7`; parents are `ce8165d8f7f8905378b36728e6c07b04ba20d9e9` and the reviewed HEAD. Its tree is identical to the accepted HEAD; local/remote main and clean tracked working tree verified.
- No unexpected commits, conflicts, blocking reviews, review requests or unresolved review threads. Application source, existing catalog migrations/schema/guards and commerce boundary unchanged by PR #3.
- Preserve the accepted exact `@typescript-eslint/typescript-estree@8.72.1>minimatch` override to 11.0.5, its 19 compatibility tests and unsuppressed full audit. Remove/re-review the exception only through a separately validated upstream update.
- Technical baseline: ADR-011 through ADR-014; Better Auth/Prisma adapter 1.7.18, Prisma/client/adapter-pg 7.10.1, pg 8.23.1, Next 16.4.5, Node 24.19.0. Recheck advisories before implementation; do not silently change pins. Promote only the necessary auth packages from dev-only to server runtime dependencies during an approved integration batch, never now.
- The 78 spike tests prove isolated SDK/SQL/in-memory adapter behavior, not a deployed browser, RSC, Server Action, invitation or complete Owner-recovery integration.

## 2. Scope and architecture

A security-only slice of the existing modular monolith:

`Browser / RSC / Route Handler / Server Action -> restricted transport -> live staff admission -> explicit permission/use-case guard -> purpose client -> transaction/audit`

Server-only modules own provider integration, staff admission, permissions, security use cases, persistence and audit. Do not import experimental modules into application runtime or expose ORM/provider objects to components. The public storefront remains unchanged; fixture defaults and explicit database-mode failure behavior remain intact.

**In scope after approval:** staff-only password/TOTP authentication; invitations/offline bootstrap; restricted enrollment/recovery; live session/revocation; six fixed roles; security-only shell; self-security and Owner security control plane; audit and tests.

**Excluded:** customer accounts/public signup/social login/impersonation, catalog/CMS/publishing/inventory/media/business CRUD, commercial features, deployment, production activation, paid infrastructure or unrelated repositories/databases. Reserve future domain permission names only; create no corresponding routes, fake domain tables or mutations.

## 3. Implementation batches and stop gates

| Batch                                             | Deliverables after separate authorization                                                                                                                                                                                                                    | Exit gate                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **3.2B.1 — policy/persistence kernel**            | Ratified decisions; additive identity/staff/audit migrations; exact purpose guards; security state machine; permission registry; governance singleton/backstops; transition/audit consistency contract; disposable tests. No mounted auth route or admin UI. | Empty replay and accepted-main upgrade; catalog parity; real SQL privilege denial; deterministic Owner/revocation races; provider-transaction durable-event feasibility proved. Stop if any design needs broad runtime credentials or an unproven cross-client atomicity assumption. |
| **3.2B.2 — restricted provider/transport**        | Production-shaped server-only integration in local/CI mode; explicit endpoint contracts; password/TOTP, admission/expiry/revoke, cookie/CSRF/origin/rate controls; RSC/Action facade.                                                                        | Real HTTPS browser and direct Action/Route tests; raw provider methods and first-factor-only access cannot bypass admission; no secret/token DTO leakage or cache isolation failure.                                                                                                 |
| **3.2B.3 — controlled provisioning and recovery** | Offline initial Owner ceremony; Owner-only invitations/access control; verified enrollment; backup recovery-only state; approved locked sole-Owner recovery; durable reconciliation.                                                                         | Concurrent redemption and all Owner-eligibility races; crash/rollback/replay tests; independent ownership-proof/operators approved. No recovery-to-admin shortcut.                                                                                                                   |
| **3.2B.4 — Vietnamese security interface**        | Sign-in, enrollment/verification, recovery, admitted shell, own sessions/account security; Owner-only staff-security/audit surfaces. No domain dashboard/CRUD.                                                                                               | Role matrix and accessibility/manual keyboard tests; existing storefront visual/motion regressions unchanged.                                                                                                                                                                        |
| **3.2B.5 — integrated acceptance**                | Full adversarial/fault/concurrency suite, runbooks, key/credential handling and evidence; retain existing gates and add admin integration job(s).                                                                                                            | All required checks and full audit pass or stop for explicit owner disposition; new exact-HEAD review/acceptance. No deployment permission implied.                                                                                                                                  |

**Recommended first authorization: 3.2B.1 only.** The first work should settle the credential/transaction/governance contract, not mount a sign-in form around the spike.

## 4. Authentication and session state machine

States: `invited/pending -> password-proved/enrollment-only -> TOTP-verified -> admitted`; `recovery-only`, `suspended`, `disabled`, `expired/revoked` never carry normal admin admission. Track invitation/bootstrap/recovery lifecycle separately from provider session existence.

- Mandatory password plus actual server-observed TOTP for every normal admission. No remember-device bypass, account linking, public password reset, social/passwordless/magic-link/email-OTP/anonymous method or raw provider registration route.
- Preserve maintained SDK password/encryption primitives; no homemade password hashing or factor cryptography. Recommend password length 15–128 characters, paste/password-manager support and no silent password trimming. Confirm exact SDK Unicode/length behavior in tests.
- Admission binds the same user AND provider session, staff lifecycle, current authorization version, immutable original authentication time and last verified MFA time. Enrolled-factor flags, cookie presence, browser claims and an old provider session are insufficient.
- Store session/admission state in PostgreSQL; cookie cache/secondary storage off. Rotate identifiers at privilege boundaries without restarting the original absolute deadline. No auth localStorage or shared response/data cache.
- Expiry checks run before activity updates. Qualifying authenticated first-party requests may update inactivity monotonically; polling, prefetch, status checks and decorative resources do not keep sessions alive. Never revive an already expired/revoked admission by touching it.
- Role, scope, status, password, factor and recovery changes increment authorization version and invalidate previous admission. Provider revocation is durable/retryable; every protected request still performs live checks, so an outstanding provider token cannot regain admission automatically.
- Recent MFA is user/session/version-bound and written only after actual TOTP verification; it does not reset absolute session age. Sensitive operations additionally confirm the current password where appropriate. Test challenge binding, OTP replay/time-window behavior, clock skew and throttles. Do not infer a cross-challenge replay guarantee from the spike; solve any missing library contract with maintained primitives or stop.
- Backup verification requires the approved primary/challenge context, consumes the code atomically once, revokes prior admission and creates only a short-lived recovery capability. It cannot satisfy recent MFA or authorize shell, staff access, audit, role changes or business operations.
- Admission failure after a successful provider operation remains denied. Remove/reconcile orphan provider sessions; do not mistake compensation for cross-client atomicity. Logout must still clear the client cookie and attempt durable deny-only provider revocation; never falsely promise all-device revocation if persistence is unavailable.

## 5. Restricted transport and Next boundaries

Before coding, produce an endpoint manifest with exact canonical path, method, content type, body schema/size, origin/CSRF rule, purpose-state, permission, rate budget, response DTO and audit event for EVERY operation.

Planned browser operations: POST sign-in, TOTP enrollment/confirmation/verification, step-up, sign-out/session revocation, invitation redemption and backup recovery. GET may render purpose pages or return minimal own-session data; never expose the SDK's generic get-session response/bearer token. Exact URL naming is an implementation detail to approve, not permission for a catch-all.

- No unrestricted Better Auth handler. Dispatch only manifest entries; deny all other signup/linking/disable-factor/reset/update-user/OTP/social/admin/debug endpoints and unsupported GET/HEAD/OPTIONS/method overrides.
- Reject encoded/double-decoded separators, dot segments, alternate slash/case/trailing forms, duplicate/unknown fields and unexpected bodies before dispatch. A hidden alias must not reopen registration or change actor/role/status/MFA/session claims.
- Require exact configured Host/Origin, reviewed same-origin CSRF protection and allowlisted relative post-login destinations. Deny missing/null Origin on browser mutations unless an explicitly reviewed nonbrowser protocol applies. Never trust arbitrary forwarded/IP headers; no wildcard proxy/origin/callback configuration.
- Server Actions are externally callable endpoints, not private functions. Validate input and origin/CSRF, then call the same live guard/use case; client closures and unguessable Action IDs are not authorization. Internal `auth.api` calls do not inherit HTTP CSRF/rate controls.
- RSC/loaders guard before reading private data, independent of layout checks. Private/no-store/no shared tag caching; prevent prefetch/Flight, cross-user cache and error-page leakage. Commit-time authorization is repeated inside sensitive transactions, not reused from a rendered page or request-local memo.
- Cookies: Secure, HttpOnly, host-only, SameSite with reviewed prefix/path rules. Prove actual local/CI HTTPS behavior using a narrowly trusted test certificate/origin; no system-wide trust-root installation, global TLS bypass or silent Secure-cookie weakening. Production TLS/proxy certification remains outside this local-only batch.
- Project minimal DTOs and safe errors. QR/TOTP seed and backup codes may appear only in their explicitly authorized one-time enrollment/security display, never general session/RSC DTOs, logs, traces, URLs or artifacts. Purpose secrets use approved one-time delivery only.

## 6. RBAC and Owner governance

Fixed, versioned roles; explicit permission union, no implicit hierarchy, Owner wildcard or arbitrary permission editor. Unknown actions/roles/fields/scopes deny. Derive actor and resource ownership from trusted records; real object/field scoping must be added with future domain models/FKs, not unchecked generic scope IDs now.

| Role             | Batch 3.2B effective access                                                                                    | Future domain boundary, inert in this batch             |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Owner            | Admitted shell/self-security plus enumerated invite/access/status/recovery-approval/security-audit permissions | Explicit domain grants only when separately implemented |
| CatalogManager   | Admitted shell and own security                                                                                | Catalog metadata                                        |
| Editor           | Admitted shell and own security                                                                                | Own/assigned drafts                                     |
| Publisher        | Admitted shell and own security; no implicit Editor grant                                                      | Approved review/publication scope                       |
| InventoryManager | Admitted shell and own security                                                                                | Assigned locations                                      |
| Analyst          | Admitted shell and own security; no raw staff/security audit/PII                                               | Approved read-only aggregates                           |

Every protected loader, handler, Action and use case enforces permission. Owner-only security management is not catalog/CMS/inventory CRUD. Direct requests by non-Owners and attempts to edit server-owned role/MFA fields fail regardless of hidden UI controls.

**Eligible Owner:** enabled, in an approved normal lifecycle, with genuinely verified enrolled TOTP. An invitation/pending factor does not count; lack of an active login session does not make an Owner ineligible.

- Canonical migration creates a protected governance singleton. Normal bootstrap is serialized and creates one pending Owner only when permitted; normal operation may never transition to zero eligible Owners.
- Backstops must cover local demotion/disable/grant removal AND provider-owned identity deletion/final-factor replacement/reset. UI counts or application-only checks are insufficient.
- Establish and prove a common lock protocol, preferably governance before security rows with deterministic actor/target ordering. Provider statement-level backstops/guarded procedures must acquire the protocol before conflicting row mutations where feasible. Do not hold a staff-connection lock while awaiting a separate provider connection that needs it. Trigger row-lock ordering, cascades, bulk statements, self-target cases and bounded deadlock retries require actual tests.
- For sensitive writes, lock/revalidate actor, target, live provider-session metadata, admission, authorization version and recent MFA at the commit point via narrowly reviewed same-transaction capabilities. Revocation that wins the lock prevents the write; a response/write already committed cannot be retroactively undone.
- If a SECURITY DEFINER backstop is chosen: nonlogin narrow owner, fixed search_path, fully qualified objects, restricted EXECUTE and no generic dynamic SQL or identity-secret reads/staff-write escalation. Direct SQL and provider endpoint bypass tests are mandatory.

## 7. Database and cross-role consistency contract

### Additive persistence

Keep the three accepted catalog migrations immutable. Use ONE canonical additive migration history: proposed next migrations cover identity/provider tables, staff/admission/invitations/governance, and audit/transition/outbox/backstop grants. Validate generated/handwritten SQL against the exact provider version; do not treat experimental SQL as a reviewed application migration.

Models include provider User/Account/Session/Verification/TwoFactor/RateLimit plus StaffPrincipal, fixed RoleGrant/version, same-user/session Admission FK, Invitation, Governance, SecurityEvent and durable transition/outbox processing state. Model no customer/business entities. Server-only client wrappers expose only purpose operations and DTOs; generated model breadth is not a SQL security boundary.

Recommended environment: a NEW marker-owned BookStore admin-development profile, proposed local55436/CI55437 and exact project DB/role naming, only after availability and namespace approval. Replay accepted catalog SQL into disposable full-schema databases. Keep legacy catalog55432/55433 and spike55434/55435 jobs/guards intact; never accept5432, arbitrary host/port/name, or another project's DB. Do not loosen the existing catalog validator to accommodate new users; add separately reviewed exact-purpose factories/wiring.

| Credential purpose           | Allowed authority                                                                                  | Forbidden                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Catalog reader               | SELECT approved public catalog tables                                                              | Writes/identity/staff/audit/DDL/TEMP                                     |
| Auth persistence             | Required provider-table DML only                                                                   | Staff grants, audit editing, catalog access, DDL/role control            |
| Staff/audit service          | Reviewed staff security operations; INSERT/SELECT audit                                            | Provider secrets, catalog writes, audit UPDATE/DELETE/TRUNCATE, DDL      |
| Offline migration/bootstrap  | Separate process; marked DB/schema ownership or narrowly approved role setup                       | Any normal web runtime/env/bundle                                        |
| Optional reconciler sub-role | Proposed narrowly scoped transition metadata/lease/ack capabilities in a separate non-HTTP process | Provider secrets, generic role management, migration/superuser authority |

Runtime LOGIN roles remain NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS/NOINHERIT with no broad memberships/PUBLIC defaults. Validate exact URL/profile plus actual connection attributes/grants before use. Normal runtime must never receive migration/bootstrap URLs. Default public fixture mode remains; explicit database failures never silently substitute fixtures. Do not provision production data/roles or paid services.

### Explicit provider/local transition protocol — blocking B.1 gate

Separate auth and staff clients do NOT share a transaction. A staff-side outbox alone does not cover a process crash after provider commit. For each operation, specify authoritative state, transaction owner, intent/event ID, lock order, admission barrier, audit, retry/compensation and recovery.

Recommended design: a provider-transaction durable transition record (transactional provider integration proved by tests, or narrowly reviewed identity-side DB backstop), followed by idempotent staff/admission/audit processing. Source events are not editable/deletable by ordinary runtime roles. Grant a separate minimal reconciler capability if needed; never solve this with migration credentials or generic cross-schema writes. Lease/ack and processed-ID semantics must survive crashes and out-of-order commits; do not use a naive maximum sequence-ID watermark that can miss late commits.

Staff-side change + authorization version + successful audit + outbox commit together. Provider factor/credential/session effects finalize only through the defined protocol; pending/inconsistent/recovery state denies admission. Idempotent reconciliation must never automatically promote an unapproved identity. If durable provider-side evidence or Owner-safe ordering cannot be achieved, STOP before endpoint/UI work rather than inventing atomicity.

## 8. Provisioning, invitation and recovery ceremonies

**Initial Owner:** explicit offline command, separate env/process and narrowly approved authority; no first-web-user rule, universal seed password or public bootstrap. Owner supplies the actual initial identity through an approved channel. Library-supported password setup plus verified TOTP completes the pending bootstrap before normal admission; initial normal state has exactly one eligible Owner. Local/CI use only synthetic identities.

**Invitation:** Owner permission plus recent MFA; token is at least256 random bits, stored protected/hashed, bound to normalized identity AND immutable server grant/version, single-use CAS, expires after24h. Grant/identity changes revoke/reissue. Concurrent redemption has one winner; abandoned/partial enrollment expires without active staff. Use maintained provider credential APIs in a private, narrowly gated provisioner; a permissive provider instance must never be mounted and migration credentials never serve normal redemption.

For local development recommend an explicit protected ignored-file/manual handoff to a separately verified recipient; no SMTP purchase/provisioning or claim that a mailbox was verified merely by reading a file. Real delivery, ownership verification, operators and channel remain owner decisions. Avoid capability tokens in query logs/history/Referer; approve an isolated one-time redemption transport (for example fragment-to-POST with immediate history cleanup, no trackers and no-referrer) and test leaks/races.

**Backup recovery:** password/challenge plus atomic one-use backup code only establishes recovery state; zero administrative powers. Revoke old admission, require verified replacement TOTP, invalidate old factors/codes/sessions and issue normal admission only through a fresh approved login. A backup code never satisfies step-up.

**Sole-Owner loss:** externally verified owner proof and named operator approval, then an explicit governance recovery lock; revoke previous access, issue a purpose-only capability (recommended15m), verify replacement factor and restore invariants before unlocking. Failure stays locked. The normal web API cannot disable the last factor, promote a recovery session, approve its own independent proof or exercise a general zero-Owner bypass. Password/key loss and restore procedures need defined separate handling; do not promise recovery without available independent evidence/keys.

## 9. Recommended policy register — ALL require owner approval

| Decision              | Concrete recommendation                                                                                                                         | Approval dependency                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Passwords             | SDK-managed hashing;15–128 characters; no default/reused seeded password, paste/managers supported                                              | Exact SDK limits, ownership/reset ceremony                                       |
| Absolute session      | 8h from original successful password+TOTP admission; rotation/refresh never extends it                                                          | Owner confirms value and reauthentication UX                                     |
| Inactivity            | 30m; server-time monotonic qualifying activity only; exclude prefetch/polling                                                                   | Qualifying request definition and user warning                                   |
| Recent MFA            | 5m; actual TOTP bound to user/session/version for password/factor/access/invite/recovery/audit-export changes                                   | Sensitive-operation list; no backup substitution                                 |
| Owner bootstrap       | One initial eligible Owner; pending bootstrap locked; no second staff invented                                                                  | Actual identity, count and independent proof                                     |
| Sole-Owner recovery   | Named independent verifier/operator; approved proof; recovery lock;15m one-time capability; verified replacement before unlock                  | Proof/channel, operator authority and evidence retention are blockers            |
| Invitations           | 24h,256-bit protected single-use token; bound identity/grant; local protected-file handoff only for dev                                         | Real channel and identity verification must be chosen before real staff          |
| Password abuse        | Start5failed/15m/account +20attempts/15m/trusted IP; generic responses and progressive cooldown, no permanent lockout                           | Normalize counters; lockout-DoS/reset behavior; tune after tests                 |
| MFA abuse             | Native3attempts/10s/challenge-path plus10failed/15m/account across IPs/challenges;15m cooldown; successful full MFA resets consecutive failures | Combined atomic store, cumulative/consecutive semantics, trusted clock/IP        |
| Recovery/invite abuse | 5failed/hour/capability or identity +30/hour/trusted IP; bound challenge and generic errors                                                     | Shared budgets; saturation/outage behavior                                       |
| Audit retention       | 365days minimal structured security events; raw IP at most30days if truly necessary; prefer protected/rotating-key pseudonyms                   | Privacy/legal review, deletion/archive authority and recovery-evidence retention |
| Local HTTPS/keys      | Dedicated loopback origin, per-test cert trust; separate ignored development keys, reviewed rotation; never downgrade Secure silently           | Exact host/ports/cert/key custody and rollback/restore drill                     |

Apply budgets atomically across workers and across password/MFA/enrollment/recovery entry points; do not trust browser IP headers. Throttle before expensive password work while preserving anti-enumeration. Rate-store failure denies affected flows with503; no per-process or in-memory success fallback. Full authenticated success, not password success alone, resets MFA failure state.

## 10. Audit integrity and failure behavior

Log minimal event ID, actor/target opaque identifiers, action, outcome, trusted timestamp, safe reason and request correlation. No passwords/hashes, bearer/session/challenge tokens, TOTP seeds/QR URIs/codes, backup codes, invitation/recovery capabilities, connection strings or raw provider payloads.

Successful local security mutations and audit append are atomic. Runtime cannot UPDATE/DELETE/TRUNCATE security evidence; offline DB-owner tampering is not claimed impossible. Provider effects require the transition protocol above. Denied/failed/rolled-back attempts go to a separately durable, bounded redacted sink, not a successful event inside a doomed transaction. Define saturation/outage behavior: fail closed for privilege-raising operations, safe503/operational signal, no silent evidence loss or unbounded queue. A deny-only logout/revoke path must not require granting access just to record failure.

Retention/purge is a separately approved offline role/procedure, never an ordinary web delete. Test expiry/archives, redaction and complete credential-free restore evidence on disposable fixtures before any operational claims.

## 11. Planned Vietnamese interface — no installed routes

- `/admin/sign-in`: “Đăng nhập”; proper username/current-password autocomplete, password-manager/paste support, show/hide control, non-enumerating errors.
- Enrollment/verification pages: “Thiết lập xác thực hai bước” / “Xác thực hai bước”; textual alternative to QR, OTP paste/autofill and leading-zero-safe input; one-time backup-code display with clear storage guidance; no automatic admin access before completion.
- Invitation/recovery pages: isolated purpose flows, explicit “chỉ khôi phục” state; no privileged navigation or general session/token DTO.
- `/admin`: restricted security-only shell showing own identity/role/security state, not fake business metrics.
- Account/session security: own session list/revoke, reviewed password/factor changes and step-up.
- Owner-only security control plane: invitations/access status/roles and safe audit view. Do not add catalog/CMS/inventory navigation or CRUD.

Reuse existing cream/brown/amber semantic tokens, Lora headings, Be Vietnam Pro controls, Lucide/Radix patterns and motion timings. No public-theme/global CSS replacement. Vietnamese labels/errors; keyboard-visible focus, linked error summary/inline errors, live status, labelled fields and focus restoration. Allow assisted authentication/paste rather than cognitive puzzles. Target WCAG2.2AA, measured contrast,44px recommended web touch targets,320px reflow/zoom, portrait/landscape and reduced-motion operation; test rather than claim compliance. No secret copying into logs/analytics or movement required to complete authentication.

## 12. Security acceptance matrix

- **Admission:** unauthenticated, wrong password, first-factor-only, unapproved, incomplete enrollment, disabled/suspended/revoked/expired/stale-version sessions denied at page/data/handler/Action/use-case boundaries. Test expiry before touch, absolute cap through rotation, cross-tab/logout and stale-cookie replay.
- **MFA/recovery:** actual browser enrollment/TOTP/step-up, wrong/replayed/challenge-swapped codes, trusted-device bypass attempts, concurrent backup reuse, recovery TTL/zero-admin restrictions, factor replacement and old-code/session rejection. Real independent sole-Owner recovery evidence remains a release blocker until approved.
- **RBAC:** six-role/action matrix; explicit Owner list/no wildcard; forged client role/status/actor/scope fields, cross-account session access and unknown actions deny. All domain write endpoints absent for every role, including Owner.
- **Transport:** foreign/missing/null origins, CSRF, redirect/Host/proxy spoofing, malformed/encoded path aliases, unexpected methods/content/duplicate fields, hidden provider endpoints and direct Action invocation. Actual HTTPS Secure/HttpOnly/SameSite behavior, no token/seed/provider-object leakage through HTML/Flight/JSON/errors/logs/artifacts.
- **Races:** real PG connections with deterministic barriers, not sleeps: two Owners concurrently demoted/disabled/reset/deleted; role grant/removal vs actor/target revoke; session expiry/revoke vs protected security write; same invite redeemed twice; provider final-factor mutation vs Owner change; self-target and bulk/cascade paths. Verify invariant/linearization, bounded retries and no cross-connection self-deadlock.
- **Consistency/faults:** kill process after provider commit, before/after ledger/local audit/outbox/ack; duplicate/out-of-order delivery; audit insertion rollback, unavailable/saturated denial sink, unavailable rate store, source failure, restore/key/factor failures. Pending states deny; exactly-once business effect through idempotence, not a claim of distributed atomicity.
- **SQL/migrations:** pristine replay and accepted-main seeded upgrade, migration no-op, immutable catalog SQL/public DTO/ID/slug parity; all role denies including readonly-off writes, role membership/DDL/TEMP/identity-secret/audit-edit access; protected governance/transition ledger and SECURITY DEFINER bypass tests; no migration/bootstrap env in runtime/bundles.
- **UI/regression:** Vietnamese auth/security pages, keyboard/screen-reader/error/focus/OTP paste/reduced motion/zoom checks; existing storefront fonts/assets/animations/local collections and fixture/database regressions unchanged.
- **CI:** preserve the existing frontend, PostgreSQL catalog,78-test isolated auth spike and unfiltered full dependency audit jobs. Retain19 lint/override compatibility tests. Add disposable admin-security browser/RSC/Action/race job(s) without replacing these gates; synthetic identities/keys only, marked DBs, scoped cleanup, no production secrets or paid service. Verify actual exact-final-HEAD results and retained evidence for every implementation PR.

## 13. Approval and unresolved risk register

Before authorizing B.1: approve the canonical migration/credential/transition/governance design, exact dedicated profile namespace/ports, password/session/abuse policy recommendations and explicit implementation branch/scope. Before ceremonies: approve initial Owner identity, independent proof/operator authority, delivery and recovery channels. Before integration acceptance: approve local HTTPS/key custody, denial-sink saturation/retention/privacy and the final sensitive-operation matrix.

The library's full browser/RSC/Action integration, TOTP replay semantics, provider-side durable transition contract and Owner-safe mutation ordering are not certified by the spike. Each has a blocking test/design gate; failure is STOP/NO-GO, not a reason to bypass controls. TOTP remains phishable. The accepted minimatch compatibility exception and ESLint9 support debt remain maintenance constraints, not permission for unrelated upgrades or audit suppression.

**Current authorization is B.1 foundations only. Its implemented contract and evidence are documented separately in ADR-015 and the B.1 validation report. B.2–B.5, real staff activation, deployment, commerce and business CRUD remain unapproved. STOP after B.1 with an unmerged Draft PR.**
