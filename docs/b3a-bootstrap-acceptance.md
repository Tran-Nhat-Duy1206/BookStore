# B.3a — Stable A01–A12 acceptance registry and review gates

**ALL CASES: REQUIRED / NOT EXECUTED / NO TEST CODE WRITTEN.** This is acceptance planning for [ADR-021](./adr-021-offline-owner-bootstrap.md) and its [state contract](./b3a-bootstrap-state-machine.md), not runtime certification. Case IDs `B3A-A01`…`B3A-A12` refine the base [B.3 plan](./batch-3-2b3-plan.md) A01–A12 families. Subcases below do not renumber the stable parent IDs. D01–D12 are OWNER DECISIONS, not test IDs. T1–T3 are technical gates, not tests already passed.

## 1. Uniform evidence contract

Future implementation requires separate explicit authorization AFTER B01–B06/design decisions are resolved. Use maintained pinned SDK1.7.18/adapter +real PostgreSQL18 on NEW marker-owned disposable fixtures. No real identity, operational secret, live endpoint, production/old DB or existing cluster mutation to run these cases. Native SDK hash/TOTP/encryption/session code is mandatory; unit/model faults are supplemental and labelled, never native completion evidence.

Each result must record exact source SHA, pinned versions, stable case/subcase, layer, setup authority, observed ordering, assertions and actual pass/fail/error/skip. Structured privacy-safe counts/booleans/enums only; dynamic identities/operation handles/root fingerprints/raw timestamps/passwords/cookies/OTP/factors/backups/approval/capability/keys/SQL parameters NOT in artifacts. Static sanitized JUnit; no auth traces/screenshots/HAR/video/storageState/DB/PEM uploads. Negative tests require a genuine positive control or exact reached-phase witness; arbitrary failure is not proof the intended guard ran.

For deterministic races use independent connections/processes and public owned lock/blocking relationships/barriers, both schedules where specified. Do not infer absent activity from a hidden cross-role stats column, add grants, reset attack state, retry native verification, extend bound or sleep until success. Operator/root fixtures must be explicitly synthetic, cannot be mistaken for real identity approval or current operational authority.

Expected result columns in every future implementation report: **provider/source**, **case/governance/generation/admission**, **cookie/session**, **success audit/denial**, **ordering and commit certainty**. Actual source commit, local commit and delivery are independent witnesses. A test may intentionally produce unavailable/denied but may not call a failed mandatory positive ceremony passed. Keep old B.2 historical failures unchanged.

## 2. Stable cases

### B3A-A01 — Independent initial authority and identity binding

- **Threat:** first-user/forged operator proof, identity collision/substitution, implicit Owner from provider flags/GitHub or migration fixture.
- **Setup/authority:** future synthetic D01 identity/proof contract, D02 operator/quorum and selected D03 A/B +S mapping. Include real SDK-created colliding identity under clearly labelled offline fixture setup; no current execution.
- **Preconditions:** uninitialized governance, no prior case/action; no approved real credentials. Candidate policy/expiry and operator revocation behavior explicitly supplied by ratified fixture contract.
- **Operations later:** proposed begin with correct/missing/expired/revoked proof/action/realm/identity/version; maintained fresh signup versus same-email collision; inspect exact protected case. No public/native signup path enabled.
- **Linearization:** governance lock +unique initial action/case +expected revision CAS. A negative with prior collision must reach actual native collision/guard, not unrelated bootstrap failure.
- **Expected:** only authenticated independently authorized case begins; no provider account from a denied case, no role/pin/admission/control on begin. Native collision is not silently adopted/linked. Minimal case audit for committed begin; rejected attempts fixed denial after rollback, no raw identity/proof. Cookie NONE/never administrative.
- **Denial conditions:** forged reference/caller identity/role override, wrong realm/revision, missing proof channel or selected authority; no row existence/emailVerified substitutes.
- **Required evidence:** authentic positive control then each exact negative, immutable identity/action/ref comparison, no side-effect count deltas for negatives, actual profile privileges, secret-safe output. No claim independent real identity was verified by fixtures.

### B3A-A02 — Single initial case, replay, expiry and cancellation

- **Threat:** simultaneous or duplicated bootstrap, case-ID replay/rebinding, expired approval, cancellation/activation races.
- **Setup/authority:** two independently authorized synthetic case requests/approver processes for SAME owned realm; stable operation payloads, approved TTL; a later prepared evidence fixture must be labelled nonnative if used only to isolate SQL (native end-to-end still required).
- **Preconditions:** same uninitialized g; no live initial case. Replayed payload identity/role/action cannot be changed.
- **Operations later:** concurrent begin; exact duplicate status read; conflicting duplicate payload; cancel vsactivate in BOTH orders; hold governance until bound expiry then invoke, without changing clocks.
- **Linearization:** governance/unique case/expected g-c; cancel/activate same case CAS.
- **Expected:** at most ONE case/winner, one governance transition/audit; loser denied, no identity adoption/new case. Cancel wins ⇒ terminal/no activation/late result orphan; activation wins ⇒ cancel returns already-activated STATUS ONLY, no reversal. Expiry checked after wait, no TTL renewal/reset to uninitialized. No admin cookies/admission from either response.
- **Denial conditions:** duplicate differing payload, subject/realm/action/revision swap, reused consumed/cancelled/expired case or revoked approver status access.
- **Required evidence:** both real schedules/public wait observations, exact unique-row/revision/consumption and audit counts, retained failed/spent history after session/account cleanup, no repeated SDK call counter.

### B3A-A03 — Maintained creation, primary password proof and restricted factor setup

- **Threat:** signup/password/session existence mistaken for approval; custom hashing or unproved email verification; exposed permissive provider/setup secret.
- **Setup/authority:** approved future private adapter/root only, synthetic case; selected maintained API/identity assertion mapping and secret channel; AUTH remains provider persistence, no seal/activate.
- **Preconditions:** A01 passed; confirmed create reservation; no existing identity; approved source-history/correlation design available. New namespace/profile grants reviewed, not improvised by fixture.
- **Operations later:** real maintained signup/hashing, separate maintained password sign-in, enable with actual password reproof. Independently read committed provider ownership/current cookie/SID. Test wrong password, missing mapping/channel, signup config absent, enable attempting to overwrite an unverified factor.
- **Linearization:** each one-use password-bearing operation/budget commits BEFORE SDK; source ledger+candidate history commits with native source. Binding CAS creates pending-only context/principal if ratified.
- **Expected:** correct provider credential persists using maintained primitives, but email flags do not prove identity and provider session gives no admission. Exact subject attached once; pending principal has no Owner grant/pin/normal controls; secret never reaches general DTO/log/artifact. Enable reproof is charged; no hidden regeneration/retry or bypass of disabled ordinary endpoints. Local case edge audit separate from native commits.
- **Denial conditions:** existing account adoption, cross-user cookie, wrong primary, duplicate operation, changed identity, secret-channel/approval missing or partial native operation.
- **Required evidence:** real SDK password positive and wrong-password negative, actual committed row lookup, native operation counts, denied ordinary kernel/Route/Action controls, bundle/export/default-off checks, privacy sentinels with no retained secret values.

### B3A-A04 — Genuine TOTP confirmation, native rotation and setup-only outcome

- **Threat:** HTTP200/flags/WeakMap/old JSON token used as proof; enrollment promotes into ordinary MFA.
- **Setup/authority:** native A03 case with pending factor and confirmed primary; selected trusted setup recorder; maintained authenticator utilities only in future test to generate synthetic codes.
- **Preconditions:** unchanged q/root/factor/primary, global burn reservation confirmed, original120s and30s bounds valid; candidate write correlation B03 selected.
- **Operations later:** real native verifyTOTP, await full operation/factor commit; apply all actual Set-Cookie changes/deletions; maintained session lookup/cache off +independent committed SID/user/token/expiry; capture outcome. Also old JSON-token lookup, wrong code/user/final cookie, final SID deletion/fault and late completion.
- **Linearization:** global reserve before actual compare; provider's multiple source commits; local capture CAS+audit only after exact successful native boundary.
- **Expected:** rotated committed final SID is bound, old cookie/token not accepted as final; native successful flags alone cannot capture. Candidate expected security writes advance revision with exact grammar. Outcome reference is setup-only; zero ordinary issue_evidence/admission/recent MFA. Failure emits no new cookie/outcome, burns remain; old/new provider sessions may be orphans, not falsely rolled back.
- **Denial conditions:** copied/non-authorizing observation, caller success boolean, missing full operation/session proof, wrong lineage, deadline/clock failure, unexplained source transition or unreconciled critical event.
- **Required evidence:** genuine maintained positive plus exact-phase negative, final-cookie vsJSON token divergence, independent committed visibility, pre-SDK burn witness, setup outcome rejected by every normal finalizer/guard, zero secret DTO/log output.

### B3A-A05 — Candidate source history, exact generation/versions and pre-pin ABA

- **Threat:** AUTH poisons/restores candidate credentials/factor before first pin; approval adopts latest root or stale local version.
- **Setup/authority:** native completed candidate, no approved pin yet, protected monotone journal/correlation implementation explicitly authorized; independent approver seals only a known exact q/root/identity/local Owner transition.
- **Preconditions:** fixed provider snapshot projection and expected write grammar. Test subject associations/provider membership are guarded by current immutable-binding rules; rejected rebinding is not falsely counted as committed mutation.
- **Operations later:** mutate password, secret, backups, verified/email/enabled fields, delete/reinsert factor, extra factor, and committed A→B→A before/during/after capture/seal; attempt OLD/NEW subject/provider-class moves, no-ops and aborted savepoint; change pending target authz/permission/intended grants; approve wrong root/q/expected versions.
- **Linearization:** each critical source write advances revision/history in SAME transaction; capture/seal/activate compares exact prior/current q-root and separate v/p under governance. Native expected false→true changes are tracked, not bypassed.
- **Expected:** unexplained committed mutation invalidates old outcome/seal despite equal final bytes; no latest root refresh, no automatic pin/unretire. Rejected/aborted mutations produce no committed history delta. ProviderSnapshot includes provider ONLY; roles/status/versions must bind separately and stale ones deny. Audit never contains raw root/credential material.
- **Denial conditions:** missing/overflowed journal, unauthenticated GUC/source-op claims, post-hoc event kind/count, credential-role substitution or ambiguous native causal binding.
- **Required evidence:** actual native source +direct AUTH adversarial paths, independent q/history/consumption witnesses and same transaction rollback; exact snapshot equality BEFORE negative to prove ABA rather than generic mismatch; normal grant count0. B03 not resolved merely by documenting these expectations.

### B3A-A06 — Crash and partial completion at every source/local boundary

- **Threat:** orphan provider session or partial User/factor commit becomes evidence; restart reinvokes SDK/repairs state.
- **Setup/authority:** future owned child process/private coordinator with minimal allowed credentials; exact source-phase fault barriers; synthetic identity only. No unrelated service/connection termination.
- **Preconditions:** reserved operation ownership and source-history binding; record which commit is definitely confirmed before fault. Table-drive E0–E4/E2a/E3s boundary variants.
- **Operations later:** stop owned process before/after reserve commit, after User/Account creation, primary session, factor enable, User enable, new session/old deletion/factor verification, capture/seal and final activation. Restart with only authorized exact-case status access.
- **Linearization:** each provider/source transaction and local edge independently observed, not one endpoint-wide transaction.
- **Expected:** before reserve confirmation no SDK; reserve committed retains charges/burn; partial source can persist but normal admission0 and no inferred outcome. Restart never takes over inflight/retries SDK, regenerates factor, re-pins or resets case. Late result rejects. Final atomic activation either all local pieces exist or none; provider state not claimed rolled back. No delivered admin cookie on failed path.
- **Denial conditions:** missing committed evidence/native outcome, orphan/partial enabled flags, unknown-source request, invalid supervisor/custody or late deadline.
- **Required evidence:** real SDK/PG reached-phase markers, natural owned resource cleanup/failure-only termination labelled, committed source/ledger vslocal state, no replay native call counter, deny-only worker behavior, artifact redaction. Synthetic packet models cannot replace native phase proof.

### B3A-A07 — Audit failure, exact status inspection and unknown COMMIT

- **Threat:** success without required audit, false rollback after commit-unknown, duplicate activation/authority from status recovery.
- **Setup/authority:** exact owned audit faults and owned connection/acknowledgement faults, no public fake-SDK observer; real completed native candidate for end-to-end variant.
- **Preconditions:** know whether native source/burn already committed; exact case/op/approval binding and selected inspection authority. Local audit vocab/profile reviewed.
- **Operations later:** fail each edge's success audit including capture/seal/activate; unavailable/saturated denial sink; drop owned acknowledgement around COMMIT with independent current read; inspect exact operation with correct/wrong binding and revoked operator.
- **Linearization:** transaction commit on server, not client response; audit+local changes atomic. Inspection read has no mutation/grant effects.
- **Expected:** local audit failure rolls local edge back; earlier source/burn survives. Commit-unknown may be durable activated OR previous state; caller initially unavailable and no cookie, then exact status may confirm without rerunning mutation/new pin/cookie/TTL. Terminal negative stays negative. Denial sink failure is honest evidence-unavailable, not success or universal audit guarantee.
- **Denial conditions:** treating network error as certain rollback, changing payload/root, generic subject inspection, auto retry/renewal or recording success in failed transaction.
- **Required evidence:** independent server committed state +local API classification and exact audit/consumption counts, one pin/activation maximum, no native re-execution, failure-record bounds, no raw errors/SQL logs.

### B3A-A08 — Atomic initial activation, exactly one approved Owner, no session requirement

- **Threat:** partial role/pin/governance activation, unrelated structural Owner counted, circular active-governance check or setup admin session.
- **Setup/authority:** genuine A03/A04 candidate +independent exact A05 seal; ratified authority/state contract. Include labelled SQL fixtures for extra structural-only Owner/extra E-owner/zero-current-session variants, separate from genuine native proof.
- **Preconditions:** evidence_ready, exact c/g/q/root/v/p, approved fixed Owner transition, all source events processed/no BLOCKED, deadline/burn/witness valid; no prior case consumption.
- **Operations later:** activate once and competing activate/cancel, wrong realm/root/subject/local role set; attempt direct governance update bypass; inspect state after loss of acknowledgement. Deny-only retire setup SID; then future test NEW canonical password+fresh TOTP/new challenge/SID (not setup code) only after activation.
- **Linearization:** one local governance/case transaction containing authorized principal/Owner change+NEW pin+exact-one S/E same subject+governance active+consumption+audit.
- **Expected:** all local pieces together, exactly1 distinct structural and generation-approved Owner SAME case user; no ordinary admission/control/recent MFA on activation and no setup cookie response. No active login session required by Owner predicate. Setup SID retired; only subsequent genuine ordinary ceremony may admit. Duplicate inspection creates nothing; extra structural Owner or wrong pin denies.
- **Denial conditions:** count pin/factor joins instead of subjects, reuse live_generation(active) causing cycle, case not sealed/current, stale target versions, pending/BLOCKED or source change after approval.
- **Required evidence:** exact atomic independent SQL snapshot, both race orders, no verified admission before fresh login, positive zero-session Owner predicate separate from liveness, correct new login/B.2 retained assertions. No assertion that E-owner implies uptime.

### B3A-A09 — Cross-purpose global exact-code replay

- **Threat:** one accepted code reused between setup/login/step-up/replacement, sessions/processes or generation boundaries.
- **Setup/authority:** future genuine native setup plus ordinary canonical login/step-up using separate authorized processes on SAME owned DB/key. Replacement purpose is CONTRACT-ONLY until separately authorized B.3d; use explicit nonnative reservation-contract fixture only if ratified, never implement recovery to satisfy this case.
- **Preconditions:** fixed P30/six ASCII digits/±1 maintained tolerance, continuous trusted clock assumptions and current burn key/horizon; no reset inside scenario. Rare equal-code collisions deny, no regenerate/retry until favorable.
- **Operations later:** simultaneous SAME user/exact-code reservations across cases/purposes/processes; replay after generation change/reopen/restart; leading-zero and wrong-code native cases; invalid setup code burned before native failure.
- **Linearization:** one protected replay unique key +governance/CAS; EXACT existing user-code payload/framing/key/table before SDK, no purpose/generation key prefix.
- **Expected:** at most one reservation winner, losing branch no SDK call; invalid/crashed winner still consumes charge/burn. No second grant after copy/purpose switch; code remains secret. Distinct user scope not collapsed; identical numeric values beyond retention are not claimed same historical TOTP counter.
- **Denial conditions:** key/table split, purpose/generation/time-bucket namespace, unsigned hash/in-memory cache fallback, claim refund, SDK success before burn confirmed.
- **Required evidence:** actual original+new SQL function state/counter witnesses, independent process race, maintained native positive where applicable, zero loser native-call count and no burned value output. Explicitly label future replacement unavailable, not a passed recovery test.

### B3A-A10 — Budgets, freshness, quality and history failure

- **Threat:** enrollment active-session path avoids native login limiter; delayed human approval/native completion extends deadline; clock/witness/key unavailable fallback.
- **Setup/authority:** owned future fixture with exact current quotas, actual native operations and controlled owned PG waits/Node delays; no global/system clock changes or unrelated DB. Pure boundary checks supplement, not native proof.
- **Preconditions:** primary origin DB pre-password; case/approval TTL explicitly approved but cannot extend120s/30s; budgets account/common unknown scope and all storage ceilings reviewed.
- **Operations later:** each password-bearing create/sign-in/enable charge, atomic ceiling across processes, pre-SDK MFA budget, reserve→native→capture→seal→activate at exact/post-wait expiry; expired burn boundary; DB/clock witness/key/journal/denial storage failure, over250ms sample and25ms/5s existing boundary regressions.
- **Linearization:** post-governance trusted DB checks and independently committed probes/charges; local timer or callback timestamp does not extend durable expiry.
- **Expected:** same5password/10MFA account,20common scope per KIND/15m plus retained native limits; charge before costly native; original120s, min(primary,reserve+30s),180s burn, caps unchanged. Slow approval expires/denies, no new code reuse/grace. Clock/key/history/audit uncertainty returns unavailable, no SDK or approval fallback. No availability/SLA certification from pass.
- **Denial conditions:** scope from headers, per-purpose budget loophole, unbounded setup rows evading ceiling, counter reset/renewal, earlier sampling endpoint, native limiter disabled, replay history lost.
- **Required evidence:** protected counts/bounds from independent SQL and exact native-call sentinels, positive+negative boundary controls, retained latch/burn through rollback/restart, actual delayed-guard refusal. Preserve failed outcomes; do not rerun unchanged candidate until green.

### B3A-A11 — Authority/credential/permission and privacy boundaries

- **Threat:** broad Migrate/approver credential in child/web, new generic issuer, raw secrets, caller/GUC success or unexpected EXEC drift.
- **Setup/authority:** ratified A/B and S1/S2 manifests, independent purpose profiles and selected Guard owners on new owned fixture. All new credentials synthetic/ephemeral ONLY after explicit implementation authorization.
- **Preconditions:** actual catalog owners/ACL/default/column permissions and runtime logging settings validated. Existing seven-function VERIFIER profile unchanged unless S1 extension explicitly ratified; do not suppress current strict checks.
- **Operations later:** negative every fixed function under AUTH/STAFF/WORKER/PUBLIC/wrong setup/approver; arbitrary approval/pin/issue/admission/table/secret/MAC/DDL/TEMP/TRUNCATE/trigger disable/SET ROLE; forged GUC/callback/boolean/outcome; child env/build/import leakage; default root dev+prod routes with flags; status cross-case/revoked approval. If B chosen, separately test narrow helper but explicitly label owner's broad unpreventable authority.
- **Linearization:** authenticated exact-purpose entry +fixed function Guard checks, not URL name alone or caller actor field.
- **Expected:** selected setup caller cannot seal/activate. For S2, normal issue EXECUTE must be denied; for S1 the existing VERIFIER necessarily retains its ordinary issue grant, so assert PRIVATE setup paths/references never create/consume a normal attempt or grant, not false SQL-root isolation. Approver cannot SDK-edit/normal-issue/generic pin/read secrets; worker stays five deny-only functions/no case advance. No actual endpoint/UI or secret-bearing DTO/artifact. All denied operations no unauthorized DML; approved minimal manifest works. B is NOT certified as narrow A by these tests.
- **Denial conditions:** broad wildcard EXEC/USAGE/DML, new membership/column grants, override logging/preloads/PGOPTIONS source, helper receives trusted flag from caller, secret channel absent.
- **Required evidence:** complete chosen capability matrix/column/default/owner/search_path/catalog checks, existing profile drift negative, sanitized env/bundle/HTML/JSON/Flight/log/JUnit sentinels, exact source diff review. No publish of raw env/credential rows/root fingerprints.

### B3A-A12 — Last approved-generation Owner, direct mutations and upgrade compatibility

- **Threat:** structural Owner remains but its final approved generation retires; concurrent/bulk/cascade/ABA/Guard paths evade post-statement invariant; migration autoapproves legacy state.
- **Setup/authority:** future accepted-main7ebb seeded fixtures: (i) one S/E owner, (ii) two S/E owners, (iii) active structural-only/no pin, (iv) zero-session approved Owner. Label raw offline fixtures as NON-CEREMONY. Real native end-to-end generation fixture separately required.
- **Preconditions:** exact proposed S/E predicate and after-statement fresh visibility; immutable001–007; direct runtime privileges still narrow; source history monotone and no key oracle.
- **Operations later:** password/secret/backups nonempty→different, final password/factor removal, email/enabled/identity deletion and cascades/bulk; generation retirement directly through every authorized private path, retired-user tombstone; two Owners cross-demote/disable/retire BOTH schedules; committed A→B→A with second E-owner, aborted savepoint/no-op; rebind/provider-class paths rejected or old/new invalidation proven. Fresh+seeded upgrade, unsupported isolation, checksum/catalog/state/ACL comparison and legacy structural-only preflight.
- **Linearization:** governance BEFORE statement, row-level source retirement then generation-aware AFTER STATEMENT assertion including private generation/tombstone tables. Assert current post-wait/post-source state, not stale STABLE snapshot. No per-row bypass or deferred zero-E commit.
- **Expected:** active governance never commits zero E-owner; sole destructive source transaction raises/rolls back source+retirement (not falsely called committed ABA). With second E-owner mutation may commit but old generation never un-retires on restoration. Distinct user counting; no login session requirement and no claim immediate usability. Strict bootstrap exact1S/1E same case; no recovery/uninitialized reset. Legacy active/no-pin upgrade refuses without creating pin or grandfathering; owner disposition required, no changes to baseline security state to force success. Local source/audit rollback honest.
- **Denial conditions:** direct retire bypass, trigger ordering/cascade gap, private helper STABLE stale read, runtime TRUNCATE/trigger disable, new role inheritance, automatic migration approval/fixture presented as genuine ceremony, key/history unavailable.
- **Required evidence:** real PG independent connection barrier orders and exact state/rollback/audit snapshots, native critical mutations where supported plus direct AUTH adversarial DML, fresh+upgrade/no-op/legacy-refusal checksums and all old assertions retained. Cannot mark T2 solved from structural count alone or model tests.

## 3. Technical gate checklist and future acceptance decision

| Gate | Required BEFORE implementation selection | Required later executed evidence |
|---|---|---|
| T1 | Select private maintained create/password/enable/confirm APIs, identity assertion+secret channel, S mapping, exact SAME burn/budgets/deadlines/caps, causal candidate source-reservation mechanism. | A03–A07,A09–A11 real SDK/PG/privacy; no unproven success inferred from flags or equal snapshots. |
| T2 | Ratify E-predicate/after-statement visibility/OLD+NEW history/direct retirement scope/legacy preflight and D05 tradeoff. | A05,A08,A12 real concurrency/cascade/source rollback/fresh+upgrade/refusal tests. |
| T3 | Ratify authority model, immutable envelope/CAS/lock order/state edges, seal/activation atomicity, no deadline extension, unknown-result inspection and audit contracts. | A01–A08,A10–A12 actual source/local commit/phase proof, no ordinary grant until fresh canonical login. |

All required cases must run on ONE actual final source HEAD after authorization, not assembled across commits. Preserve ALL TEN existing jobs, exact pins/dev-only status/lockfile/19compatibility cases, original179/security/Next/worker/catalog/storefront assertions and default-off scope. Future separate implementation acceptance requires fresh install/generation/type/lint/root+isolated build/actual security SQL+SDK/real browser where applicable/fresh+upgrade/full unsuppressed audit and complete exact-HEAD CI. Any failure/missing layer remains failure/pending, never model-certified or hidden by skip/retry/resource change.

Written T1–T3 contracts are **conditional design**, not passed tests. B01/B02/B03 introduce or change trusted authority/source contracts and require explicit owner review. Current task runs documentation checks ONLY; no B.3a implementation, account, SDK/PG execution, credential, migration, endpoint or activation. Keep this package unmerged and STOP.
