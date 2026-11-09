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

**Hệ quả:** nhiều thực thể hơn nhưng tránh trùng metadata và đếm sai tồn. ISBN không làm khóa tồn kho. Chi tiết: [Mô hình miền](<./domain-model.md>).

## ADR-006 — Commerce mặc định tắt

**Trạng thái:** chấp nhận phạm vi Phase 2 và Phase 3.

**Quyết định:** không customer auth, checkout, payment, đơn hàng thật, reservation hay credentials. CMS identity tương lai là quyết định riêng, không mở customer login.

**Hệ quả:** demo không được tạo cảm giác đã giao dịch; cần gate phê duyệt, pháp lý, vận hành, testing trước Phase 4.

## ADR-007 — Ngày phát hành có precision và nguồn

**Trạng thái:** chấp nhận định hướng.

**Quyết định:** precision và certainty tách biệt; không biến tháng/năm thành ngày giả; ngày lịch tách timestamp xuất bản bài.

**Hệ quả:** lọc/sắp xếp phức tạp hơn nhưng trung thực. Đổi lịch giữ audit. Chi tiết: [CMS/releases](<./cms-releases.md>).

## ADR-008 — Ledger và reservation thay vì sửa số tồn tùy ý

**Trạng thái:** đề xuất cho Phase 4, chưa triển khai.

**Quyết định đề xuất:** SKU × location; ledger bất biến, allocation có TTL/idempotency và transaction.

**Hệ quả:** có thể đối soát và chống oversell; phải thiết kế race payment/expiry, commit-vs-shipment và bundle nguyên tử. Chi tiết: [Tồn kho](<./inventory.md>).

## ADR-009 — Không chi phí/deploy tự phát

**Trạng thái:** chấp nhận giới hạn milestone.

**Quyết định:** không mua domain, cloud, SaaS, API trả phí hoặc deploy nếu chưa được phê duyệt riêng.

**Hệ quả:** thiết kế không gắn chặt nhà cung cấp sớm; kế hoạch chi phí tách ở [Chi phí tương lai](<./future-costs.md>), không trộn thành cam kết kiến trúc đã mua.

## ADR-010 — Catalog persistence, cardinalities and stable public reads

[Decision record](./adr-010-catalog-persistence.md): Batch3.1 Work-owned Volumes, many-to-many Series membership, ordered EditionContent, owned primary SKU, UUID/public-ID separation, isolated PostgreSQL and explicit source behavior. No auth/admin/commerce approval is implied.
