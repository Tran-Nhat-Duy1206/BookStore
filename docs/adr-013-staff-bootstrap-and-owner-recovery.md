# ADR-013 — Staff provisioning, initial Owner and recovery

Status: proposed operational design, not implemented. Batch3.2A uses synthetic offline provisioning only.

## Closed provisioning

No public registration, first-user Owner rule, automatic social/magic-link/passkey/anonymous provisioning or account linking. A provider User without a separately approved StaffPrincipal never becomes staff. Roles/status/admission fields are server-owned, not provider-client additional fields. Future account email changes need their own verified ceremony, not a generic SDK endpoint.

Bootstrap the first Owner through a separately invoked offline command, never an HTTP handler. Use a provider-supported credential operation, not homemade password cryptography or a universal seeded password. The experiment's permissive library instance exists only in memory behind migration credentials and is never mounted by the Next adapter. Runtime registration remains disabled. The spike's `example.invalid` fixtures do not prove real staff email ownership or invitation delivery.

A full invitation must have an unpredictable, expiring, single-use protected token, bound to its intended verified identity and server-stored role grant. Invite redemption must not accept role or actor claims from the browser. Completion requires verified-factor enrollment before ordinary staff activation. Provisioning failures stay pending/denied; retries are idempotent and cannot create unapproved duplicate identities.

## Initial single-Owner protection

The owner may initially be the sole Owner; this is a deliberate availability risk, not an implicit demand for invented second staff. A pending/unverified invite is not an eligible replacement Owner. An eligible Owner is enabled and MFA-enrolled; having zero current login sessions does not make that Owner ineligible.

A governance singleton serializes bootstrap and every change that removes Owner eligibility, including role removal/demotion, disablement, identity deletion and final-factor removal/reset. Recheck the final eligible count within the same transaction. Ordinary operations must never leave zero eligible Owners. If provider internals can mutate eligibility outside that protocol, add a reviewed DB-side backstop or reject the integration; UI checks/count-then-update are insufficient.

Do not add operational staff CRUD merely to demonstrate this design. Full implementation must prove deterministic races between all Owner-affecting paths and actor revocation, including indirect library endpoints.

## Sole-Owner lost-factor recovery

Normal web routes cannot disable the last Owner's MFA or promote a recovery session into admin. Before implementation, the owner must approve the external ownership-proof mechanism, operators and evidence retention for an offline break-glass procedure:

1. Verify the requesting project owner through the agreed independent channel; record approvals without embedding secrets.
2. Enter an explicit recovery-locked governance state that denies privileged runtime operations; revoke old admission/sessions and increment authorization version.
3. Issue a short-lived purpose-only recovery capability through the maintained provider mechanism. Do not return a working administrator session.
4. Reestablish verified factor/eligible ownership; invalidate old factors/codes and prove replay/revocation behavior.
5. Commit recovery audit and restore normal governance only when eligible-Owner invariants hold. Failure stays locked, never bypasses security.

This is not a hidden universal password, permanent bypass flag or public bootstrap/recovery endpoint. Key loss/database restore and real delivery are separate operational concerns. The spike demonstrates backup-code recovery restriction, not this complete last-Owner ceremony.

## Approval gates

Owner decisions: actual initial Owner identity/count; invitation and recovery delivery; ownership-proof/dual-control expectations; single-Owner locked recovery tradeoff; TTLs and audit/privacy retention. No real staff data, mail service, keys, production credentials or paid infrastructure is provisioned by this spike.
