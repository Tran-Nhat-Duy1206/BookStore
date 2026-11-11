# Nhật ký quyết định kiến trúc (ADRs)

Trạng thái “chấp nhận định hướng” chỉ nói quyết định thiết kế; không xác nhận đã cài dependency hoặc triển khai. Quyết định tương lai cần review trước khi thực thi.

## ADR-001 — Modular monolith

**Trạng thái:** chấp nhận định hướng.

**Bối cảnh:** cần nhiều miền nghiệp vụ nhưng team/phạm vi ban đầu nhỏ, chưa có nhu cầu scale độc lập được đo.

**Quyết định:** một ứng dụng chính, module có ownership và contract rõ. Chưa chọn microservices/message broker.

**Hệ quả:** triển khai và transaction đơn giản hơn; cần giữ dependency boundaries để tránh monolith lẫn lộn. Chỉ tách dịch vụ khi có bằng chứng vận hành.

## ADR-002 — Next.js, React, TypeScript, Tailwind, Motion

**Trạng thái:** chấp nhận định hướng Phase 2.

**Quyết định:** App Router cho storefront; server/client boundary tối thiểu; styling theo token; motion nhỏ và có reduced-motion.

**Hệ quả:** phù hợp SEO/nội dung và demo responsive; cần tránh over-hydration, animation bắt buộc và phụ thuộc runtime không cần thiết. Không suy ra đã có package/scripts.

## ADR-003 — Fixture trước, persistence sau

**Trạng thái:** chấp nhận định hướng.

**Quyết định:** Phase 2 đọc fixture typed qua hợp đồng; Phase 3 mới persistence. Không tạo endpoint nhận đơn giả.

**Hệ quả:** demo tái lập, không cần secret hoặc database; fixture không chứng minh stock, giá, ngày phát hành thực. Repository adapter tương lai phải giữ semantics domain.

## ADR-004 — PostgreSQL và Prisma tương lai

**Trạng thái:** owner đã duyệt PostgreSQL/Prisma cho Batch3.1 local catalog foundation. Pinned Prisma7.10.1; không production database activation. [ADR-010](./adr-010-catalog-persistence.md) chốt schema/read compatibility trước migrations.

**Quyết định đề xuất:** đánh giá Prisma cho schema/migration/type-safe access khi Phase 3 bắt đầu; so sánh với SQL/query builder nếu transaction/query cần kiểm soát hơn.

**Hệ quả:** quan hệ sách và ledger phù hợp SQL; phải xem connection pooling, migration, locking, runtime compatibility, backup/restore. Không tạo schema/database hoặc cài ORM chỉ để minh họa ADR.

## ADR-005 — Tách nội dung, ấn bản và SKU

**Trạng thái:** chấp nhận định hướng mô hình.

**Quyết định:** Work/Series/Volume mô tả nội dung; EditionContent nối nội dung vào Edition; Product là trình bày thương mại; SKU là đơn vị định giá/tồn. Omnibus, box và bundle có semantics riêng.

**Hệ quả:** nhiều thực thể hơn nhưng tránh trùng metadata và đếm sai tồn. ISBN không làm khóa tồn kho. Chi tiết: [Mô hình miền](./domain-model.md).

## ADR-006 — Commerce mặc định tắt

**Trạng thái:** chấp nhận phạm vi Phase 2 và Phase 3.

**Quyết định:** không customer auth, checkout, payment, đơn hàng thật, reservation hay credentials. CMS identity tương lai là quyết định riêng, không mở customer login.

**Hệ quả:** demo không được tạo cảm giác đã giao dịch; cần gate phê duyệt, pháp lý, vận hành, testing trước Phase 4.

## ADR-007 — Ngày phát hành có precision và nguồn

**Trạng thái:** chấp nhận định hướng.

**Quyết định:** precision và certainty tách biệt; không biến tháng/năm thành ngày giả; ngày lịch tách timestamp xuất bản bài.

**Hệ quả:** lọc/sắp xếp phức tạp hơn nhưng trung thực. Đổi lịch giữ audit. Chi tiết: [CMS/releases](./cms-releases.md).

## ADR-008 — Ledger và reservation thay vì sửa số tồn tùy ý

**Trạng thái:** đề xuất cho Phase 4, chưa triển khai.

**Quyết định đề xuất:** SKU × location; ledger bất biến, allocation có TTL/idempotency và transaction.

**Hệ quả:** có thể đối soát và chống oversell; phải thiết kế race payment/expiry, commit-vs-shipment và bundle nguyên tử. Chi tiết: [Tồn kho](./inventory.md).

## ADR-009 — Không chi phí/deploy tự phát

**Trạng thái:** chấp nhận giới hạn milestone.

**Quyết định:** không mua domain, cloud, SaaS, API trả phí hoặc deploy nếu chưa được phê duyệt riêng.

**Hệ quả:** thiết kế không gắn chặt nhà cung cấp sớm; kế hoạch chi phí tách ở [Chi phí tương lai](./future-costs.md), không trộn thành cam kết kiến trúc đã mua.

## ADR-010 — Catalog persistence, cardinalities and stable public reads

[Decision record](./adr-010-catalog-persistence.md): Batch3.1 Work-owned Volumes, many-to-many Series membership, ordered EditionContent, owned primary SKU, UUID/public-ID separation, isolated PostgreSQL and explicit source behavior. No auth/admin/commerce approval is implied.

## Batch3.2A security decisions — isolated evaluation only

- [ADR-011: provider and exact versions](./adr-011-authentication-spike-provider.md).
- [ADR-012: session and MFA admission](./adr-012-staff-session-and-mfa.md).
- [ADR-013: offline provisioning and Owner recovery](./adr-013-staff-bootstrap-and-owner-recovery.md).
- [ADR-014: purpose privileges, RBAC and audit/revocation](./adr-014-auth-privileges-rbac-and-audit.md).

These records do not authorize production auth, operational CRUD, a full admin application or deployment.

## ADR-015 — Security foundation implementation

[Foundation contract](./adr-015-security-foundation.md): accepted/merged Batch3.2B.1. One canonical additive history, isolated purpose credentials, server-only deny-default kernel, Owner-governance backstops, explicit isolation/time semantics and durable audit/reconciliation. No runtime admission writer, real Owner activation, auth transport/UI or business operations. [Historical validation](./batch-3-2b1-validation.md) records its implementation-stage evidence.

## ADR-016 — Unmounted provider observation and session contract

[Unmounted contract](./adr-016-unmounted-provider-proof.md): accepted B.2a, normally merged through PR#5 at `8458fdf5f9286de829aeac7e296eccf1bebd9c52`. Canonical maintained SDK sessions/TOTP and purpose clients; private non-authorizing observations, real cookie/commit/failure investigation. The default kernel resolver stays closed. [Preserved B.2 plan](./batch-3-2b2-plan.md) is historical; [validation](./batch-3-2b2a-validation.md) preserves its tested facts and absent durable authority at that stage.

## ADR-017 — Dormant durable evidence and admission controls

[Design gate](./adr-017-durable-admission-controls.md): accepted B.2b/PR#6, normally merged at `4dcf297af70cd5ba33e54ae6154ae9d3b1308830` after actual seven-job exact-HEAD CI42844425720. Narrow trusted VERIFIER issuer, independent monotone approval generations, original bindings/global pre-SDK burns, atomic finalization/audit and immutable epoch/revocation/idle. [Frozen local validation](./batch-3-2b2b-validation.md) preserves its pre-push snapshot; final CI is recorded on PR#6. Normal application admission remains disabled.

## ADR-018 — Restricted isolated HTTPS TEST transport

[Selected design](./adr-018-restricted-https-transport.md): B.2c ONLY, default/production OFF with no Next/app auth route. Explicit fixed manifest, raw wire/resource bounds, Origin/custom-header CSRF, final SDK cookie/ready/finalize ordering, presented-context deny-only cancellation and shared ingress007 without altering001–006. Fresh CA/strict Node wire verification and mandatory Linux real Chromium/isolated NSS trust; no OS certificate/DNS changes, certificate bypass or fake browser-cookie evidence. [Validation](./batch-3-2b2c-validation.md) distinguishes source, actual local execution and pending final-HEAD eight-job/browser acceptance. No real staff/Owner/bootstrap/ceremony, operational auth, UI, business/customer/commerce/deployment or B.2d approval. Keep eventual PR Draft and stop without merge.
