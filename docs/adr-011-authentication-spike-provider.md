# ADR-011 — Better Auth selection for the isolated security spike

Status: accepted for Batch3.2A evaluation only; full Batch3.2 implementation and exposure remain unapproved.

## Context and pins

Baseline main `ce8165d8f7f8905378b36728e6c07b04ba20d9e9` contains the accepted catalog foundation. The owner authorized an isolated Better Auth spike, initially considering1.7.18. Official release metadata identifies1.7.18 as stable, published2026-11-05. Core/adapter peer ranges include Next16, React19, Prisma7, pg8 and Vitest5. This is compatibility evidence to investigate, not proof of the complete application integration.

Selected experimental dev dependencies:

- better-auth1.7.18, @better-auth/prisma-adapter1.7.18.
- @better-auth/utils0.5.1 (the library's own maintained OTP/Base32 utilities for synthetic authenticator tests).
- Existing Prisma/client/adapter-pg7.10.1, pg8.23.1, Node24.19.0 and Next16.4.5 remain unchanged.

No prerelease, custom password cryptography or new SaaS is needed. The library uses its maintained credential hashing and protected TOTP/backup storage. Minimal plugin surface: two-factor only; no OAuth proxy/provider, device login, magic-link/email-OTP, organization, SCIM, API-key, social, anonymous or admin/impersonation plugin. Encrypted backup storage is explicit; no secondary session storage or cookie cache.

## Decision

Place all executable experiments under [auth-spike](../experiments/auth-spike/provider.ts), with a separate generated Prisma client/schema and test configuration. Dependencies are dev-only, not imported by any application module. Keep the storefront TypeScript build independent from experiments; typecheck the entire spike separately rather than skipping its errors.

Invoke the real Next adapter with in-memory Request/Response objects at an `.invalid` logical origin. Never start an authentication HTTP listener or mount a Next route, login UI or working administrative application. Offline provisioning is a separate, never-mounted library instance; permissive signup is not exposed by the restricted instance.

Use a brand-new project-owned PostgreSQL18 cluster on checked-free55434, or a disposable CI service on55435. Do not use5432 or the catalog instance on55432/55433. Database names/roles/cleanup have exact experimental allowlists and ownership markers. Tests use synthetic `example.invalid` identities only.

## Advisories and acceptance

[Advisory review](./auth-spike-advisories.md) records publisher/global inventories, metadata discrepancies and configuration-related regressions. A core release outside known affected ranges is not a security certification, nor proof about sibling/transitive packages. Full development+runtime dependency audit must be reported, including existing tooling debt; a production-only audit is insufficient for this dev-only spike. A separate CI audit check retains JSON and its actual failure without suppression, independent from passing compatibility/security tests.

The [security plan](./batch-3-2-security-plan.md) remains the intended full boundary. Spike evidence must establish password/TOTP enrollment/verification, first-factor denial, backup recovery restrictions, session expiration/revocation, suspended/disabled staff denial, registration/alternate-path closure, least privilege and fail-closed audit admission. Record actual failures rather than relaxing checks.

## Limits

In-memory route-adapter behavior does not prove Next server-action/RSC cookie forwarding, browser CSRF, proxy/header provenance, deployment or production hosting. No email delivery/identity verification, complete invitation ceremony, recovery UI, real staff account, operational authorization or production migration is installed. Full implementation needs separate approval and further adversarial tests.

Sources: [release](https://github.com/better-auth/better-auth/releases/tag/v1.7.18), [Next integration](https://better-auth.com/docs/integrations/next), [Prisma adapter](https://better-auth.com/docs/adapters/prisma), [security](https://better-auth.com/docs/reference/security).
