# Batch 3.2A — Better Auth advisory spike (bounded research)

## Status and decision boundary

Research snapshot: **2026-11-05**, for the separately authorized Batch 3.2A spike only. This is advisory/configuration research, **not implemented authentication, executed test evidence, an audit pass, or production approval**. Earlier project plans remain historical scope records; this narrow authorization does not activate Batch 3.2 generally.

Parent-selected pins: **Better Auth 1.7.18**, existing **Prisma 7.10.1** and **pg 8.23.1**. The [official release API](https://api.github.com/repos/better-auth/better-auth/releases/tags/v1.7.18) identifies v1.7.18 as published 2026-11-05T14:56:33Z, `draft: false`, `prerelease: false`. No dependency was installed or changed by this research. Exact installed/locked versions and adapter compatibility still require the parent's evidence.

Proposed surface: password + TOTP/backup-code 2FA + Prisma design, exercised through a **staff BFF/library handler in in-memory tests only**. No mounted HTTP server, Next.js auth route, production handler, staff/customer login activation, auth schema migration, database operation, email delivery or external provider is authorized here. Prisma integration is a design/compatibility target, not a claim that in-memory tests exercised PostgreSQL, transaction behavior, schema constraints or Prisma.

Explicitly exclude OAuth/social/generic OAuth/OAuth Proxy/OIDC provider/MCP, magic link, email-OTP sign-in, SAML/SSO, device authorization, organization, SCIM, API-key, admin/impersonation, anonymous, multi-session, passkey, phone, Expo/Electron and Stripe plugins. The email-OTP sign-in plugin is distinct from the two-factor plugin's optional OTP factor; neither email/SMS delivery nor passwordless/OTP-factor enrollment is proposed. No customer signup or commerce.

## Sources, method and counts

Official sources fetched read-only:

1. [GitHub global npm query for better-auth](https://api.github.com/advisories?ecosystem=npm&affects=better-auth&per_page=100): **27 records**, comprising **26 nonwithdrawn + 1 withdrawn duplicate**. All 27 records' package/range entries were inspected; the table below retains every ID, including excluded plugins.
2. [Publisher repository advisory API](https://api.github.com/repos/better-auth/better-auth/security-advisories?per_page=100): **49 published, nonwithdrawn records**. All package/range entries were inspected and compared by GHSA ID. **26 overlap** the global result; **23 additional IDs** appear below. Both API responses had no pagination `Link` header with `per_page=100` at retrieval. The HTML advisory index returned HTTP 504; the successful repository API was used instead.
3. The bounded union is therefore **50 unique IDs = 49 nonwithdrawn + 1 withdrawn duplicate**, not 27 distinct active vulnerabilities. An additional unreviewed alias discovered in targeted search is noted separately below and is not part of this two-query union.
4. [Separate npm query for @better-auth/prisma-adapter](https://api.github.com/advisories?ecosystem=npm&affects=%40better-auth%2Fprisma-adapter&per_page=100): **0 records**. Searching the 49 repository summaries/descriptions for `_query` or `prisma` returned **0 matches**. This does not establish absence of adapter vulnerabilities, and is not a full source review.
5. [Official security documentation](https://better-auth.com/docs/reference/security), [session management](https://better-auth.com/docs/concepts/session-management), [2FA](https://better-auth.com/docs/plugins/2fa), [rate limiting](https://better-auth.com/docs/concepts/rate-limit), and [Prisma adapter](https://better-auth.com/docs/adapters/prisma).
6. [Publisher November 3 security-release announcement, immutable source](https://raw.githubusercontent.com/better-auth/better-auth/ef8fe525d7c3786488e58ec9d8dcc2efa97e6a7f/docs/content/blogs/security-release-2026-11-03.mdx): describes **12** advisories fixed by 1.7.16 / 1.8.0-beta.5 and instructs upgrading the related Better Auth packages together. Its title/body date is November 3; frontmatter date is October 30. These 12 are not an additional count on top of the union.

**Bounded conclusion:** stable `better-auth@1.7.18` is outside every listed vulnerable range for that package in the global 27 and publisher 49. For sibling-only entries, compare the sibling's own version and enabled surface; upgrading core does not patch a separately installed older sibling. The proposed exclusions avoid those flows, not unknown vulnerabilities. No affected range in this bounded corpus requires rejecting core 1.7.18 for this isolated spike.

**Not exhaustive:** the global query defaults to reviewed package-indexed data and can lag publisher updates. Unreviewed/no-package records, other repositories, unpublished reports, future disclosures, transitive dependencies, Prisma/pg advisories, lockfile resolution and application logic are not comprehensively assessed here. No claim of “zero vulnerabilities,” future security, or complete ecosystem coverage is made.

## Global query: all 27 records

Ranges below are the **global API values** for `better-auth` unless stated otherwise; publisher corrections follow. Semicolon-separated ranges are separate release lines, not a continuous affected interval. “Excluded” means proposed configuration, not verified implementation. **1.7.18 is outside all core ranges in this table.**

| Advisory / severity | Global affected range → first patch | Relevance / required disposition |
|---|---|---|
| [GHSA-44jh-23m7-hpcf](https://github.com/advisories/GHSA-44jh-23m7-hpcf), low | `>=1.6.17,<1.7.7` → `1.7.7`; Drizzle same; Kysely `>=1.6.17,<1.7.0` → `1.7.0` | PostgreSQL concurrent database rate-limit counters. Described adapters are Drizzle/Kysely, not evidence of a Prisma-specific flaw. In-memory limiter avoids this database path but is per process. Test concurrency regardless. |
| [GHSA-r4xp-prcw-77qf](https://github.com/advisories/GHSA-r4xp-prcw-77qf), high | `>=1.5.0-beta.12,<1.7.7` → `1.7.7` | OAuth Proxy identity forgery with shared global/proxy secret, cookie state and implicit linking. Excluded. |
| [GHSA-965c-763c-88jm](https://github.com/advisories/GHSA-965c-763c-88jm), critical | `>=1.4.0-beta.18,<1.7.7` → `1.7.7` | Cross-purpose OAuth state accepted as magic link; account takeover. Both flows excluded. Disabling signup alone did not prevent existing-account takeover. |
| [GHSA-q84f-53jg-9ppm](https://github.com/advisories/GHSA-q84f-53jg-9ppm), high | `>=1.3.8-beta.3,<1.7.0-rc.3` → `1.7.0-rc.3` | Device approval lacked client/scope context. Device plugin excluded. |
| [GHSA-3q45-2fh7-66cj](https://github.com/advisories/GHSA-3q45-2fh7-66cj), withdrawn duplicate | `<1.4.2` → `1.4.2` | Withdrawn 2026-09-01, duplicate of GHSA-569q-mpph-wgww; do not count as another active issue. |
| [GHSA-qq9h-g4jm-xgf3](https://github.com/advisories/GHSA-qq9h-g4jm-xgf3), high | `>=1.1.3,<1.6.22` → `1.6.22`; `>=1.7.0-beta.0,<1.7.0-beta.10` → `1.7.0-beta.10` | Magic-link/email-OTP pre-account hijacking; excluded. Direct signup must still be blocked for staff-only design. |
| [GHSA-2vg6-77g8-24mp](https://github.com/advisories/GHSA-2vg6-77g8-24mp), low | `>=0.3.4,<1.6.11` → `1.6.11`; SCIM `>=1.6.0,<1.6.11` → `1.6.11` | Deleted-user sessions retained in secondary storage across admin/anonymous/SCIM deletion. Exclude these plugins and secondary storage; test deleted/inactive staff and stale cookies. |
| [GHSA-7w99-5wm4-3g79](https://github.com/advisories/GHSA-7w99-5wm4-3g79), high | Core `<1.6.11` → `1.6.11`; oauth-provider `>=1.6.0,<1.6.11` → `1.6.11` | Authorization-code concurrent redemption. OAuth provider excluded; publisher lists sibling only. |
| [GHSA-392p-2q2v-4372](https://github.com/advisories/GHSA-392p-2q2v-4372), high | Core `>=1.4.8-beta.7,<1.6.0` → `1.6.0`; oauth-provider `>=1.6.0,<1.6.11` → `1.6.11` | Refresh-token rotation family fork; excluded. |
| [GHSA-9h47-pqcx-hjr4](https://github.com/advisories/GHSA-9h47-pqcx-hjr4), high | `<1.6.11` → `1.6.11` | OIDC/MCP insecure algorithm/PKCE defaults; excluded. |
| [GHSA-86j7-9j95-vpqj](https://github.com/advisories/GHSA-86j7-9j95-vpqj), high | `<1.6.13` → `1.6.13`; `>=1.7.0-beta.0,<1.7.0-beta.4` → `1.7.0-beta.4` | OIDC/MCP JavaScript redirect-URI XSS; excluded. |
| [GHSA-g38m-r43w-p2q7](https://github.com/advisories/GHSA-g38m-r43w-p2q7), high | `<1.6.11` → `1.6.11` | OAuth auto-link to unverified local account. OAuth/linking excluded; email verification alone was not the old mitigation. |
| [GHSA-fmh4-wcc4-5jm3](https://github.com/advisories/GHSA-fmh4-wcc4-5jm3), high | `<1.6.11` → `1.6.11` | Organization invitation acceptance by unverified email match. **Publisher adds later regression through <1.7.16**; organization excluded. |
| [GHSA-pw9m-5jxm-xr6h](https://github.com/advisories/GHSA-pw9m-5jxm-xr6h), critical | `<1.6.11` → `1.6.11` | OIDC/MCP refresh grant missing confidential-client authentication; excluded. |
| [GHSA-cq3f-vc6p-68fh](https://github.com/advisories/GHSA-cq3f-vc6p-68fh), high | `>=1.6.0,<1.6.11` → `1.6.11` | Pending device-code approval/denial not bound to intended session; excluded. |
| [GHSA-p6v2-xcpg-h6xw](https://github.com/advisories/GHSA-p6v2-xcpg-h6xw), high | `<1.4.17` → `1.4.17`; `>=1.5.0-beta.1,<1.5.0-beta.9` → `1.5.0-beta.9` | IPv6 rotation/text forms bypass limiter; relevant. Validate normalization, prefix grouping and trusted client-IP handling. |
| [GHSA-wxw3-q3m9-c3jr](https://github.com/advisories/GHSA-wxw3-q3m9-c3jr), medium | `<1.6.2` → `1.6.2` | OAuth callback state mismatch with cookie state/no PKCE; excluded. |
| [GHSA-xg6x-h9c9-2m83](https://github.com/advisories/GHSA-xg6x-h9c9-2m83), critical | `<1.4.9` → `1.4.9` | Premature session cookie cache bypasses 2FA. Relevant regression class; **cache off** and assert no authenticated session before second factor. Publisher range differs. |
| [GHSA-x732-6j76-qmhm](https://github.com/advisories/GHSA-x732-6j76-qmhm), high | `<1.4.5` → `1.4.5` | Routing dependency double-slash normalization bypasses disabled paths/rate limits. Test raw alternate paths, not only BFF UI. |
| [GHSA-569q-mpph-wgww](https://github.com/advisories/GHSA-569q-mpph-wgww), high | `<1.4.2` → `1.4.2` | First external request can poison base path if base URL absent. Explicit static base URL; publisher patch is 1.4.3. |
| [GHSA-wmjr-v86c-m9jj](https://github.com/advisories/GHSA-wmjr-v86c-m9jj), low | `>=1.3.34,<1.4.0` → `1.4.0` | Forged multi-session cookies revoke arbitrary sessions; plugin excluded. Publisher lower bound differs. |
| [GHSA-99h5-pjcv-gr6v](https://github.com/advisories/GHSA-99h5-pjcv-gr6v), high | `<1.3.26` → `1.3.26` | Unauthenticated API-key creation; plugin excluded. Publisher patch is 1.4.0. |
| [GHSA-36rg-gfq2-3h56](https://github.com/advisories/GHSA-36rg-gfq2-3h56), low | `<=1.2.9` → `1.2.10` | Origin middleware open redirects. Validate URLs at BFF boundary; publisher patch is 1.2.11. |
| [GHSA-vp58-j275-797x](https://github.com/advisories/GHSA-vp58-j275-797x), high | `<=1.1.20` → `1.1.21` | trustedOrigins bypass/account takeover; exact origin allowlist and negative tests remain required. |
| [GHSA-hjpm-7mrm-26w8](https://github.com/advisories/GHSA-hjpm-7mrm-26w8), medium | `<1.1.20` → `1.1.20` | Scheme-less callback open redirect; reject protocol-relative/backslash/control/encoded-separator destinations. |
| [GHSA-9x4v-xfq5-m8x5](https://github.com/advisories/GHSA-9x4v-xfq5-m8x5), medium | `>=0.0.2,<1.1.16` → `1.1.16` | URL parameter HTML injection/reflected XSS; avoid rendering raw auth error/URL values. |
| [GHSA-8jhw-6pjj-8723](https://github.com/advisories/GHSA-8jhw-6pjj-8723), high | `<1.1.6` → `1.1.6` | Verify-email open redirect; no email callback activation in spike. |

### Publisher/global discrepancies: do not erase them

The publisher API and global API are separate snapshots, not interchangeable truth tables. Inspect the corresponding publisher URL by replacing the global advisory URL prefix with `https://github.com/better-auth/better-auth/security/advisories/` and retaining the ID.

- **GHSA-fmh4-wcc4-5jm3:** publisher includes `<1.6.11`, **`>=1.6.14,<1.7.16`**, and `>=1.8.0-beta.0,<1.8.0-beta.5`; patches 1.6.11, **1.7.16**, 1.8.0-beta.5. The global-only “fixed since 1.6.11” statement is incomplete.
- **GHSA-xg6x-h9c9-2m83:** publisher `>=1.4.0-beta.15,<1.4.6`, patched **1.4.6**, versus global `<1.4.9`, patched **1.4.9**.
- **GHSA-569q-mpph-wgww:** publisher `>=1.2.4-beta.10,<1.4.3`, patched **1.4.3**, versus global `<1.4.2`, patched **1.4.2**.
- **GHSA-99h5-pjcv-gr6v:** publisher `>=1.2.0-beta.18,<1.4.0`, patched **1.4.0**, versus global patch **1.3.26**.
- **GHSA-36rg-gfq2-3h56:** publisher `<1.2.11` → **1.2.11**, plus `>=1.3.0-beta.1,<1.3.0-beta.4` → 1.3.0-beta.4; global patch **1.2.10**.
- **GHSA-wmjr-v86c-m9jj:** publisher lower bound `0.4.14-beta.2` versus global `1.3.34`; both end before 1.4.0.
- **GHSA-7w99-5wm4-3g79:** publisher lists only oauth-provider `>=1.6.0,<1.6.11`; global also lists core `<1.6.11`.
- **GHSA-g38m-r43w-p2q7:** publisher additionally lists `>=1.7.0-beta.0,<1.7.0-beta.4` → 1.7.0-beta.4.
- **GHSA-vp58-j275-797x:** publisher additionally lists `>=1.2.0-beta.1,<1.2.0-beta.16` → 1.2.0-beta.16.
- **GHSA-hjpm-7mrm-26w8:** publisher additionally lists `>=1.2.0-beta.1,<1.2.0-beta.15` → 1.2.0-beta.15.

None of these disagreements changes the outside-range conclusion for stable 1.7.18. Do not recommend an older “minimum safe” version by flattening this table.

## Publisher API: all 23 additional IDs

These are **additional to the 27 global records**, not evidence that all their plugins are installed. For compactness, `B` below denotes an additional affected beta line `>=1.8.0-beta.0,<1.8.0-beta.5`, patched `1.8.0-beta.5`. Stable 1.7.18 does not belong to B. Package names apply to their own versions.

| Publisher advisory / severity | Affected package/range → patch | Spike relevance |
|---|---|---|
| [GHSA-g95c-wqvr-8c3j](https://github.com/better-auth/better-auth/security/advisories/GHSA-g95c-wqvr-8c3j), medium | core `<1.7.16` → 1.7.16; B | Admin `user:update` changes phone credentials; admin/phone excluded. |
| [GHSA-4wq4-2ppv-q3hg](https://github.com/better-auth/better-auth/security/advisories/GHSA-4wq4-2ppv-q3hg), critical | Expo `>=1.4.0-beta.6,<1.7.16`; core `<1.7.16` → 1.7.16; B for both | Expo signature oracle can forge email-change/cache signatures; wildcard origin issues. Expo excluded; exact origins/cache off retained. Previously exposed deployments require secret rotation per advisory; not a claim about this unmounted spike. |
| [GHSA-9hm7-xhfp-cx58](https://github.com/better-auth/better-auth/security/advisories/GHSA-9hm7-xhfp-cx58), medium | core `>=0.4.9,<1.7.16` → 1.7.16; B | OAuth unverified string claims/profile mismatch/Zoom options; excluded. |
| [GHSA-48c2-w96j-mv3m](https://github.com/better-auth/better-auth/security/advisories/GHSA-48c2-w96j-mv3m), medium | Kysely/Drizzle `>=1.5.0-beta.9,<1.7.16`; core `<1.7.16` → 1.7.16; B for all | MySQL/MariaDB serial-ID pooled connection mixup; not PostgreSQL/Prisma path. |
| [GHSA-2f9c-7xj7-gh55](https://github.com/better-auth/better-auth/security/advisories/GHSA-2f9c-7xj7-gh55), medium | core `>=1.3.7,<1.7.16` → 1.7.16; B | Email-OTP guesses race and binding flaws; emailOTP excluded. |
| [GHSA-hwq2-v29r-p69r](https://github.com/better-auth/better-auth/security/advisories/GHSA-hwq2-v29r-p69r), medium | core `>=1.4.0,<1.7.16` → 1.7.16; B | Email-change links bound to address, not original user. Email changes/delivery excluded; block alternate/direct flows. |
| [GHSA-9p5w-h4pr-fcrc](https://github.com/better-auth/better-auth/security/advisories/GHSA-9p5w-h4pr-fcrc), high | Electron `>=1.5.0-beta.12,<1.7.16` → 1.7.16; B | Secret disclosure/2FA bypass; Electron excluded. |
| [GHSA-mx9r-x6ww-qjw9](https://github.com/better-auth/better-auth/security/advisories/GHSA-mx9r-x6ww-qjw9), high | SSO `>=1.7.0-rc.2,<1.7.0` and `>=1.7.0,<1.7.3` → 1.7.3 | Personal SSO provider cross-provider takeover; excluded. |
| [GHSA-x8j7-xh58-rv6x](https://github.com/better-auth/better-auth/security/advisories/GHSA-x8j7-xh58-rv6x), medium | Stripe `>=1.2.0-beta.18,<1.7.16` → 1.7.16; B | Cross-customer billing; excluded, commerce off. |
| [GHSA-c85h-5mrr-mgx4](https://github.com/better-auth/better-auth/security/advisories/GHSA-c85h-5mrr-mgx4), medium | core `>=1.5.5,<1.7.16` → 1.7.16; B | Padded organization owner role; organization excluded. |
| [GHSA-gv75-j3v8-3crm](https://github.com/better-auth/better-auth/security/advisories/GHSA-gv75-j3v8-3crm), low | passkey `>=1.4.0-beta.16,<1.7.16` → 1.7.16; B; built-in core `>=1.2.0-beta.18,<1.4.0` → 1.4.0 | Passkey origin/user-verification checks; excluded. |
| [GHSA-fvxx-76fc-893x](https://github.com/better-auth/better-auth/security/advisories/GHSA-fvxx-76fc-893x), medium | core `>=0.8.1-beta.5,<1.7.16`; passkey `>=1.6.25,<1.7.16` → 1.7.16; B for both | **Relevant session/revocation class.** Secondary-storage races lose session-list entries; cached revoked sessions create lasting credentials/sessions. Keep cookie cache and secondary storage off; test revocation and sensitive operations against authoritative state. |
| [GHSA-8c5h-wx78-2cfg](https://github.com/better-auth/better-auth/security/advisories/GHSA-8c5h-wx78-2cfg), high | SSO `>=1.4.8-beta.1,<1.4.8` → 1.4.8; `>=1.4.9,<=1.6.26` → 1.6.27; `>=1.7.0-beta.0,<=1.7.0-rc.4` → 1.7.0-rc.5 | Unproven domain claims allow takeover/org joins; excluded. |
| [GHSA-q747-mqgr-4gh7](https://github.com/better-auth/better-auth/security/advisories/GHSA-q747-mqgr-4gh7), high | core `>=0.4.12-beta.7,<1.7.16` → 1.7.16; B | Unverified phone claims; phone excluded. |
| [GHSA-prpr-5gj3-qqhg](https://github.com/better-auth/better-auth/security/advisories/GHSA-prpr-5gj3-qqhg), high | SSO `<=1.6.20` → 1.6.21; `>=1.7.0-beta.0,<1.7.0-beta.10` → 1.7.0-beta.10 | Four SSO takeover flaws; excluded. |
| [GHSA-h3rm-78g3-j7cp](https://github.com/better-auth/better-auth/security/advisories/GHSA-h3rm-78g3-j7cp), high | Stripe `>=1.4.11,<1.6.21` → 1.6.21; `>=1.7.0-beta.0,<1.7.0-beta.10` → 1.7.0-beta.10 | Wrong-organization billing; excluded. |
| [GHSA-rjg6-39jm-rgg4](https://github.com/better-auth/better-auth/security/advisories/GHSA-rjg6-39jm-rgg4), critical | SCIM `>=1.4.0-beta.27,<=1.6.21` → 1.6.22; `>=1.7.0-beta.0,<=1.7.0-beta.10` → 1.7.0-rc.0 | Cross-owner takeover/deactivation failure; excluded. |
| [GHSA-j8v8-g9cx-5qf4](https://github.com/better-auth/better-auth/security/advisories/GHSA-j8v8-g9cx-5qf4), high | SCIM `>=1.5.0,<1.7.0-beta.4` → 1.7.0-beta.4 | Personal SCIM provider takeover; excluded. |
| [GHSA-p2fr-6hmx-4528](https://github.com/better-auth/better-auth/security/advisories/GHSA-p2fr-6hmx-4528), medium | oauth-provider `>=1.4.8,<1.7.0-beta.4` → 1.7.0-beta.4 | Tokens target unauthorized APIs; excluded. |
| [GHSA-gv74-j8m3-fg5f](https://github.com/better-auth/better-auth/security/advisories/GHSA-gv74-j8m3-fg5f), high | SSO `>=1.2.10,<1.6.11` → 1.6.11; `>=1.7.0-beta.0,<1.7.0-beta.4` → 1.7.0-beta.4 | Regular org members register SSO providers; excluded. |
| [GHSA-5rr4-8452-hf4v](https://github.com/better-auth/better-auth/security/advisories/GHSA-5rr4-8452-hf4v), critical | SSO `>=0.1.0,<1.6.11` → 1.6.11 | Authenticated SSRF/internal URL reads; excluded. |
| [GHSA-xr8f-h2gw-9xh6](https://github.com/better-auth/better-auth/security/advisories/GHSA-xr8f-h2gw-9xh6), medium | oauth-provider `>=1.4.8-beta.7,<1.6.5` → 1.6.5; `>=1.7.0-beta.0,<1.7.0-beta.2` → 1.7.0-beta.2 | Client-registration privileges not enforced; excluded. |
| [GHSA-4vcf-q4xf-f48m](https://github.com/better-auth/better-auth/security/advisories/GHSA-4vcf-q4xf-f48m), high | passkey `<1.4.0` → 1.4.0 | Delete another user's passkeys; excluded. |

Supplemental targeted-search observation: [GHSA-mw34-3w2r-wp9p API](https://api.github.com/advisories/GHSA-mw34-3w2r-wp9p) is an **unreviewed** CVE-2026-67336 record with no `vulnerabilities` package entries, referring to the already-listed GHSA-9h47-pqcx-hjr4 OIDC/MCP issue before 1.6.11. It is outside the two-query union, not a newly established independent vulnerability or an additional affected range. Its presence illustrates why the reviewed package-query count is not exhaustive.

## Relevant controls and test requirements (not test results)

### 1. Two-factor completion is a server-side authorization boundary

- Explicitly keep `session.cookieCache.enabled: false`; do not introduce stateless/cache-based session acceptance or secondary storage. An ordinary session token cookie is not the optional session-data cache cookie.
- As [2FA docs](https://better-auth.com/docs/plugins/2fa) explain, the default challenge applies to credential endpoints, **not** magic link, email OTP, OAuth, passkey, anonymous or similar passwordless flows. Excluding those flows is material, not cosmetic.
- Test password success with enrolled 2FA: challenge cookie/state may exist, but no usable authenticated session, staff DTO or protected operation before valid TOTP/approved recovery. Test missing/wrong/expired/replayed factor, challenge-cookie tampering, cookie reuse across users, direct library calls and raw handler requests. Enrollment must not grant staff privileges merely because a user can authenticate or has `twoFactorEnabled` set.
- Require verified TOTP enrollment; do not use `skipVerificationOnEnable`, passwordless enrollment or trusted-device bypass to make tests pass. Backup codes must be single-use and protected/redacted. Factor changes, recovery and disabling MFA require explicit policy and reauthentication; a library default alone is not staff policy.

### 2. Stale/revoked/deleted sessions must fail closed

- Test logout, explicit single/all-session revocation, expired sessions, password-change policy, disabled/deleted staff and changed/removed staff eligibility using **previously valid copied cookies**. Re-check authoritative staff status/permissions, not just existence of a library session.
- Assert old cookies cannot enroll/change factors, mint a new session, recover access or obtain a fresh staff DTO. Include concurrent revocation/session creation and cross-account cookie substitution. Do not recreate a staff identity or fall back to fixtures after rejection.
- The [1.7.18 release](https://github.com/better-auth/better-auth/releases/tag/v1.7.18) includes a bulk-revocation concurrency fix involving secondary storage plus database session storage, with an explicit exception for sessions created by a `session.delete.after` hook. The spike excludes secondary storage, but this is not a universal atomic-revocation guarantee. No session-creation deletion hook is proposed.

### 3. Staff-only means no direct signup or alternate-path escape

- Disable public signup in provider configuration, not merely by omitting its UI; gate the BFF by explicit allowlisted operations and provision only synthetic test staff. Arbitrary/unverified email equality is not proof of staff membership or ownership.
- Exercise raw handler signup and excluded endpoints as well as the BFF: repeated slashes, trailing slashes, encoded separators, alternate methods, aliases and direct `auth.api` entry points. Require rejection/no account, credential, membership or session creation, and no side effect on denied requests. Do not normalize a forbidden path into an allowed operation unintentionally.
- A mounted generic catch-all handler is not authorized. Tests may invoke `auth.handler(new Request(...))` in memory; passing such tests does not authorize wiring it into the application.

### 4. BFF and library HTTP handler have different safeguards

- [Security docs](https://better-auth.com/docs/reference/security) explicitly state **direct `auth.api` calls bypass HTTP CSRF/origin checks**, including redirect/callback URL checks, even when browser headers are passed. [Rate-limit docs](https://better-auth.com/docs/concepts/rate-limit) also say direct `auth.api` calls do not receive HTTP rate limiting. A BFF must enforce its own origin/CSRF, input/redirect allowlist and rate-budget boundary, or deliberately forward an allowed request through the library handler. Handler tests do not prove direct API safety.
- Use explicit static test base URL and exact trusted origins. Do not enable `disableCSRFCheck`, `disableOriginCheck`, wildcard origins, cross-subdomain cookies or untrusted forwarded host/proto fallback. Test hostile/missing/null Origin and Fetch Metadata combinations; the library documents permissive no-header non-browser behavior, so staff BFF policy must not accidentally inherit it.
- Reject off-origin, protocol-relative, backslash, control-character and encoded-separator redirect destinations. Never copy raw callback/error URL or exception HTML into a response. Preserve all required challenge/session `Set-Cookie` headers without flattening or mixing users' cookie jars.
- Assert HttpOnly, intended SameSite/path/domain, and Secure with a synthetic HTTPS origin. An in-memory Request is not proof of browser behavior, TLS deployment or proxy header sanitation.

### 5. Rate limiting requires explicit test activation and concurrency coverage

- Explicitly enable the limiter for tests: it is disabled in development by default. Test password and TOTP/recovery attempt budgets, 429/retry behavior, concurrent bursts, reset windows and alternate paths. A serial happy-path test cannot establish race resistance.
- Validate trusted IP provenance rather than trusting attacker-provided `X-Forwarded-For`; test IPv6 equivalent textual forms, IPv4-mapped forms and same-/64 rotation. For direct clients, the library cannot infer a socket IP by itself. Synthetic test headers establish a test model, not an actual trusted proxy.
- In-memory rate counters are per process and reset on restart. They are suitable for this bounded test harness, **not** a production/multi-instance brute-force defense. Do not imply the Drizzle/Kysely PostgreSQL advisory proves anything about Prisma's rate-counter atomicity.

### 6. No fallback, secrets or accidental persistence

- Missing/invalid secret, origin/base URL, staff policy or adapter configuration must fail explicitly. No default production secret, auto-created owner, auth-to-fixture fallback, in-memory fallback on database errors, or success-shaped fallback after MFA/revocation failure.
- Use synthetic identities and ephemeral test-only random secrets. Redact passwords/hashes, auth secret, session/challenge cookies/tokens, TOTP seeds/QR URI, OTPs, backup/recovery codes, verification/reset links, authorization headers and database URLs from logs, assertion dumps, fixtures and snapshots. Do not print real credentials or PII.
- Preserve the existing Prisma/pg pins; [official Prisma docs](https://better-auth.com/docs/adapters/prisma) describe Prisma 7/PostgreSQL support but do not prove exact-pin compatibility. Better Auth schema generation does not apply a Prisma migration. No generation, migration, live connection or database write was run here.

## Dependency audit and evidence gate

The parent must audit the **entire installed dependency graph, including devDependencies and transitives**, because Better Auth is proposed as dev-only for the spike. A production-only audit (`--prod` / omit-dev) is insufficient. Distinguish core Better Auth, its separately installed adapter/plugin packages, Prisma packages, pg and router/crypto/transitive dependencies; use actual lockfile versions rather than top-level declarations alone. Related Better Auth packages must be compatible/aligned with the selected release; the unrelated Prisma/pg version numbers are not supposed to match Better Auth's.

This researcher ran **no install, audit, tests, build, app/source edits, database command or Git operation**. The parent owns actual audit/test execution and its separate validation record; this document does not pre-fill a passing result section. The subsequent parent-executed dependency audit is recorded factually below; SDK/security test results remain outside this researcher's evidence.

Before any future route mounting or real staff activation, re-fetch advisories, audit dev and runtime graphs, review configuration and staff authorization, demonstrate negative-path/MFA/revocation/concurrency tests, and separately authorize persistence and deployment. **Patched library code plus restrictive configuration reduces known exposure; neither is proof of correct integration or future security.**

### Subsequent parent audit: one unresolved moderate dev-toolchain finding

The parent reports running the full pnpm audit after installing dev-only `better-auth@1.7.18`, `@better-auth/prisma-adapter@1.7.18` and `@better-auth/utils@0.5.1`; reported exit status was **1**, not a clean/pass result. The researcher read the parent's ignored local [dependency-audit.json](<../experiments/auth-spike/evidence/dependency-audit.json#L1-L49>): **exactly one moderate advisory, zero low/high/critical/info**, with `minimatch@10.2.6`, `dev: true`, and 11 dependency paths through `eslint-config-next`, TypeScript ESLint/parser and `@typescript-eslint/typescript-estree`. These are multiple paths to the same reported advisory, not 11 independent findings. No Better Auth advisory appears in this audit response; that is not a guarantee of absence of vulnerabilities.

The [official GHSA-g3hv-75wg-m249 API](https://api.github.com/advisories/GHSA-g3hv-75wg-m249) confirms **CVE-2026-118764**, reviewed medium severity (pnpm labels it moderate), affected **`>=7.0.0,<11.0.1`**, first patched **11.0.1**. The [advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249) describes attacker-controlled glob pattern amplification during preprocessing with `optimizationLevel >= 2`, followed by quadratic pairwise work, causing excessive CPU/memory use. The installed 10.2.6 falls in that range. Whether a specific lint workflow supplies attacker-controlled patterns and enables that optimization is not established here; dev-only classification is not a dismissal of tooling/CI exposure.

The current [lockfile](<../pnpm-lock.yaml>) confirms `@typescript-eslint/typescript-estree@8.72.1` resolves `minimatch: 10.2.6`. The parent additionally exported the lockfile at baseline `ce8165d8f7f8905378b36728e6c07b04ba20d9e9` to ignored local evidence and verified the same `minimatch@10.2.6` entry (lines2525 and5713). Thus the affected version predates this spike; this does not remove the finding or establish exploitability of the particular lint configuration.

Because the spike itself is dev-only, a production-only audit would miss both its dependency surface and this reported dev-toolchain finding. Keep full-graph auditing and preserve the nonzero result. Do **not** apply a blind cross-major override to minimatch 11 or claim remediation without verifying upstream constraints, supported Node versions, glob semantics, lint behavior and the full regression gate. Toolchain dependency maintenance requires separate owner approval and reviewed compatible upgrades; no dependency/lockfile edits are made by this document. This finding remains **open**, with remediation or explicit risk disposition owned by the parent/owner, not silently waived.
