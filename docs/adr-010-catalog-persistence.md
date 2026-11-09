# ADR-010 — Batch 3.1 catalog persistence and read compatibility

Status: accepted for implementation under the owner's Batch 3.1 authorization. Baseline: `92644eae77f79613b7be548585789b0d74e25171`. This reconciles ADR-005 and the previously conceptual domain document before migrations are created. It does not authorize Batch 3.2 or commerce.

## Cardinalities

- Work is intellectual content. A Work owns zero or more logical Volumes while draft; a published book edition must contain at least one content unit. A standalone uses one unnumbered internal unit, never a fabricated public “Volume 1”.
- Series groups Works through ordered SeriesWork membership (many-to-many). A Work can belong to multiple Series. Volumes are owned by Work, not exclusively by Series; a series obtains its content through its member Works. This resolves the older shorthand “Series has Volumes”. Membership can designate the primary series used by the legacy Book DTO; at most one primary membership per Work.
- Edition contains one or more ordered EditionContent rows referring to Volumes. Multiple Editions may contain the same Volume. An omnibus includes multiple units; an anthology can include units from different Works. Do not force Edition to have one Work foreign key.
- Product is the public/merchandising identity and slug. Product owns one or more SKUs when published. A SKU belongs to exactly one Product. A Product's selected primary SKU must belong to that same Product, enforced with a composite FK. Draft Products may have no primary SKU.
- SKU of a single physical book links one Edition. Publisher-prepacked box sets use their own stock identity; virtual bundles represent component composition and must not be modelled as an Edition/omnibus or duplicated stock. Batch 3.1 supports bibliographic EditionContent and prepacked catalogue identity; virtual-bundle composition, pricing and stock operations are deferred and cannot be published as working functionality.
- Work/Edition contributor relationships are separate and role-labelled. Categories are independently ordered. Publisher and ISBN metadata are optional.

## Identity and compatibility

- Database identifiers are UUIDs, separate from immutable unique public IDs and editable unique slugs. Preserve all existing public fixture IDs/slugs verbatim; local wishlist/trial-cart records must not change identity because of UUID adoption.
- The existing Book, Series and Category read shapes remain the public DTO contract. A server adapter projects normalized records back to that shape; clients never receive Prisma models, UUID relation graphs, credentials, draft metadata or provider details.
- Legacy Book.seriesId represents the selected primary membership. Series.bookIds includes published products whose edition content belongs to member Works. Contextual order uses SeriesWork.position, the last covered Volume.sortOrder, content count (individual edition before collected edition at the same end point), then curated Product order. Global book discovery retains the original curated order. Omnibus appears once, not once per content unit. Multi-series/cross-work support is tested separately from the unchanged demo seed.
- Curated ordering is persisted; title/recent search uses the existing shared Vietnamese normalization/sort logic for this small catalog. Do not silently change substring/token search, collation, tie ordering or invalid-filter behavior.
- Current fictional covers remain original generated artwork. Store their theme/motif and exact display labels; do not manufacture ISBNs, publishers, price, stock, addresses or release metadata. All imported records remain demo-marked.

## Integrity

- Real FKs, unique/nonblank public IDs/slugs/SKU codes, safe slug paths, unique parent/member and ordering pairs, positive ordering positions, valid publication years, optional normalized unique ISBN-13 (format and checksum), and lifecycle checks. Seven mutable metadata entities have timezone-aware timestamps and a nonnegative version foundation; no mutation service is implied.
- Published Products require a valid primary SKU; public read projections additionally require complete, eligible, demo-marked Edition/Work content and never expose drafts or non-demo records through this legacy fictional UI. Real-content UI/DTO activation is deferred. Publication completeness that spans rows is validated by use cases/read eligibility rather than falsely claiming an aggregate CHECK can enforce it.
- Primary-series uniqueness and SQL CHECKs not representable in the pinned Prisma version belong in reviewed SQL migrations. Ordinary/composite FKs and supported indexes remain represented in Prisma.
- Restrict deletion of referenced records. No generic unchecked polymorphic IDs. No pricing, inventory, order, authentication, CMS-publishing or payment tables/operations in this batch.

## Data access and environment boundary

- DATA_SOURCE is exactly fixture or database; unset defaults to fixture. Invalid values fail explicitly. Database mode never catches connection errors and substitutes fixtures.
- Only a deliberately isolated, loopback BookStore development/test database is authorized. Existing services on 5432 are not used. Local database initialization/start/stop must target only a verified BookStore data directory and dedicated free port; no service reconfiguration or system installation.
- Default fixture build/test/run needs no database URL, running database or cloud credentials. PostgreSQL/Prisma imports stay behind server-only boundaries and explicit adapter selection.
- Database mode is local/CI opt-in only, not production database activation. Storefront rendering remains fixture-backed by default; any integration changes must preserve DTO/UI/animation/local-storage behavior and be explicitly documented.

## Seeding and validation

- Deterministic UUID mapping and stable public IDs. A transactional idempotent seed imports only the original fictional catalog. The omnibus points to the same two Volume rows used by the individual Editions.
- No new business inventory or publisher facts. Normal seed excludes synthetic box/anthology/multi-series test cases; those live only in disposable integration tests. Base/invariant migrations remain unchanged after first application; additive003 hardens identity checks and published-listing indexes.
- Test empty replay, reapplying migrations, an upgrade boundary where the initial migration is split into base schema and reviewed invariants, FK/unique/check failures, same-product primary SKU ownership, standalone/multi-series/omnibus/anthology relationships, seed idempotency, full fixture projection/search parity, no-draft leakage, source configuration and error propagation.

## Deferred

Admin identity/RBAC, CRUD/mutation endpoints, uploads, editorial persistence/publishing, release storage, inventory adjustments/reservations, customers/orders, commerce and production deployment remain outside this batch. Earlier roadmap features remain planned, not removed.
