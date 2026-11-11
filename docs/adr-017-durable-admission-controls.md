# ADR-017 — Gated dormant durable admission controls

Status: **DORMANT IMPLEMENTATION DESIGN GATE PASSED before migration006 was written.** Owner authorizes B.2b only, after accepted PR#5 normal merge at `8458fdf5f9286de829aeac7e296eccf1bebd9c52`; branch `feat/phase3-b2b2b-admission-controls`. Reviewed feature `d81b866e39b50a2ff0b7cca91ea904555da3ec1d`, exact six-job CI42750018906 all successful, reviews/threads/conflicts clear and merge tree identical. This ADR must reach a recorded technical gate decision before security migrations are written. It is not approval for operational authentication or B.2c.

## 1. Evidence and scope

Read ADR-011–016, the [preserved B.2 plan](./batch-3-2b2-plan.md), actual [B.2a factory](../src/server/security/provider-proof.ts), [non-authorizing comparison](../src/server/security/provider-proof-contract.ts), [B.2a evidence](./batch-3-2b2a-validation.md), canonical005 and actual privilege hardener. Graph tooling is unavailable; bounded source fallback only, no graph coverage/completeness claim.

B.2a proved a PRIVATE maintained-library TOTP operation boundary: fixed native verify-totp path, real SDK verification, full operation completion, actual effective cookies rather than stale JSON token, same user/session association and independent committed-row visibility. It does not provide a native matched-counter result, durable MFA receipt, global replay authority or endpoint-wide transaction. WeakMaps, structural metadata matching, factors/flags, stored session cookies and callback payloads remain NOT proof authority.

B.2b may add only dormant protected SQL/server-only controls and synthetic tests. Keep the normal kernel resolver null and all application callers unconnected. No auth HTTP, login/MFA UI, real staff/Owner identity, bootstrap/invitation/enrollment/recovery activation, business/customer/commerce CRUD, deployment or paid infrastructure. Preserve all six existing CI jobs and all accepted mechanisms; add a seventh B.2b test gate. Better Auth/adapter1.7.18 remain dev-only; no experimental imports or custom password/TOTP/session engine.

## 2. Selected authority and threat boundary

**Proposed selection: a distinct exact-purpose VERIFIER SQL credential**, not a general claims signer or broad table writer. A fixed private server-only integration owns it and the actual maintained SDK calls. SQL EXECUTE privilege authenticates this positive issuer; HMAC is used for protected fingerprints/replay, NOT as an independent cryptographic proof that the issuer executed SDK code.

- AUTH: existing provider CRUD only. No proof/control/admission/approval DML or issuer/finalizer EXECUTE.
- VERIFIER: exact reviewed prepare/bind/reserve/issue/resume/clock functions only; no provider CRUD, private table/key reads, approval/grant/governance/admission DML or arbitrary signature/hash oracle.
- STAFF: existing safe reads and reviewed guards plus proof-consuming finalizer/touch. No proof/challenge/replay/key/approval SELECT (including column grants), no issuer EXECUTE or generic admission INSERT.
- WORKER: deny-only bounded reconciliation/orphan/expiry functions. No proof issue/finalization or approval authority; no raw provider secrets/DML.
- NOLOGIN guard: reviewed definer owner, fixed pg_catalog search_path, fully qualified objects, no runtime membership/login. Owner privileges inherently include object DDL; the guarantee is no runtime login/membership/reachable dynamic-DDL capability, not that an object owner somehow lacks ownership.
- Offline migration/bootstrap: only owned disposable provisioning/hardening, never app runtime. All new PUBLIC/default function/table rights revoked. Exact new bf_<12hex>_verifier profile is justified solely as the positive issuer; no relaxed existing URL guards.

Verifier compromise can forge evidence through its reviewed authority. Same-process possession of AUTH/STAFF/VERIFIER is NOT process isolation against full server compromise. No client can select provider/hook/issuer identity or submit a claimed verified flag. Future transport must independently derive the actor from the SDK; shared SQL STAFF credentials alone do not prove end-user cookie possession.

### Independently approved credential/factor generation

AUTH can change password/factor ciphertext and flags. A current-state HMAC alone cannot prevent poisoned credentials followed by an honest fresh ceremony. Therefore require an **empty-by-default private approved-generation table**, populated only by offline migration-owner synthetic fixtures in B.2b; no runtime approve/re-pin function or bootstrap tool.

Each approval has an immutable random generation ID and a monotone retired flag. A guard-owned provider critical-change trigger retires the current generation in the SAME provider transaction on every actual relevant field mutation/deletion, and revokes its pending challenges/evidence/control epochs. Restoring the prior ciphertext/hash bytes NEVER reactivates it (ABA rejection). Only an explicit offline fixture re-pin may create a NEW generation ID; old prepared evidence still cannot match it. Runtime gets no unretire/reset/re-pin capability.

Its pinned security snapshot covers canonical user identity/email verification/TOTP enablement, credential account IDs/hash and factor IDs/encrypted secret/encrypted backups/verified state in canonical order. Transient failure counters/locks are excluded so normal SDK accounting does not change the generation. All normal new controls require current snapshot == independently pinned snapshot == challenge original snapshot. Any credential/factor mutation stays ineligible even after source reconciliation until a separately approved future ceremony re-approves it. VERIFIER/STAFF/AUTH/WORKER cannot re-pin. Restoring approved data does not reset replay burns or revive retired session IDs. No actual identity is seeded.

## 3. Durable state machine and short transactions

Every entrypoint requires READ COMMITTED and governance FIRST, then fixed sorted budget keys, challenge, replay, evidence/control rows. Capture fresh database wall time AFTER waits. Never hold these locks/connections while invoking the separate SDK auth client, reconciling or writing a separate denial sink.

State transitions (each CAS and immutable original bindings):

1. **prepared-before-password**: database derives intended user, active staff/roles/governance, pinned security generation, authz/permission versions, server DB authentication origin/deadline and password account/IP charge. Caller timestamps/IDs/flags are not authority. No privilege.
2. **primary-bound**: prepared-before-password and primary-bound share an immutable **120second primary deadline measured from DB prepassword start**, checked after each wait in bind/resume/reserve. The later MFA/finalization deadline is the EARLIER of that original primary deadline and reservation+30seconds; holding an SDK cookie never extends primary freshness. These are dormant synthetic candidate values, not approved live policy. Only after the private actual SDK password call succeeds, bind that exact canonical signed challenge-cookie credential to the prepared row. Compare original snapshot/version, never refresh it. An independently created session/cookie or a different challenge cannot substitute.
3. **mfa-reserved/inflight**: atomically claim the challenge ONCE, reserve global user/code HMAC and charge shared MFA account/IP budget. Commit BEFORE SDK verification. An opaque server operation capability owns that one invocation; no lease takeover, SDK retry or resume of inflight state. No privilege.
4. **ready**: only the fixed private actual SDK TOTP success path may call VERIFIER issue. Await native success; resolve effective cookies and independent committed current session. Recheck original version/snapshot/pin, session/token lineage, purpose, deadline, clock and no relevant pending/blocked ledger. No JSON token inference, no enrollment promotion, no rebasing. Ready evidence is protected database state, not the earlier WeakMap object.
5. **consumed**: STAFF finalizes from the private row under governance; atomically consume challenge/proof, bind session/epoch, write only permitted normal admission or step-up change, and append success audit. Any audit error rolls back all LOCAL changes. It cannot roll back SDK work or previously committed replay/budget charges.
6. **denied/expired/revoked/unknown**: terminal and non-authorizing. A timeout is not cancellation; late SDK completion never becomes ready after the durable deadline. Provider partial state is detected/denied, not repaired into privilege.

Original user/version/generation/purpose/DB origin never changes. Fixed separate login and step-up prepare operations; no generic caller-selected mode. Enrollment/recovery states cannot issue ordinary evidence. Normal login requires fresh actual password then TOTP and a new SDK session. Step-up requires already-live matching admission/epoch/token/version, updates mfa_at only, never authenticated_at/last_seen_at/absolute origin. Unsupported session/token rotation is denied and requires a fresh full ceremony; no resetting absolute age from SDK Session.createdAt.

### Proposed capability API (not installed while gate pending)

```text
VERIFIER only:
 clock_probe() -> safe DB time/realm metadata (no key)
 prepare_password(identity_lookup, internal_IP_scope) -> private challenge handle / static denial
 bind_primary(challenge_handle, exact_signed_cookie_credential) -> CAS primary-bound
 resume_primary(exact_signed_cookie_credential) -> only unclaimed primary-bound safe context
 prepare_step_up(actual_SDK_user_session_binding, internal_IP_scope) -> fixed step-up challenge
 reserve_mfa(challenge_handle, exact_cookie_binding, raw_six_digit_code) -> private one-operation handle
 issue_evidence(operation_handle, actual_final_committed_session_binding) -> private evidence handle

STAFF only:
 finalize_control(evidence_handle, actual_SDK_session_binding) -> minimal outcome
 touch_control(trusted_actor, session, expected_version) -> expiry-before-touch outcome
 existing revoke_admission(...) -> augmented durable revocation through reviewed bridge

WORKER only:
 cleanup_control_orphans(fixed_bounded_limit) -> safe count/IDs, no secrets
```

Private handles are unpredictable server capabilities, never audit/request URLs or ordinary public DTOs. Finalizer derives user, version, purpose and all timestamps from private rows, not supplied JSON/booleans. Actual SDK cookie possession is independently checked by the unmounted server facade before the STAFF call. Raw SQL STAFF callers still represent a trusted shared service boundary, not a browser identity.

## 4. Global equivalent replay authority, not custom TOTP

Pinned SDK is fixed to P=30seconds,6ASCII digits and default ±1 step. It samples Date.now once and returns boolean only. Maintain its real verification; do not reimplement its algorithm or guess a matched counter.

Before native verification reserve maintained pgcrypto HMAC-SHA256 of an unambiguous domain-separated binary framing of **user ID + exact six-digit code**. Do NOT include session/challenge/purpose/version/factor generation or time buckets. Leading zeros remain significant. A single protected unique key covers all sessions, login/step-up, workers, restarts and generation changes. Live conflict is DENY, never return another owner's attempt or extend/reassign a lease. Invalid codes and crash/uncertain outcomes also retain their burn; this is conservative denial, never evidence of successful MFA.

Use a stable private per-owned-database high-entropy replay key, generated OFFLINE once and inaccessible to runtime SELECT/oracle calls. No runtime generation, unkeyed hash/in-memory fallback, startup clear or supported rotation in B.2b. Missing/changed key or replay store denies. Private fingerprint/keys/raw OTPs never enter audit/DTO/artifacts. Different factors/counters may coincidentally produce identical six digits: conservatively deny during retention; numeric equality beyond retention is not claimed to be replay of the same counter.

### Conditional horizon proof and clock model

A counter c is accepted while SDK time is in [(c−1)P,(c+2)P), total90seconds. Require trusted Node/SDK and PostgreSQL clocks to differ by at most S=5seconds **throughout actual SDK comparison**, and comparison/completion/ready registration/final consumption no later than D=30seconds after the independently committed DB reservation r. Last acceptance of that same counter is before r+D+3P+2S = r+130seconds. Retention **at least180seconds from actual DB reservation** is conservative. Never use issue/finalize time or a rounded bucket as the claim origin. Retention boundary replacement is atomic and expiry inequalities strict.

The30second deadline is immutable and checked AFTER governance waits at reserve/ready/finalize, not a Promise.race timer. A delayed SDK result beyond it remains unusable forever; fresh ceremony/new code required. In-process performance.now elapsed checks supplement, not replace, durable DB expiry.

Pre/post clock samples include the entire request round-trip interval. Require the whole possible Node−DB offset interval within±5seconds and at most250milliseconds sampling uncertainty; reject long/ambiguous samples, clock jumps or excessive elapsed time. These samples DO NOT prove an unobserved mid-operation clock excursion. **Trusted OS clocks continuously within this bound are an explicit security precondition**, not a guarantee manufactured by endpoint samples. Malicious OS/full process compromise is outside the trusted verifier boundary; operational enablement requires owner-approved clock monitoring/maintenance.

PostgreSQL clock_timestamp is WALL time, not a monotonic primitive. Maintain a serialized durable high-water/rollback latch and committed time witnesses; never silently decrease/reset it. Denial paths must preserve observed rollback/clock-fence state independently of a rolled-back finalization/audit transaction. All B.2b entrypoints and augmented access guards reject inconsistent clock state. A whole database restore can roll back its own watermark/key/replay rows: SQL alone cannot detect arbitrary snapshot restoration. Such restore is NOT a supported B.2b runtime operation; it requires prior externally enforced auth shutdown, invalidation of old challenges/evidence/session lineage and quarantine beyond the full horizon before any future approved re-enable. No automatic restore detection or safe hot key rotation is claimed.

## 5. Existing B.1 guard/revocation bridge and data preservation

Additive migration after005 only; never edit applied SQL or introduce a second history. Preserve catalog/public data and existing security facts. New controls are empty/dormant initially; no existing identity/Owner is approved/seeded by migration.

Augment the existing check_access path (not an optional alternate guard) so all operationally finalized rows require new current token/snapshot/epoch/revocation/clock controls in addition to every B.1 condition. An internal legacy implementation, if renamed for composition, has NO runtime EXECUTE escape hatch. Existing sensitive set_status/replace_roles/revoke paths continue to call the augmented guard under governance.

Existing revoke_admission must atomically persist a durable tombstone when mode becomes revoked. Admission DELETE/reconciliation/cascade and provider Session/User retirement must preserve denial independently of removable admission/Session rows. Retired identifiers cannot be reused to revive a proof. Tombstones retain validated opaque IDs without Session/admission cascading ownership; no runtime reset/clear capability. Offline synthetic fixture setup may explicitly seed/reset protected controls with migration ownership; it is not a runtime privilege or weakening of access assertions. Legacy existing rows are preserved, not automatically grandfathered into new trusted MFA provenance.

Original authentication epoch/deadline is database-captured before password verification and immutable; absolute8h/idle30m/recent5m remain synthetic candidates. Expiry is checked before safe monotonic last_seen update, using post-lock clock. Only explicit foreground use-case primitive touches; polls/session lookup/prefetch do not. Step-up does not touch idle or absolute origin. No operational session-refresh/rotation protocol in B.2b.

## 6. Abuse, audit and partial failures

Dormant candidate outer policy: password5attempts/account/15min, MFA10attempts/account/15min,20attempts/unknown-IP-scope/15min. Count ATTEMPTS before costly SDK work, including crashes; do not misdescribe them as failed-only counters. Native SDK limits remain enabled. Fixed-window end/cooldown is anchored; denied retries do not extend it and callers cannot reset budgets. Charge account+IP keys atomically, governance first then sorted keys. Row/reservation caps and storage outage deny; bounded worker cleanup only expires already-expired non-authorizing records. This bounds temporary denial but does NOT eliminate sustained account-lockout DoS.

No trustworthy browser/proxy IP exists in B.2b. Default one conservative common unknown/loopback scope. No X-Forwarded/Real-IP/spike header trust. Alternate peer scopes in tests are private synthetic socket/provenance fixtures, not claims from public headers.

Finalization overwrites/reset audit actor context with the DB-derived actor; never inherit a caller-set security_actor GUC. VERIFIER source is explicitly represented, not silently classified offline. Add fixed redacted action vocabulary for preparation/evidence/step-up/revoke/orphan facts; no raw code/token/cookie/key/proof capability/credential snapshot in audit. Local consume/admission/success-audit are atomic. Failed/rolled-back/unknown denial facts use a separate bounded sink after locks/transaction release; no false success in a doomed transaction.

Orphan detection uses a DB-observed first-seen time captured by a provider trigger, NOT AUTH-writable Session.createdAt. Worker under governance rechecks grace, same token/generation candidate, no valid admission/live inflight/ready proof before tombstone+DELETE+audit atomically. Guard's reviewed DELETE Session capability is not Worker table DML. All B.1 source backlog/Owner guards remain; saturation/audit failure rolls cleanup back. Failed enrollment may remain enabled+unverified with an undelivered/orphan session. Deny/quarantine and cleanup only; no automatic factor reset, approval refresh, recovery or grant.

Bound SQL parameters alone do not prove secrecy of server logs. Offline owned-role hardening and runtime checks must constrain statement/bind/error-parameter logging and unexpected pgaudit/auto_explain settings. Test sentinels must not reach SDK console, PG log/error detail, JUnit/CI artifacts or DTOs. New issuer code rethrows into a fixed sanitizer, not a raw fallback logger. No global log changes to unrelated services.

### Least-privilege configuration witness (runtime finding)

Actual PG18 execution established that ordinary VERIFIER cannot read shared_preload_libraries:42501. Do NOT grant runtime superuser, pg_read_all_settings membership or a privileged arbitrary-settings oracle. The migration therefore creates an EMPTY private configuration_witness. Only owned offline hardening, AFTER actual privileged configuration/default/logging checks, publishes the current secret realm ID and actual pg_postmaster_start_time with a fixed empty-preload policy. Existing clock_probe/guards require this witness to match the current server process; missing/stale witness denies, without resetting keys, burns, epochs or clock latches. A database restart consequently requires offline revalidation before controls resume. No runtime setter/private SELECT/new EXECUTE grant exists.

Runtime metadata still checks all readable actual logging GUCs, logging-module names and applicable role/database/global preload-default catalog entries. Fixed nonempty USERSET application_name startup options prevent pg's PGOPTIONS environment fallback; URI options and caller-configured SQL/connection hooks remain forbidden. This does not pretend an ordinary role can inspect hidden postmaster settings. Trusted owned server configuration must not be changed/reloaded while authentication operates: shut down admission and re-harden/revalidate first. The witness binds a postmaster restart, not arbitrary hot configuration tampering or whole-database restoration. It is configuration continuity evidence only, NEVER MFA success evidence.

## 7. Restart, ambiguity and deadlines

- Before reserve commit is confirmed: do not invoke SDK. Unknown reserve outcome denies unless exact immutable ownership can be read through a narrow capability-bound path; no blind retry.
- Crash after reserve: retained burn and charge; inflight cannot resume/reinvoke SDK, even if cookie/session later exists. Start fresh after appropriate cooldown/new code.
- Crash after SDK before ready: no positive proof; no reconstruction from logs, flags, session presence or memory observations. Provider may already have nonprivileged state.
- Confirmed ready survives process restart only through its protected capability and unchanged cookie/session/snapshot/deadline. No refreshing bindings or importing JSON proof.
- Finalizer/audit rollback leaves earlier replay/budget burn committed. Ready may be retried only identically while still live. Commit-unknown is not certain rollback; an already-consumed exact capability may return its identical result only after fresh live revalidation, with NO new grant/touch/deadline extension. Revocation/expiry/version change wins then denies.

## 8. Gate acceptance before migration

**Recorded gate evidence, before006 exists:** actual local TypeScript passed; the four pre-migration feasibility tests passed with no skips on owned PG18/55436 applying canonical001–005 only. Trusted pgcrypto installed as the offline migrator; its extension functions were bootstrap-superuser-owned (not runtime definer functions), so later privilege hardening must use the owned offline administrator rather than assuming migrator ownership. Maintained PG/Node HMAC matched RFC4231, four independent SQL contenders had one unique-claim winner and reopening a connection could not re-claim. The real pinned SDK accepted previous/current/next P30 windows and rejected outside±1. Connection reopen is NOT process-restart evidence; that remains an implementation acceptance test.

Two bounded independent source design reviews found and resolved immutable deadline/clock trust, persistent burn, B.1 revocation bridge, credential-poisoning approval generations, ABA retirement and primary freshness requirements. Final source review gives GO for dormant additive implementation under the explicitly stated trust/clock/restore preconditions, not operational authentication or correctness certification. An initial feasibility compile used removed Vitest5 describe.sequential; it was corrected to the default serialized suite before the actual successful run. No skipped or unexecuted test is counted as passing evidence.

Required before006: (a) source-level positive issuer/threat/state/revocation/clock contracts above independently reviewed; (b) actual owned PG18 trusted pgcrypto availability/ownership/HMAC primitive and atomic shared-claim feasibility probed; (c) real maintained SDK previous/current/next-window behavior confirmed; (d) approval-generation pin and all B.1 bridges specified; (e) zero evidence inferred from WeakMap/metadata and no unsupported OTP math. Until those facts are recorded, **NO-GO to migration**.

Later B.2b acceptance requires real concurrent cross-challenge/session/purpose/worker/restart replay, same-challenge CAS, all skew/horizon/deadline boundaries, invalid/forged/stale/consumed records, AUTH-poisoned generation rejection, rotation/final-cookie mismatch, provider partial failures/orphans, revoke-vs-finalize and audit rollback, clock/key/store/logging/ACL failures and all six existing jobs plus dedicated seventh exact-final-HEAD CI. Test-only offline fixtures remain explicit. No new skip/retry/assertion weakening.

Operational clock/key custody, backup/restore protocol, actual approved identities/generation ceremony, delivery/recovery operators/privacy/retention and live policy remain separate owner decisions. Even a dormant B.2b GO is NOT permission for B.2c, real privileged authentication or merge. Stop after B.2b and keep its PR Draft.
