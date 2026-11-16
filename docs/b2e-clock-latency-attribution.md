# B.2e latency attribution — bounded follow-up contract

Selected BEFORE implementation. Baseline7ef2d65e4fe8545be764516e366b15a28c83b37b/main aefabf65f1b66d1ece5c7e5729e98a4c617c2669 and CI43740147484 ALL10SUCCESS verified. Prior investigation/ADR017–020 and authoritative PR receipt6898494897 read. Historical failures stay immutable; missing original measurements cannot be reconstructed. PR9 remains Draft/unmerged, no operational/B3/policy permission.

## Supported observation boundary

Use ONLY exported pg8.23.1 Query callback + row/end/error events and Client.query(Query), with listeners attached before call. Passing Query returns Query, NOT a Promise; await a harness-owned Promise resolved by the public callback. Pinned source invokes success callback before Query end, in client-processed ReadyForQuery handling. End is NOT kernel/wire arrival/server-send/SQL-only time. Client.readyForQuery is a property, not a supported event. No client.connection/private queue/submit/prototype hooks, mocks, replacement APIs or changes to production query usage.

Test harness captures private monotonic marks at API entry/return, first row, callback settlement, public successful end, await continuation. Only bounded durations/order booleans/counts leave the harness; exact wire submission and server execution time remain unobservable. No raw wall/DB/monotonic timestamps, SQL/parameters, credentials/PIDs/identities, sessions/OTPs/keys in output. Same fixed clock SQL under existing purpose credential/autocommit, private strict DB-time normalization+conservative padding and unchanged pure validator. Such assessments are **harness projections, NOT actual private authority outcomes/MFA proofs**. Actual authorities are separately observed through existing diagnostics/tests without hooking hidden clients.

## Fixed experiment matrix — no repeated execution until desirable

A: one warmed public-Query harness sample per VERIFIER/STAFF; existing actual authority warm/cold checks remain.
B: one genuine fresh process public-Query sample (VERIFIER), plus existing actual cold authority process case. Fresh connections in each arm are NOT labelled fresh processes.
C: one350ms deliberate governance hold per role, same fixed clock query, parent publicly observes waiting before release; existing actual-ctor DB-hold case remains.
D: one350ms synchronous bounded listener-tail load per role, AFTER success callback settled AND public end reached, WITHOUT deliberate governance lock. This deterministically delays harness await continuation after client-processed ReadyForQuery. No row-triggered lock-release assumption. Target runs in Node Worker thread; independent parent owns separate observer connection with SAME existing purpose role to see its own role's narrowly scoped activity and public lock/blocking metadata. No grants or query text logging. Private backend PID passes through shared test memory, never output. Shared diagnostic busy flag set only during listener-tail interval; observer counts only SQL observations completed with flag true both before/after query. Missing during witness is a failed/inconclusive experiment, not proof of no wait.
E: one350ms deliberate governance hold plus one350ms end-listener busy tail per role; explicitly combined/sequential effects, not additive/counterfactual proof.
F: one fixed batch of TWO actual eager authority constructors concurrently, no resource settings/CI concurrency changes, no artificial blocker. Record every initialized/closed/unavailable result and actual role diagnostic data, no retry. This diagnostic arm's fail-closed result is NOT treated as successful positive authentication or availability guarantee.

Parent lock observer uses only current owned DB, private target PID, existing same-purpose logged-in role and public pg_locks/pg_blocking_pids/pg_stat_activity own-role fields; NO SQL text/time/PII. D uses exactly12 planned observations per role (10ms spacing), no retry-for-witness. Other arms at most12 bounded planned observations and one deliberate hold (C:3 before release; E:3 before release +9 during Node tail; A:3). All original179/assertions, 250ms/25ms/5s, SDK/VERIFIER, replay, role grants, source/probe order, authority-before-listen and workflow resources remain unchanged. No actual identity or positive admission from this harness.

## Local execution01 — preserved fixture failure, no grant widening

First fixed matrix:10 observations/tests,6PASS/4FAIL,0errors/skips. All four VERIFIER arms failed42501 in the test observer; STAFF four arms, genuine cold process and actual two-constructor batch passed. This was NOT an auth/clock failure and is not discarded as a green run. The observer attempted a staff.governance regclass name resolution under VERIFIER, which deliberately lacks staff-schema USAGE. Correct only this harness lookup: existing owned Migrate resolves the relation OID once outside all sampled intervals; existing VERIFIER/STAFF observers compare that private numeric OID in public pg_locks. No new grants, source/profile relaxations or changed assertions. A changed-fixture execution02 validates the correction, not retry-to-green.

The first successful STAFF D arm already observed control end15.016ms vs continuation365.223ms,350.207ms end→continuation; all12 independent during-busy observations saw own backend idle/no wait/no blocker/no governance lock. Unchanged classifier changed valid→uncertain on the two real endpoints; actual authority outcome remains unobserved in this arm. STAFF C end378.415ms/continuation378.556ms; E end385.957ms/continuation736.176ms. One actual F batch reported2initialized/2closed/0unavailable, not reliability proof. These partial results do NOT count failed VERIFIER arms passed.

Cold client acquisition and private PID preflight durations are added as separately labelled OUTSIDE probe spans; preflight warms the connection before the clock query, just as real authority metadata precedes its probe. Neither field is labelled SQL-only time or raw first-query latency.

## Local execution02 — fixed changed observer; actual phase evidence

Fresh types/full zero-warning ESLint and all10 new diagnostic cases PASS, zero fail/error/skip. No prior failure erased. Times below milliseconds, rounded for this table only; result booleans use full precision. Public API call-return ~0.15–0.29ms in these samples; not exact wire submission.

| Arm/role | callback | public end | await continuation | end→continuation | classifier at end / continuation |
|---|---:|---:|---:|---:|---|
| Warm VERIFIER |13.952|14.051|14.157|0.106|valid /valid|
| Warm STAFF |13.425|13.524|13.619|0.095|valid /valid|
| DB hold VERIFIER |379.343|379.434|379.560|0.126|uncertain /uncertain|
| DB hold STAFF |374.940|375.054|375.190|0.136|uncertain /uncertain|
| Node-only VERIFIER |14.121|14.212|364.513|350.301|valid /uncertain|
| Node-only STAFF |14.783|14.873|365.104|350.230|valid /uncertain|
| Sequential combined VERIFIER |383.503|383.607|733.817|350.210|uncertain /uncertain|
| Sequential combined STAFF |377.559|377.652|727.926|350.273|uncertain /uncertain|
| Fresh process VERIFIER |12.472|12.575|12.670|0.096|valid /valid|

Node-only D: each role had exactly12/12 completed independent observations WHILE shared busy flag true before/after SQL; all12 saw own target backend idle, no wait/blocker/governance relation lock. No deliberate governance hold existed. Successful public end + transaction idle preceded one350ms listener-tail load. Thus delayed JS continuation ALONE is sufficient to exceed original quality bound on real SQL metadata, independently of clock SQL lock wait. This remains harness projection, not an intercepted actual-authority response, not natural-delay frequency proof.

DB C: actual blocker/wait observed in2/3 fixed snapshots per role; end was already over250ms and continuation gap ~0.13ms. E: same prior wait plus later Node tail, explicitly sequential two contributors. No subtraction/counterfactual or SQL-only duration inferred. F fixed actual batch:2 initialized,2 awaited close,0 unavailable/unclassified,4 role samples; no general reliability claim. Cold process connect52.520ms/private preflight2.213ms were OUTSIDE measured end12.575ms; cold connection is warmed by preflight before clock SQL. Recorded ordinary idle connections were47.969–53.281ms pluspreflight2.35–2.54ms, outside samples.

No genuine production measurement defect or unnecessary production work demonstrated. The synthetic end-listener work is harness-only. Capturing an earlier endpoint to ignore continuation delay would alter the accepted full-round-trip guarantee and is NOT selected as a safe patch. Retain guard/fail-closed availability as option1; separately reviewed execution isolation/availability design as option2 (no arbitrary-stall guarantee); any clock/security-policy redesign only after explicit owner review as option3. No such behavior change is implemented.

## Security review before commit — test-harness corrections only

Independent actual-diff reviewcc75e42e identified two P2 harness issues: Node Worker default env inherited the parent bootstrap URL, and a failed blocker ROLLBACK could bypass worker cleanup. Corrected with a purpose-only minimal Worker environment (plus worker-side forbidden-credential-env check/shared boolean witness) and nested-finally teardown. No role grant/production change. Added ONE failure-cleanup regression using a newly owned Migrate connection deliberately closed after BEGIN; original matrix counts remain fixed, plus this separate lifecycle regression (11 new tests including F). Worker teardown must complete even when rollback cannot be sent. No raw errors or credentials printed. A changed-code validation03 is required, not an unchanged rerun.

Post-security-correction local03: all11 new cases PASS,0fail/error/skip, with purpose-only environment witnessed and rollback-failure cleanup tested. Fresh root TypeScript/full zero-warning ESLint PASS. Full affected integrated suite after fresh isolated Next build: **52/52PASS,0fail/error/skip**,190.735s, including old41 plus11 focused follow-up cases. No failed local01 case is retrospectively relabelled passed.

Initial actual-diff reviewcc75e42e found the two P2 harness issues above. Follow-up review49041904 inspected current corrected files and found no concrete P1/P2, confirming fixes; its no-command restriction prevented actual git-diff verification, so it is current-file source review only. Parent separately verifies protected production/workflow/179/validator/dependency/migration/storefront byte equality. No source/timing/authority fix proposed for implementation; final exact-HEAD ALL10 CI still required. This document is the pre-CI contract/local ledger; immutable final PR receipt records exact CI and phase-attributed outcome rather than claiming arbitrary-load reliability.

## Causality and stop boundaries

Node-only end-tail work is artificial but causally isolated from waiting in the completed clock SQL: successful ReadyForQuery-associated end and own-backend idle/no-lock during witness must be observed. It demonstrates that Node completion delay can make the unchanged quality classifier reject genuine DB metadata; it does NOT show a paused actual authority returned unavailable in that arm, quantify natural scheduling latency, or explain historical CI. API entry/return is not actual driver wire submission; query-event Promise path is analogous, not identical to production's string-query Promise/catch chain. Same-loop marks cannot observe a stopped loop independently; shared flags + separate event loop provide bounded during-load witnesses, not full coverage.

No architectural/security/timing correction is authorized here. Proposed behavior changes require owner review first. A green CI is correctness evidence under defined conditions, not reliable scheduling under arbitrary load. If facts show ordinary stalls can exceed the bound, present retain-guard/fail-closed availability vs execution-model guarantees vs separately reviewed policy redesign options, without implementing any. Run affected local suites and ALL10 exact-final-HEAD gates if files change; preserve failures. STOP after handoff; no merge/B3/accounts/auth activation/deploy/paid/unrelated DB/repo or storefront changes.
