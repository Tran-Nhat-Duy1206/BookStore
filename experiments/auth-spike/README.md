# Isolated authentication security spike — not an application

Batch3.2A only. No HTTP listener, application auth route, login UI, customer identity or operational administration is installed. Nothing under this directory is imported by the storefront. See [security plan](../../docs/batch-3-2-security-plan.md), [ADRs](../../docs/adrs.md) and [actual validation](../../docs/auth-spike-validation.md).

## Scope

Dev-only Better Auth1.7.18 + Prisma adapter1.7.18 + OTP utility0.5.1. Existing Next16.4.5/Prisma7.10.1/pg8.23.1 pins remain. The real Next adapter receives in-memory Request/Response objects at an `.invalid` origin; this is not proof of browser/RSC/server-action integration.

The provider schema and generated client are independent from the application Prisma schema/migrations. Original catalog SQL/seed are replayed only into a fresh disposable experimental database to test reader-role DTO parity. Provider-owned Session tokens are private harness data; minimal admission output contains no bearer secrets. Never expose the raw provider session DTO as an app API.

## Run on this Windows host

From the physical repository root, using already installed PostgreSQL18 executables only:

```sh
pnpm install --frozen-lockfile
pnpm auth:spike:local:init
pnpm auth:spike:local:start
pnpm auth:spike:typecheck
pnpm auth:spike:test
pnpm auth:spike:local:stop
```

Init checks55434 availability, refuses unmarked/existing state/env overwrites and creates a fresh cluster under the ignored local directory. It writes random local-only credentials to ignored `.env.auth-spike.local`/local state; never print/read/upload these secret files. This does not read/change the catalog environment or services. Stop is marker/path/port/binary scoped. Windows ACLs are inherited; file mode0600 is best effort, not a Windows ACL hardening claim.

The tests load only the separate spike env, without overriding explicit environment variables. The base URL requires bootstrap user `bookstore_spike_bootstrap`, loopback55434 + `bookstore_auth_spike_test`, or CI55435 + `bookstore_auth_spike_ci`. The test helper creates new random databases/roles, validates matching suffix/purpose, applies explicit privilege grants and drops only in-memory/marker-owned resources after all clients close. No FORCE, global role reset, connection termination or existing project database.

## Evidence and limitations

```sh
pnpm auth:spike:test --reporter=default --reporter=junit --outputFile=auth-spike-test-results/security.xml
```

The independent spike CI job provisions its own PostgreSQL18.3-alpine service on55435 and retains JUnit7days. Existing frontend/catalog jobs remain. A fourth, separate full-audit check preserves the actual audit JSON and exits nonzero on findings: no ignore/continue-on-error converts the known moderate finding into success. No credentials, database files, provider response payloads, OTP seeds or backup codes are uploaded.

Origin/CSRF and DB rate limiting are explicitly enabled in tests: library test-mode defaults are not a security guarantee. Synthetic client IP headers exist only to exercise independent/concurrent rate buckets, not as trusted production browser headers. Candidate8h/30m/5m timings are simulations requiring final approval.

Offline fixtures use library credential APIs with a never-mounted permissive instance; the runtime-like instance closes registration and unused methods. This does not implement invitation/email ownership or real bootstrap. The admission proof checks live staff state/MFA/version and transactional audit, but is not complete RBAC, Owner governance, recovery, rate-limit operations, durable denial logging or production BFF code.

Full dependency audit is **not clean**: [snapshot](evidence/dependency-audit.json) and [advisory analysis](../../docs/auth-spike-advisories.md) retain one open moderate baseline minimatch tooling finding. Do not hide it with a cross-major override or describe green test jobs as a full security clearance.
