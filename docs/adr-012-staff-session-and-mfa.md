# ADR-012 — Staff admission, session and MFA policy

Status: candidate full-implementation design; Batch3.2A may simulate and test it only. No application authentication is enabled.

## Authentication is not authorization

An authenticated provider identity/session is necessary but insufficient. A staff guard must read current StaffPrincipal state and an admission record bound to the same provider user AND session. Database constraints should reject cross-account associations. Only a successful server-observed verification flow can write MFA admission; caller-supplied flags, an enrolled-factor boolean, cookie presence, provider session age or remembered-device state cannot.

First-factor, enrollment and unapproved identities have no administrative access. TOTP is mandatory before normal admission. Backup-code verification leads only to recovery state, invalidates previous authorization versions and must never be treated as ordinary administrative login. Full recovery requires a separately reviewed verified-factor replacement flow. The spike does not implement that complete ceremony.

## Candidate session values

Proposed, requiring final owner approval:8h absolute expiry,30m inactivity,5m recent verified MFA for sensitive account/access changes. The experiment configures/measures/simulates these numbers only in its fixture. This does not create runtime policy or approve operational endpoints.

Use database sessions, no secondary storage, cookie cache or trusted-device bypass. Rotation/revocation and expiry must be tested with retained old cookies. Authorization versions bind admission to current access; any access/factor/recovery/status change invalidates prior admission. A stale provider session must not automatically regain admission after revocation.

Sensitive writes revalidate actor/session/version/MFA inside a consistent transaction/lock protocol. Revocation winning the lock first prevents the write; already committed writes cannot be retroactively undone. Read access is rechecked on each protected request, not just a persistent Next layout. Request-local memoization must not be reused for commit authorization.

## Transport controls

A future BFF must allowlist authentication paths/methods, exact origins and callback destinations; enforce CSRF and shared abuse budgets; forward cookies safely; normalize errors; and project minimal DTOs without tokens/provider internals. Direct `auth.api` calls are internal functions, not an HTTP CSRF/origin/rate-limiting boundary. Official docs warn they bypass those checks. Offline provisioning may use them with no inbound request; a BFF may not assume they authorize a request.

The spike invokes the actual Next handler in memory. Explicitly set origin/CSRF checks on, even in test mode, and explicitly enable database rate limiting. Synthetic IP metadata represents independent test clients; it is not a production trusted-proxy design. A real deployment must derive client IP from a reviewed socket/proxy chain, not accept the experimental header.

Cookies must be Secure/HttpOnly/host-only/SameSite with compatible host-prefix/path rules under HTTPS. No auth localStorage, wildcard origins, public cache or secret-bearing errors. Local HTTP exceptions, server-action/RSC cookie forwarding, password/email ownership/recovery delivery, phishing-resistant factors and browser/proxy behavior require additional validation before a full release. TOTP is not phishing resistant.

## Library storage and refresh review

Keep provider-owned credential/session/factor schemas aligned to the selected version. Do not pretend raw provider tokens are hashed when the actual adapter stores token strings. Restrict table access and keep keys outside the database. Explicit library-encrypted backup storage avoids its plaintext option. Test redaction and session DTO projections separately.

Even session lookup can refresh/clean provider state. It uses the auth-purpose client, never the catalog readonly factory. The spike disables sliding refresh; the future refresh strategy and absolute-cap enforcement need dedicated RSC/server-action integration tests.

Sources: [sessions](https://better-auth.com/docs/concepts/session-management), [2FA](https://better-auth.com/docs/plugins/2fa), [security](https://better-auth.com/docs/reference/security), [advisories](./auth-spike-advisories.md).
