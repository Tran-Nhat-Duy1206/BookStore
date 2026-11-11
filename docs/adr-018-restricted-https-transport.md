# ADR-018 — Restricted, default-off HTTPS authentication transport

Status: **B.2c design selected after bounded source review; implementation and actual HTTPS/browser acceptance pending.** Baseline main `4dcf297af70cd5ba33e54ae6154ae9d3b1308830`, normal PR#6 merge of reviewed `a75adbdbc7a11a549576566124e46c308e1a3848` after seven successful checks in CI42844425720. Branch `feat/phase3-b2b2c-secure-transport`. The owner approved B.2c ONLY. No B.2d/RSC/Action integration or operational authentication is approved.

## 1. Accepted foundation and evidence limits

Review ADR-011–017, the complete [preserved B.2 plan](./batch-3-2b2-plan.md), actual [B.2b composition](../src/server/security/provider-proof.ts), [SQL authority](../src/server/security/admission-authority.ts), immutable001–006 and [B.2b validation](./batch-3-2b2b-validation.md). Graph tools are unavailable: bounded direct-source fallback, no index/coverage/completeness claim. Independent read-only transport and TLS reviews inform this design; they did not execute TLS, browser, database or acceptance tests.

An unexpected local next-env generated-import change was detected before merge. Work stopped; the owner explicitly approved restoring ONLY its two generated imports. Merge gates were rechecked clean, PR#6 readied and normally merged, main/local/remote synchronized, merge tree identical to reviewed HEAD, and this branch created. No unapproved local change was overwritten.

B.2b remains the ONLY MFA/admission authority: actual maintained SDK verification plus protected database state, original approval generation/version/lineage, pre-SDK shared replay burn, one-use CAS, current committed cookie/session lookup and transactional finalization/audit. Cookie presence, a browser claim or transport state never creates proof. Keep the normal application kernel resolver null.

## 2. Activation and process boundary

Implement a **standalone direct Node HTTPS TEST listener**, not Next auth routes or a proxy/catch-all. Importing the module performs no I/O or startup. Enabling requires BOTH NODE_ENV=test and a separate explicit test-only opt-in, plus exact validated configuration. Production/ordinary development/build calls deny BEFORE SQL pools or listening. No fallback secret, environment URL/provider/hook/resolver injection, privileged SQL credentials or HTTP downgrade.

Fixed private hostname `bookstore-transport.invalid`, privately resolved to127.0.0.1 by Node test lookup and Chromium host-resolver rules; never change OS DNS/hosts. HTTPS origins allow only explicit dedicated test ports3443/3445; plain HTTP3444 is a separate deny-only fixture with NO auth/provider/SQL use. Bind only127.0.0.1 exclusively; reject occupied ports rather than reuse/kill another process. Check actual encrypted local/remote socket provenance and exact Host+port. Host-only cookies do not isolate ports; every instance independently validates its exact Origin/Host.

Validate exact own-key plain config, three existing purpose URLs to the SAME owned disposable55436/55437 database, high-entropy provider secret, direct test CA/leaf/key, current certificate dates, key match, direct trusted signature/chain, serverAuth EKU and explicit non-wildcard DNS SAN BEFORE constructing authority or listener. Native SDK's fixed internal .invalid origin stays private and unchanged. No generic HTTP handler/provider instance is exported.

No application imports, operational admin/login UI, real accounts, Owner bootstrap, invitation/recovery activation, business/customer/commerce mutation or deployment. Dependencies remain at exact pins/dev-only: this nonshipping test transport does not require runtime promotion. Existing seven CI definitions and all assertions stay; add an eighth isolated HTTPS job.

## 3. Endpoint manifest

All authentication paths under `/__bookstore_test_auth` require exact POST, JSON UTF8, mandatory Origin/Host/CSRF validation and bounded bodies. No query string, aliases, redirect or callback inputs.

| Exact path     | Input                       | Required state / operation                                                               | Minimal response / cookies                                                                                                 |
| -------------- | --------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/password`    | email,password strings only | Closed approved synthetic principal; private real SDK password plus B.2b primary binding | Generic denied/rate/unavailable or mfa-required; clean owned-cookie state then native challenge                            |
| `/totp/verify` | code: six ASCII digits      | Exact same fresh primary cookie; B.2b reserve → real SDK → ready → immediate finalizer   | Verified-test-session only after commit; validated FINAL native cookies                                                    |
| `/step-up`     | code: six ASCII digits      | Existing normal unexpired admitted test session; same original epoch/version             | Verified recent MFA only; no absolute/idle reset; finalizer before cookie delivery                                         |
| `/session`     | empty object                | Real SDK user/session resolution plus live database guard                                | Verified/anonymous test state only; NEVER touch idle, refresh or Set-Cookie                                                |
| `/sign-out`    | empty object                | Any presented own cookie context, including first-factor/non-admitted                    | Deny-only cancellation then private SDK sign-out; ALWAYS clear same-scope owned cookies, honest unavailable on uncertainty |

One non-authentication GET `/__bookstore_test_probe` may serve an inert blank document ONLY in this explicitly enabled isolated process for real browser fetch/cookie tests. It contains no login UI, credentials or setup authority and never calls provider/SQL; no default storefront route is added. HEAD/OPTIONS/other methods deny; no generic GET handler.

No enrollment, signup, factor disable, backup, recovery, metadata, callback, OAuth or native Better Auth path is exposed. No public touch/revoke-target/all-device endpoint. No Location header: all redirect/callback/returnTo/next fields or parameters are rejected, not forwarded. Only static minimal JSON state is projected; never IDs, raw provider records, evidence handles, authentication tokens, factors or errors.

## 4. Origin and CSRF protocol

Select the complete **custom-header/non-simple request CSRF protocol**, not a claimed secret-token flag: exact configured HTTPS Origin AND independent exact Host, exactly ONE `X-Bookstore-CSRF: 1`, JSON-only POST, no CORS permissions or approved preflight, reject inconsistent Fetch Metadata when present. Missing/null/foreign/duplicate Origin or CSRF header denies BEFORE facade/SQL. Apply to password, session, step-up, TOTP and sign-out. Browser cross-site HTML cannot supply JSON+custom header; cross-site script preflight is denied and Origin independently rejects it. Raw clients can forge these headers but still require genuine password/TOTP/cookies; this protocol is CSRF protection, not user/MFA identity.

No CSRF bootstrap/token in JSON/JS-readable auth cookie is necessary. Native SDK Origin/CSRF checks stay enabled but validate only private synthesized calls: do not misrepresent those as validating inbound browser Origin. No Referer, proxy or body fallback.

## 5. Raw HTTP and resource contract

Compare raw request target with literal ASCII manifest BEFORE URL parsing/decoding. Reject percent/double encoding, encoded separators, dot segments, backslashes, Unicode/case/trailing/double-slash aliases, absolute-form targets, query/fragment, method overrides and controls. No framework normalization is relied upon.

HTTP1 only. Inspect raw headers: one exact Host/Origin/CSRF/Content-Type/Content-Length and at most one Cookie header, no duplicates/conflicting values, bounded header count/bytes. Reject Transfer-Encoding, CL+TE, trailers, Upgrade, compression and Expect/100-continue ambiguity. Require canonical bounded decimal Content-Length and exactly received bytes≤1024. Fatal UTF8, flat exact-schema JSON, duplicate/escaped-duplicate keys and unknown/nested/identity/session/role/MFA/redirect fields rejected; canonical JSON round-trip is an acceptable deliberately narrow schema encoding, not a custom authentication parser. Password content is not normalized or logged.

Set bounded TLS/header/body/request/keepalive deadlines, max requests/connections,16inflight with queue0 and cheap local ingress caps before PG. These are availability bounds, not global abuse authority. Parser/TLS/client errors produce fixed secret-free errors; never dump rawPacket, request target, headers, body, provider/PG errors or peer certificate/key data.

All responses including errors use private,no-store (no shared auth cache), static minimal envelopes, no CORS/redirect/caching authority. No polling/session lookup activity touch.

## 6. Cookie-state and commit protocol

The B.2b database binds the ENTIRE canonical allowed SDK cookie jar, sorted with localeCompare, not just a token or session ID. Transport must preserve that exact contract.

- Derive a bounded frozen readonly NAME/scope manifest from the fixed native instance; never expose its context, methods, records or keys. Only explicitly expected session_token/two_factor positive cookies may be delivered. Helper/cache/trust names are deletion-only; unknown SDK additions fail closed rather than dynamically become transport authority.
- Accept no duplicate Cookie names, malformed/oversized values or cache/trust/identity authority. A password call starts native state EMPTY. Its response explicitly clears all stale owned scopes before new challenge projection; coalesce clearing/replacement into ONE final Set-Cookie per name. A fresh login does not claim to revoke an unrelated prior session merely by clearing its cookie.
- Validate EACH SDK Set-Cookie separately: exact known name, unique nonconflicting attributes, Secure, HttpOnly, SameSite=Strict, Path=/ and NO Domain. Handle Expires comma as one attribute, never split/flatten Set-Cookie on commas or rewrite signed values/path/names.
- TOTP and step-up return ready evidence only. Apply validated updates including deletions to the exact input canonical jar; privately call finalize with that FINAL jar IMMEDIATELY, before emitting any new cookie or success body. No browser finalize endpoint/round-trip, no evidence capability in JSON/header/URL/artifact, no use of stale JSON token.
- Every provider/ready/finalizer/audit/commit-unknown failure discards ALL NEW cookies; only explicitly permitted same-scope clearing is safe. No retry/reverification or replay of a retained bearer response. SDK side effects and precommitted replay/budget charges are not rolled back by local failure. Ambiguous delivery may require a fresh ceremony.

## 7. Narrow additive007 justification: denial, never positive authority

Keep001–006 immutable. Additional transport operations need only exact STAFF EXECUTE wrappers owned by the same NOLOGIN guard, SECURITY DEFINER SET search_path=pg_catalog; no new role, raw table/column rights, private schema USAGE, verifier grants or arbitrary MAC oracle. Verifier's seven signatures stay unchanged.

**staff.cancel_transport_context(canonical_cookie text)**: reject empty/invalid/oversized credential before MAC; unknown valid nonempty cookie is indistinguishable generic success. Under governance/READ COMMITTED collect ALL matched attempt-derived session IDs from original/final cookie HMACs plus matched control-cookie HMACs, then revoke bound/inflight/ready/consumed attempts, retire those exact controls/session observations and revoke their admissions. No caller user/session/target/mode/IP/time input. Inflight without a final SID becomes terminal so later SDK success cannot issue. Fixed redacted transport.cancel audit and cancellation commit atomically; audit/storage uncertainty is not success. NEVER reset key, replay burns, budgets, versions or approval generations.

Private facade signOut calls cancellation and RELEASES its transaction, then calls the EXISTING fixed private native SDK signOut for provider-session deletion. No generic SDK/handler export. Always clear owned browser scopes at the transport, even if either stage fails; return honest generic503 when required persistence outcome is uncertain. No all-device guarantee. First-factor copied-cookie replay after successful cancellation cannot issue evidence, even if native challenge data remains.

Precise limit: logout cancels presented/derived cookie contexts and serialized TOTP/finalization, not an unrelated anonymous password operation whose new challenge has not yet been bound/delivered. Never cancel all users/IPs/empty cookies to pretend otherwise. A delayed password response can install a NEW challenge, but needs subsequent explicit fresh TOTP/use; it is not an already verified session revived by logout. Test response-order races. Cancellation of known inflight/consumed MFA must make even subsequently delivered session cookies non-authorizing.

**staff.reserve_transport_request()**: no arguments, one fixed domain-separated common-loopback/unknown-IP key in existing protected budgets,120requests/15min synthetic policy, anchored window and post-wait database clock, governance first, no reset/refund/fallback. Applies before facade/crypto to session traffic too; sign-out cancellation/clearing is attempted even when quota denies. Existing B.2b password5/account/MFA10/account plus20common-IP attempts PER password/MFA kind remain separate and unchanged; native limiter remains ON with tracking and ipAddressHeaders=[]. This shared ingress limit is not a complete DDoS guarantee.

Reject all supplied Forwarded/X-Forwarded/Real-IP/CDN/spike IP override variants; actual socket proves loopback only, not distinct remote humans. No caller header reaches SDK or selects budget identity. No production proxy attribution is claimed.

## 8. HTTPS and actual browser evidence model

Fresh per-run OpenSSL-generated private CA and leaf; no homemade PKI/TOTP math. Node clients use explicit per-agent CA with rejectUnauthorized=true, normal hostname verification and private DNS lookup. Negative tests require untrusted/unrelated CA, wrong SAN, expired/not-yet-valid chain, plaintext on TLS and invalid key/config denial. Keys live only in marker-owned ignored run directories with scoped Windows ACL/POSIX permissions and verified-path cleanup; never upload PEM/keys/cookies/traces/storage-state.

**Local Windows evidence is real CA-validated Node HTTPS/wire/cookies, not a claim Windows Chromium trusts a new CA.** Mandatory Linux CI browser command separately proves actual Chromium cookie/JS/SameSite/TLS behavior using a fresh isolated HOME/userDataDir and NSS root database, not OS/global stores. NSS path varies by browser version; provision only marker-owned test HOME paths according to [Chromium Linux certificate documentation](https://chromium.googlesource.com/chromium/src/+/lkgr/docs/linux/cert_management.md). No ignoreHTTPSErrors, blanket certificate flags, system trust import, TLS verification disable or silent API-jar fallback. The browser command fails outside its required environment instead of skipping tests. Eighth job MUST run both suites; browser trust failure is a blocker, not permission to bypass validation.

Secure cookies on localhost/127 are specially allowed over HTTP by the pinned Playwright jar; do NOT claim HTTP127 withholding as browser proof. Use bookstore-transport.invalid privately mapped to127 for genuine Secure-cookie withholding to deny-only HTTP3444. Actual browser checks HttpOnly document.cookie absence, HTTPS round-trip, host-only alias isolation, SameSite/cross-origin/preflight rejection, final rotation/stale replay and same-scope sign-out clearing. No auth-flow trace/video/screenshot/storageState artifacts; retain redacted static-name JUnit only.

## 9. Exit gates and exclusions

Actual configuration/TLS trust, strict ingress, CSRF/Origin, final cookie/ready/finalize ordering, pending cancellation races, shared multiworker/restart budgets/replay, generation/authorization changes, expiry/revocation, provider/audit failures, no-secret response/log evidence and default-off/production/build denial must pass. Add pristine001–007 and hardened006→007 preservation/ACL tests; append history expectations, never remove assertions or change accepted SQL. Preserve all seven jobs and add actual exact-final-HEAD eighth HTTPS acceptance with full unfiltered audit.

This design is NOT implementation correctness or executed HTTPS/browser proof. STOP if the chosen trust/config/peer/cookie boundary cannot actually be established. Keep the eventual B.2c PR Draft, do not merge and do not begin B.2d. Real identities/key custody/privacy/retention/operators/delivery/recovery/policy/deployment remain separate decisions. Vietnamese Cozy storefront unchanged.
