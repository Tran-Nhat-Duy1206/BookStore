# B.2e clock-quality blocker — investigation contract and evidence

Status: investigation authorized after final NO-GO; no remediation/root cause selected yet. PR#9 MUST remain Draft/unmerged. Baseline cf54ca29db873d2a99da888fa67549b0f9c6a3e8 / CI43735241316 verified: nine successful jobs, sole failing standalone HTTPS wire178/179; browser22 passed. Original artifacts and prior ADR020/ledger/NO-GO receipt remain immutable history. Earlier unrelated503 is NOT classified as clock failure.

## Before instrumentation — actual source / hypotheses

- Authority checked() acquires pool client and completes purpose/ACL/logging metadata BEFORE probe's Date.now/performance bracket. Neither acquisition nor that completed metadata is directly measured. Other-role concurrent work, pool/driver queueing of the actual clock query, SQL locks/commit and Node scheduling MAY contribute.
- Constructor concurrently checks/probes VERIFIER and STAFF before native SDK core and before listening. Both SQL probes enter the SAME governance/clock-row locking domain and autocommit durable watermark. Preserve these locks, witnesses, metadata and closed role credentials.
- The raw-alias /enroll test's beforeEach constructs a new authority first. If constructor fails, no request is dispatched: this failure is NOT evidence that invalid-path ingress grants access. Moving/lazily bypassing startup checks is not authorized without independent proof; no such change selected.
- Observed uncertain means normalized wall-envelope width OR monotonic elapsed exceeded250ms. Stored baseline records do not distinguish the two; which exact measure exceeded cannot be retroactively recovered. Ordered later jump/skew checks may be masked. Do not infer CPU/DB/infrastructure cause.

A genuine quality violation; B unnecessary measured work; C incorrect sample construction; D legitimate DB/CPU scheduling; E unresolved infrastructure are hypotheses, not verdicts.

## Instrumentation contract — selected BEFORE code

Only explicit isolated NODE_ENV=test + BOOKSTORE_CLOCK_QUALITY_DIAGNOSTICS=1 emits bounded fixed-shape diagnostics. Diagnostic code must NOT feed admission decisions, inject clock sources/callbacks, accept user metadata, add queries, change capture order, normalize differently or return a positive result. Keep original250ms/25ms/5s and original probe SQL/autocommit/roles exactly.

Emit durations ONLY (no raw wall/DB timestamps): raw wall span, conservative normalized envelope span/precision padding, original monotonic elapsed, independent wall/mono exceeded booleans, purpose-client acquisition and completed metadata durations, relative initialization/probe offsets, event-loop active/idle deltas and same-process probe overlap. Fixed role/phase/reason, process-local numeric diagnostic group (NOT identity), finite capped values/cap flags, bounded record count. Log only explicit allowlist; never configuration/URLs/SQL params/raw errors/cookies/session/OTP/replay key/principal. Diagnostics disabled by default and in ordinary application composition. Observations are not a clock authority.

Existing standalone179 test source/assertions remain unchanged; isolated Vitest environment may enable diagnostics without workflow-job or resource changes. Add independent focused investigation tests to the existing tenth integrated job, retaining serial sampled-clock execution. No retries/skip/503-as-success in original positives.

## Controlled experiments planned

1. Real owned disposable role authority: cold pool/established connection and genuine cold process; report fixed counts/durations, no auth claims.
2. Real governance-row lock held by existing Migrate fixture, observed public lock graph; release once after a bounded >250ms test hold. Expect genuine uncertainty/unavailable, no issuer returned. Do not reset clock/history inside trajectory.
3. Bounded parent event-loop busy load scheduled ONLY after public role/lock witness, before real query response delivery; unchanged validator should fail closed. Distinguish DB blocking from Node scheduling using controlled phase witnesses and event-loop metadata; do not generalize to CI root cause.
4. Exact pure validator boundaries250/25/5000 and wall-only/mono-only/both; malformed/overflow values and diagnostic privacy/boundedness.
5. Real isolated HTTPS startup/invalid-path/legitimate auth/replay/revocation/privilege regressions remain in original179 and all ten CI jobs. No alternative unauthenticated listener or lazy authority initialization selected.

One controlled diagnostic CI candidate is allowed to measure the real execution model, NOT unchanged reruns to green. Preserve loaded-condition expected rejection. Baseline retrospective unknowns remain unknown even if new normal samples are bounded.

## Local controlled execution01 — actual results, not baseline forensics

Fresh fixed experiment: six additional real-role/controlled-boundary cases PASS, zero fail/error/skip,17.96s. Root types/full zero-warning ESLint and all300 unit cases (including original19compatibility,83clock and four diagnostic projection tests) PASS. No original179 source/assertion, SQL migration, dependency, workflow resource/concurrency or security threshold changed. The start helper safely refused occupied55436; status then verified the existing marker-owned PostgreSQL18 PID/data directory, which alone was used. No service was stopped/reconfigured.

Durations below are milliseconds, **not wall/DB timestamps**. Probe query-await is full client await, NOT SQL-only execution. Every listed value was uncapped/valid.

| Arm/role | acquire | completed metadata | raw wall / adjusted wall | original mono | active / idle | exact wall/mono exceeded |
|---|---:|---:|---:|---:|---:|---|
| Fresh pools VERIFIER |68.409|128.447|18 /20|17.518|0.477 /17.091|false/false|
| Fresh pools STAFF |83.410|136.102|18 /20|18.159|0.562 /17.647|false/false|
| Established STAFF |0.356|44.852|1 /3|1.453|0.539 /1.016|false/false|
| Deliberate governance hold VERIFIER |82.868|134.403|415 /417|415.308|24.180 /391.178|true/true|
| Deliberate governance hold STAFF |120.306|135.851|388 /390|387.460|8.510 /379.001|true/true|
| Governance + bounded busy-loop VERIFIER |120.922|152.159|374 /376|373.963|356.253 /17.762|true/true|
| Governance + bounded busy-loop STAFF |145.627|129.288|384 /386|383.663|356.924 /26.783|true/true|

Each load arm first observed BOTH actual purpose-role sessions waiting via public locks/blocking APIs, then deliberately held350ms ONCE (no auth retries). Both returned only unavailable, with no returned authority. Delay histogram max25ms for DB-hold arm vs360ms for combined arm; ELU active is NOT CPU consumption. The combined arm is NOT a pure event-loop isolate: its DB lock is also held throughout. Group/overlap identifies same-process role measurements only, not cross-process correlation. This proves A quality rejection and D controlled wait/resource-delay mechanisms in these experiments; NOT the original CI's underlying cause or which original measure exceeded.

Cold child process initialized both roles with new purpose pools, awaited closure, naturally exited0 with IPC disconnected/stdout drained (no composite-close assumption). Established serial STAFF pool had totalBefore=idleBefore=1 and still revalidated metadata/probed; this is expected reuse under the pg pool contract, not logged backend identity. Bad STAFF credential fixture returned unavailable/no authority; diagnostics leaked none of its private URL/credential/secret. Existing key/history/state was NOT reset in any trajectory.

Diagnostic refinement after initial local data: buffer the maximum two init diagnostic observations and format/emit AFTER both role brackets settle (after awaited pool close on failure). This prevents expanded JSON logging from extending its still-measuring sibling. Original legacy fixed rejection line remains. No admission/clock/SQL/startup sequencing correction is selected. A further fixed validation run checks this instrumentation refinement, not rerun-until-pass.

Post-buffer controlled validation02: all six focused cases PASS,0fail/error/skip,12.554s; fresh root TypeScript and full zero-warning ESLint PASS. This run is specifically for changed buffering/verified cold-child projection, not an unchanged workflow retry. All179 original source/assertions, validator source/limits, workflow/resources, migrations, dependencies and ordinary storefront compare byte-identical to reviewed baseline. Bounded actual-diff review141c0b52 found no P1/P2, privacy/authority bypass or decision change; no runtime work in review. No remediation selected. A first instrumented full-CI candidate will measure the unchanged security execution model and retain loaded expected rejection; final receipt must not equate an all-green normal run with retroactive diagnosis/reliability proof.

## Decision / stop rule

Classify only measured data. Review security implications BEFORE any correction. A safe narrow correction must preserve all accepted contracts and show loaded fail-closed regression. If only scheduling/policy changes, retries, weaker bounds or unproven request reordering could hide the issue, keep NO-GO and request owner review. All ten exact-final-HEAD successful CI jobs required for GO; isolated passing tests do not substitute. No B3, accounts/recovery activation/production auth/adminCRUD/commerce/deployment/paid infrastructure or unrelated repository/DB changes. Storefront unchanged.
