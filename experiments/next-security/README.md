# Isolated Next security experiment

Nonshipping synthetic B.2d harness selected in [ADR-019](../../docs/adr-019-isolated-next-security-integration.md). It does not enable ordinary application admission or provide a login/admin interface.

- Its own Next project/build/type configuration is independent of the root storefront. No credentials belong in build environment, generated artifacts or client props.
- `%5F_bookstore_next_auth` and `%5F_bookstore_next_security` intentionally encode the FIRST underscore in filesystem names: Next private underscore folders otherwise have no routes. Public URLs remain `/__bookstore_next_auth/*` and `/__bookstore_next_security`.
- The five exact POST Route Handlers use canonical existing facade operations; no catch-all SDK handler. The raw trusted HTTPS host must validate original wire framing/Origin/CSRF/bytes before Next dispatch. Handlers independently check Next cookies and declared byte length before facade invocation.
- The dynamic security page reads live state on every render. Three native Server Actions (`probeAction`, `revokeSelfAction`, `signOutAction`) independently validate context, cookies and purpose-bound CSRF. Native multipart forms and enhanced client invocations use those SAME actions. No actor/session/target arguments or action wrappers.
- The sole client DTO contains public non-authentication anti-CSRF nonces. No provider/session identifier, cookie value, OTP, evidence handle, provider secret or claimed actor is rendered. Completion text does not grant application admission.
- Invalid context/CSRF does not clear cookies. Valid signout clears every owned secure same-scope cookie even when persistence is unavailable.
- Instrumentation initializes only through the parent's privately installed host. Direct `next start` has no trusted host/context and must fail closed before SQL.

Source implementation is not executed evidence. Independent typegen/typecheck/production build, root exclusion, real TLS/ALS/native form/Flight/direct Action and no-forwarding/resource/cookie/cache tests remain mandatory. Stop if any selected boundary cannot actually be established. No retries, skips or TLS bypass.
