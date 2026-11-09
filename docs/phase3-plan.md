# Phase 3 — Backend and Admin Foundation

## Approval and baseline

The owner approved the plan after PR #1 merged normally into main at `92644eae77f79613b7be548585789b0d74e25171`. Batch3.1 was accepted and merged at `ce8165d8f7f8905378b36728e6c07b04ba20d9e9`. The owner now authorizes **Batch3.2A isolated authentication security spike only**. Full Batch3.2 and later operational batches require separate approval. This file preserves the approved plan from the conversation; it does not claim that the entire backend/admin system exists.

## Architecture

Retain the Next.js/React/TypeScript modular monolith. Public read DTOs and application use cases isolate UI from PostgreSQL/Prisma. Catalog, editorial, staff identity, media, settings and inventory retain separate ownership. No microservices, external search cluster, Redis or paid infrastructure initially.

Approved catalog reconciliation: [ADR-010](./adr-010-catalog-persistence.md). Work/Volume content is separate from Edition and Product/SKU. Series membership is many-to-many. EditionContent supports omnibus and cross-Work anthologies. Public IDs and slugs are distinct from database UUIDs. Optional ISBN/publisher metadata must not be invented.

## Delivery batches

| Batch | Scope | Gate |
|---|---|---|
| 3.1 — approved | Local isolated PostgreSQL, pinned compatible Prisma, core catalog migrations, idempotent original demo seed, fixture/database read contracts and parity, CI database tests | No auth/admin writes/commerce/deployment; fixture default; public identity/UI compatibility |
| 3.2A — spike only approved | Isolated Better Auth compatibility, MFA/admission, SQL privilege experiments and security ADRs | No mounted auth routes, operational admin, real identities, deployment or merge; [security plan](./batch-3-2-security-plan.md) |
| 3.2 — not authorized | Staff authentication, MFA, sessions, deny-by-default RBAC/object authorization and audit | Ship security as one slice before admin mutations; provider choice approved separately |
| 3.3 — not authorized | Catalog administration for Works, Series, Volumes, Editions, Products/SKUs, taxonomy/contributors/publishers | Valid relationships, stale-edit protection, transactional audit |
| 3.4 — not authorized | Safe media upload, metadata, derivatives and associations | Allowlisted formats, size/dimension limits, safe storage and rights metadata |
| 3.5 — not authorized | Editorial revisions, preview, publishing/scheduling, release precision/source/history | Draft isolation, immutable approved revisions, idempotent due-publication and retryable invalidation |
| 3.6 — not authorized | Homepage sections/banners, brand/localization and truthful storefront settings | Do not invent business contact/address; commerce flags not editable into activation |
| 3.7 — not authorized | Inventory location/balance/append-only ledger and controlled adjustments | SKU × location, atomic/idempotent audited adjustments; no fabricated real balances |
| 3.8 — not authorized | Broader public integration, caching, monitoring and restore drill | Regression/accessibility/motion parity and operational acceptance |

Batch 3.1 provides local opt-in catalog read integration for verification, not production database activation. Later integration extends real-content DTOs, scale and publishing behavior; it must not silently substitute fictional data on database failures.

## Future administration sitemap

`/admin`: sign-in/MFA/recovery; overview; catalog (Works, Series/membership, Volumes, Editions, Products/SKUs, contributors/publishers, categories); editorial (news, announcements, articles/editorial reviews, release calendar); storefront (homepage/banners); media; inventory (balances/adjustments/history); settings; staff/roles; audit. This sitemap is a plan, not installed routes.

Staff-only identity: assess the earlier Supabase Auth option against a maintained local-first library; approve provider before Batch 3.2. No homemade password cryptography, customer registration or partial unsecured CRUD. Roles: Owner, CatalogManager, Editor, Publisher, InventoryManager and Analyst, backed by action/resource permissions and object/field checks. Protect the last Owner and session revocation; support CSRF/origin controls, rate limits and recovery policy.

## Future content, release and inventory schema

- ContentItem with immutable ContentRevision snapshots, draft/live/scheduled pointers scoped to the same document, and typed revision associations. Editing a live article must not mutate its published snapshot.
- ReleaseEvent + append-only ReleaseRevision; certainty, lifecycle and day/month/quarter/year/unknown precision remain independent. Calendar dates are not publication timestamps. No auto-release because an expected date passed.
- MediaAsset/MediaVariant with safe storage, rights/alt metadata and referenced-asset deletion protection.
- Versioned homepage/banner/brand/storefront configuration and immutable audit entries with sensitive-field redaction.
- StockLocation, InventoryBalance (SKU × location), StockMovement and InventoryAdjustment. No sale/reservation operations until Phase 4; no stock subtraction at Work/ISBN level.

## Operations and acceptance

- Pin ORM/runtime versions; review generated/handwritten SQL. Applied migrations are immutable. Test empty replay and additive upgrades; later destructive changes use expand/backfill/validate/contract.
- Separate local/CI/staging/production credentials and data. Use migration privileges separately from application privileges before real operation. No production secrets or data in PR CI.
- Back up both database and media, with encryption/retention/RPO/RTO agreed before backend operation; prove isolated restoration, not just backup creation.
- Public reads exclude drafts/private fields. Admin/preview is private/no-store. Commit publication before retryable cache invalidation; due jobs publish exactly the approved revision atomically.
- Keep Vietnamese search semantics, stable identifiers/local collections, Cozy Bookstore tokens, all accepted animations, keyboard/focus behavior and reduced motion. Preserve loading, empty, not-found, error and media fallback states.
- CI keeps the frontend gate and adds disposable PostgreSQL tests. Claim only results actually executed.

## Preserved roadmap and exclusions

Pricing/promotions, customer identity/privacy, orders/checkout/payment/refunds, suppliers/procurement, reservations/transfers/fulfillment/shipping/returns, notifications, real wishlist/cart/account sync, readers/community/reviews/bookshelves, loyalty and POS/offline/reconciliation remain planned Phase 4/5 features. None is removed or implicitly approved by this batch.

No paid infrastructure, cloud credentials, production deployment or production database activation is authorized. Stop after Batch3.2A with a Draft PR; do not merge or implement full Batch3.2/Batch3.3 without separate approval.
