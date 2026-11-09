# ADR-015 — Batch 3.2B.1 security persistence and consistency contract

Status: implemented foundation proposal for owner review; **not accepted operational authentication**. Baseline main `62a5c9293b5029a1f78937bb4fcd90f09aea92f7`; branch `feat/phase3-b2b1-security-foundation`. No merge, real account, login route, MFA screen, invitation/recovery activation, business CRUD or deployment is authorized.

## Canonical persistence

There is exactly one application migration history: [canonical migrations](../prisma/migrations/). The three accepted catalog migrations are unchanged. [004](../prisma/migrations/004_security_identity/migration.sql) installs the six reviewed Better Auth1.7.18/Prisma-adapter1.7.18 provider tables; [005](../prisma/migrations/005_security_foundation/migration.sql) adds staff/audit state, ownership constraints and reviewed functions/triggers. The fourteen public catalog tables, original seed, UUID/public IDs/slugs and DTOs remain unchanged.

The [catalog Prisma schema](../prisma/schema.prisma) and [provider Prisma schema](../prisma/security.prisma) are purpose-specific **code-generation views**, not independent migration histories. Staff/governance/audit constraints and functions are reviewed SQL. Both migration configurations target the same directory and the same public `_prisma_migrations` ledger. Neither partial Prisma view may be used to auto-generate a whole-database destructive migration; deploy/status and reviewed additive SQL are the supported workflow. No migrate-dev/reset/shadow database capability is introduced.

| Schema   | Persistence                                                   | Authority                                                                                                                             |
| -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| public   | Existing fourteen catalog tables                              | Original catalog contract                                                                                                             |
| identity | User, Session, Account, Verification, TwoFactor, RateLimit    | Pinned provider model and maintained credential primitives                                                                            |
| staff    | principals, roles, permissions, role_permissions, role_grants | Fixed v1 grants; pending/active/suspended/disabled/recovery status; authorization version                                             |
| staff    | admissions                                                    | Same provider user/session composite FK; pending/verified/recovery/revoked mode; original authentication, activity and MFA timestamps |
| staff    | governance                                                    | Permanent singleton; uninitialized/bootstrap/active/recovery_locked vocabulary; revision                                              |
| audit    | events                                                        | Redacted immutable success facts, UUID, opaque actor/subject, fixed action/source, optional unique transition ID                      |
| audit    | provider_events                                               | Immutable source identity/kind plus bounded controlled processing metadata                                                            |
| audit    | denials                                                       | Separate redacted request UUID/reason/outcome; no actor/provider payload                                                              |

Provider storage is not replaced: password handling remains the maintained library's hashing; Session.token is the provider's actual raw-string model, not falsely described as a hash. No application password/session engine exists. The added Session(id,userId) unique key supports the admission FK; provider identity/account/session ownership keys cannot be rebound to hide an old owner's invalidation.

## Explicitly dormant admission and bootstrap

Migrations seed **no identity, staff principal, Owner, verified admission or invitation**. Governance starts uninitialized. Normal roles cannot insert/update principal grants or admission proof directly. No function can create verified admission, mint MFA evidence, enable bootstrap or enter/unlock recovery in B.1.

The [server-only kernel](../src/server/security/kernel.ts) defaults to no trusted identity. Its resolver is a server-composition dependency, NOT an HTTP/body/session-ID authenticator. Only isolated tests inject synthetic references and migration-only verified-state fixtures. A later separately approved batch must supply actual provider SDK session verification and protected observed-MFA admission writing before any handler/Action/UI is mounted. Provider enrollment booleans or password success cannot create admission.

Candidate checks are8h absolute,30m inactivity and5m recent TOTP for sensitive permissions; constants also retain24h invitation and365d audit targets. These are test/foundation values, not activation or final operational policy. There is no sliding idle-touch/rotation integration yet.

## Purpose credentials and topology

The new foundation uses an independent marker-owned Windows PostgreSQL18 cluster on loopback55436; disposable CI service55437. Base names/user, run-owned database/role suffixes, real role attributes and matching ownership markers are checked. [URL validation](../src/server/security/database-config.ts) has no5432, remote-host, query/fragment, normalized-path, catalog/spike credential or migration fallback. The [native helper](../scripts/security-local-db.mjs) verifies physical paths, version, data/PID/listener and free port; it never stops another service.

Each disposable database contains public+identity+staff+audit. Shared database does not mean shared transaction/client authority.

| Purpose | Grants                                                                                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reader  | USAGE public and SELECT the exact14catalog tables, not migration/private tables; writes still fail with transaction-readonly disabled                            |
| auth    | Six provider tables SELECT/INSERT/UPDATE/DELETE only; no staff/catalog/audit access, TRUNCATE or grants                                                          |
| staff   | Safe staff metadata and success-audit SELECT; EXECUTE reviewed access/status/role/self-revocation/denial functions; no raw control-table DML or identity secrets |
| worker  | Only bounded pending-ID, reconcile and failure-record functions; no raw table DML, provider-secret reads, admission/grant creation or governance activation      |
| migrate | Separate offline database/schema ownership; no normal service pool/environment                                                                                   |
| guard   | Marked NOLOGIN definer owner; no membership; narrow function surface, fixed pg_catalog search_path, qualified objects; never a connection credential             |

Runtime LOGIN roles are NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS/NOINHERIT with no memberships, database CREATE/TEMP or schema CREATE. Before grants, the [offline disposable provisioner](../tests/security-foundation/database.ts) revokes PUBLIC/runtime defaults, validates every definer function, transfers it to the nonlogin owner and grants exact capabilities. Runtime cannot SET ROLE migrate/guard or disable/replace triggers. The staff pool checks actual identity/attributes on every checkout, not merely URL spelling. Cluster role creation and ownership transfer require the separate owned bootstrap process; they are not web migrations.

Existing catalog URL guard/client and accepted local demo wiring remain unchanged, as requested. No new foundation client accepts their bootstrap-oriented URLs, and no production/app credential cutover is claimed. The ordinary storefront remains fixture-backed without DB credentials. Operational reader/auth wiring and secret custody are later integration gates, not evidence implied by this new profile.

## Serialization and Owner invariant

Supported security isolation is **READ COMMITTED only**, checked before protected lookup and mutation. REPEATABLE READ/READ UNCOMMITTED/SERIALIZABLE fail with0A000: a row mutex without a conflicting write does not refresh an old repeatable-read snapshot. This is a deliberate fail-closed contract, not an untested claim that every isolation level works.

Statement-level BEFORE triggers acquire the governance singleton before tuple mutations on provider User/Account/TwoFactor/Session and staff principals/grants/admissions. Reviewed staff/worker/denial functions use the same gate. Never hold a staff-client transaction while awaiting a provider client that needs the same gate.

An eligible Owner is active, has an Owner grant, verified provider email, enabled and verified nonempty TOTP factor, and a present credential password hash. An invitation/pending principal is not eligible; zero login sessions do not change eligibility. After activation every relevant statement must retain at least one eligible Owner. Backstops cover status/grant changes, provider identity cascades, email/factor flags, final factor and credential deletion/reset, self-target and bulk paths. Role replacement inserts retained/new grants before deleting obsolete ones to avoid a false transient last-Owner violation.

The only modeled initialization sequence is offline uninitialized->bootstrap->active, with exactly one eligible Owner at activation. It is exercised only on synthetic disposable fixtures; no operational command or identity is provided. Normal roles cannot change governance. Recovery transitions and singleton deletion are rejected. Offline DB-owner tampering is outside the runtime guarantee.

Sensitive writes lock first, then recheck actor/session/current version/admission/permission/recent MFA. Check time is a single `clock_timestamp()` captured **after governance wait**, not statement-start time. Revocation winning the gate prevents the write. A write already committed before a later revocation remains committed; no retroactive guarantee is made. Deadlocks/timeouts/errors are denial, not unbounded retries or a permission fallback. The global security gate is conservative serialization for this small foundation, not a high-throughput design claim.

## Durable transitions, audit and partial failures

1. Provider DML's reviewed identity-side trigger appends a redacted transition **inside the same provider transaction**. If insertion/backlog checks fail, provider mutation rolls back. Ordinary auth cannot edit/delete source evidence. Pending/blocked relevant events immediately deny admission.
2. A separate worker-purpose transaction rechecks the event, increments/revokes local authorization as appropriate, appends success audit and marks the event processed together. It never grants roles, creates a principal/admission, marks MFA verified or activates governance. A unique transition audit key and processed-state check make replay idempotent.
3. Source and local transactions are **not atomic together**. A crash after source commit leaves a durable pending event and denied access; a fresh worker can process it. Failed local audit insertion rolls back local version/admission/processing state. Source changes already committed are not claimed undone.
4. Pending selection examines state, not a maximum sequence-ID watermark. At most100IDs per call,1000pending/blocked records, five recorded failures before blocked. Queue saturation rejects new provider writes; blocked evidence continues denying access until separately reviewed offline resolution. Source IDs/kinds are bounded; no provider row JSON or secret values are copied. Worker scheduling, incident monitoring and offline backlog/purge operations are not activated.
5. Staff status/role/admission-revocation changes and trigger-generated success audit are atomic on the same SQL connection. Runtime cannot UPDATE/DELETE/TRUNCATE success or denial evidence. Mutable delivery metadata is not confused with immutable success facts. The guard's authority is reachable only through the reviewed function surface.

Denied attempts are recorded after rollback in a separate bounded durable denial sink. Outcomes distinguish ordinary denial, a confirmed pre-COMMIT rollback, and unavailable/ambiguous completion; a failed COMMIT is never mislabeled as certainly rolled back. Required audit failure denies the operation. Generic safe errors do not serialize SQL, connection strings, user claims, passwords/hashes, session tokens, factor/backup codes or provider payloads. Shared service roles enforce purpose isolation, not independent end-user authentication; the future trusted SDK resolver remains essential.

The opt-in [durable denial spool](../src/server/security/denial-spool.ts) uses a fixed ignored owned directory, validated marker/physical paths, exclusive nonblocking lock, strict four-field redacted envelope,1MiB cap and fsync. Existing truncated/invalid journals are rejected, never repaired/truncated/overwritten. POSIX initialization syncs the project parent, .local and spool directory entries; Windows ACL/directory-fsync and physical storage guarantees remain explicit platform limitations. A stale lock/saturated/unavailable spool is failure, not permission. Both sinks failing yields503 and a latched non-sensitive evidence-unavailable status; no unlimited in-memory queue or false durability claim. No journal/credentials/database files are uploaded.

## Review and acceptance boundaries

Independent source review identified unsupported-isolation snapshots, statement-start expiry after waiting and missing parent-directory fsync. Fixes require deterministic isolation/deadline regressions plus final Windows and actual Linux CI evidence. [Validation](./batch-3-2b1-validation.md) records only executed results and remaining gates.

This foundation is NOT browser/RSC/Action certification, real TOTP admission, invitation ownership proof/delivery, sole-Owner recovery, key rotation/restore, retention/legal approval, production privilege rollout or load certification. TOTP remains phishable. Actual Owner identity, independent proof/operators/approvals, real delivery/recovery/key custody, privacy/retention and final runtime policy require explicit owner decisions. Keep the implementation PR Draft; do not merge or begin B.2.
