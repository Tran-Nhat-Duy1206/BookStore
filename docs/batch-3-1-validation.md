# Batch 3.1 — Validation and acceptance evidence

## Scope and provenance

Official repository `Tran-Nhat-Duy1206/BookStore`; baseline main `92644eae77f79613b7be548585789b0d74e25171`; branch `feat/phase3-batch1-catalog-db`. This report covers only the approved local database/catalog read batch. Final commit, Draft PR and exact-HEAD GitHub Actions run are recorded in the final PR comment; workflow configuration alone is not evidence of CI success.

No Batch3.2 work, merge, deployment, paid provisioning or access to another project repository/database occurred. The frontend's design tokens, CSS and motion implementation were not altered.

## Final model and implementation

[ADR-010](./adr-010-catalog-persistence.md) was written before migrations. Fourteen normalized catalog tables distinguish Work-owned logical Volumes, ordered many-to-many Series membership, ordered EditionContent, Edition, Product and owned SKU identity. A composite FK prevents selecting another Product's SKU. Standalone units are unnumbered; omnibus shares units; cross-Work anthology and multi-series membership are supported. PREPACKED is distinct; virtual bundles/composition/commerce remain deferred.

Prisma/client/adapter7.10.1 are pinned stable; pg8.23.1. Database UUIDs are independent of unchanged public fixture IDs/slugs. Optional ISBN/publisher metadata is not fabricated. SQL checks include ISBN checksum, ordering, year/version, public identity, physical SKU semantics and published primary-SKU requirements; listing/FK indexes are present.

Implementation locations:

- [Schema](../prisma/schema.prisma), [base migration](../prisma/migrations/001_catalog_base/migration.sql), [invariants](../prisma/migrations/002_catalog_invariants/migration.sql), [additive identity checks](../prisma/migrations/003_catalog_identity_checks/migration.sql).
- [Seed](../prisma/seed.ts), [guarded client](../src/server/database/client.ts), [URL configuration](../src/server/database/config.ts), [local instance helper](../scripts/local-db.mjs).
- [Contracts](../src/modules/catalog/contracts.ts), [fixture adapter](../src/modules/catalog/fixture-repository.ts), [PostgreSQL adapter](../src/modules/catalog/postgres-repository.ts), [source selector](../src/modules/catalog/data-source.ts), [server-only facade](../src/modules/catalog/read-catalog.ts).
- [Integration tests](../tests/integration/catalog.test.ts), [disposable database helper](../tests/integration/database.ts), unit source/config tests, [HTTP failure probe](../scripts/source-failure-smoke.ts), and [CI workflow](../.github/workflows/quality-gate.yml).

## Actual local results

Windows, Node24.19.0, pnpm11.7.0, native PostgreSQL18. Docker was unavailable on this host. Existing installed executables initialized a new cluster under the ignored BookStore local directory on127.0.0.1:55432; services/databases on5432 were not reused or reconfigured. Only that owned cluster was stopped after tests.

| Check | Actual result |
|---|---|
| Frozen dependency installation | PASS after explicitly approving only required engines/esbuild/Prisma lifecycle scripts |
| Prisma validate/generate | PASS, pinned7.10.1 |
| TypeScript | PASS |
| ESLint | PASS |
| Unit tests | **69/69 PASS** |
| Integration tests | **44/44 PASS** on fresh owned disposable PostgreSQL databases |
| Empty migration replay | All3 applied; repeated deploy no-op |
| Seeded upgrade | Apply001, seed, deploy002/003: IDs and full DTOs unchanged |
| Development migrations | All3 applied; subsequent deploy no pending migrations |
| Seed repeated | Both runs:9Works,11Volumes,12Editions,12Products,12SKUs,6categories,2Series |
| Complete fixture/PostgreSQL snapshot and shared search parity | PASS, including public IDs/slugs/order, accent-insensitive queries/category/title/recent semantics |
| Production build before DB-mode browser suite | PASS |
| Database-mode complete Playwright suite | **56 PASS,6 intentional SKIP**,62 project cases |
| Actual missing-database and invalid-source HTTP probes | Both HTTP500, no fixture substitution or response credential leakage; owned servers stopped |
| Stop owned PostgreSQL | PASS; no other service stopped |
| Fixture production build with owned DB stopped | PASS |
| Fixture complete Playwright suite with owned DB stopped | **56 PASS,6 intentional SKIP**,62 project cases |
| Dependency peers | No peer dependency issues found |
| Production audit | No known vulnerabilities reported at scan time; not a security certification |
| Independent static code review | No actionable Batch3.1 findings confirmed; runtime claims rely on executed tests above |

The two browser runs execute the same62 project cases in different data modes; do not describe them as124 unique scenarios. Six skips are intentional pointer/project applicability, as documented by the original quality gate. Existing CSS/motion/a11y/storage/navigation/commerce-boundary assertions were retained, not weakened to obtain pass.

## Findings resolved during validation

1. SQL RESTRICT behavior was correctly enforced, but an integration assertion expected foreign-key SQLSTATE23503 for a restricted delete. PostgreSQL18 returned23001; the assertion now checks that actual RESTRICT state while retaining23503 for invalid references/ownership.
2. Runtime data selection made the old global loading boundary stream HTTP200 before unknown-product notFound. The existing skeleton was moved unchanged to the catalog listing boundary. Original strict404 assertions now pass in both data modes; no test was relaxed.
3. Read projections must not mislabel real/non-demo records through the legacy fictional UI. Demo eligibility is checked through related records; regression tests cover filtering alongside draft/incomplete metadata.
4. Series membership/Volume order is honoured independently from global discovery curation; collected editions appear once after their last covered unit. Multi-Work ordering and anthology projection are tested.
5. Runtime reads use an explicit source and dynamic rendering rather than stale fixture prerendered HTML. Real connection errors propagate; actual HTTP failure checks verify the boundary.

## Security and compatibility

- No public mutation/API route handlers, auth, admin, CMS publishing, inventory operations or commerce endpoints were introduced.
- Migration/config/client/seed guards reject cloud/other-project/default-port URLs before connection. Local secrets remain ignored and are not artifact inputs. CI uses newly created ephemeral service credentials only.
- Public clients receive only original public DTOs; ORM/UUID graphs/private metadata are not serialized. Read sessions are readonly with bounded pool/connection/statement settings.
- Native helper refuses occupied ports, unowned data directories and environment overwrites. Integration cleanup requires an in-memory created-name record plus matching ownership comment and never uses FORCE on databases/connections.
- A pg8 query-queue deprecation warning is emitted on transaction/error paths. It does not fail the supported pinned pg8 tests; pg9 is not installed. Track compatibility upstream before upgrading rather than hiding warnings.
- Existing ESLint9 peer-compatibility debt remains. No production security/operational certification is claimed.

## CI and evidence

The original database-independent frontend job remains. A separate PostgreSQL18.3-alpine job runs disposable migration/parity tests, then database-mode storefront regression and HTTP failure probes. Both jobs use supported Node24 actions pinned by SHA, contents:read, no checkout credential persistence and no production secrets/deployment.

Final actual run/status is recorded on the Draft PR after pushing the final commit. Artifacts: `frontend-review-evidence` and `catalog-database-evidence` (JUnit plus database-mode reports/captures),7-day retention. Local Playwright outputs are regenerated/overwritten per run; the final local set is fixture mode. Eighteen screenshots per mode cover9pages×desktop/mobile, and the jobs retain their modes separately.

## Limitations and acceptance recommendation

Only local/demo catalog persistence/read foundation. Editorial/release arrays remain fixtures. Legacy Book DTO requires complete display metadata, so unknown-year/incomplete and PREPACKED records are not public books; real-content/box presentation and composition are later work. Search/snapshot is intentionally small-catalog/in-memory for exact existing semantics; pagination/scale tuning is deferred.

No admin identity/CRUD, media upload, production role separation, backups/restore drill, production database activation or deployment. No new physical-device/Safari/Firefox/screen-reader/native-zoom/CWV/load certification.

**GO for owner acceptance of Batch3.1 only once the final HEAD's actual CI is green.** Keep the PR Draft and do not merge or begin Batch3.2 without explicit approval.
