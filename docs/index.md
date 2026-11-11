# Hồ sơ định hướng Cozy Bookstore

Bộ tài liệu tiếng Việt cho dự án BookStore chính thức tại `E:\BookStore`. Đây là thiết kế và kế hoạch theo phạm vi đã duyệt, **không phải chứng nhận tính năng đã hoàn thành**.

## Cách đọc trạng thái

- **Đã duyệt định hướng**: quyết định phạm vi/thiết kế, không đồng nghĩa đã triển khai.
- **Dự kiến**: chưa có bằng chứng triển khai hoặc nghiệm thu trong bộ tài liệu này.
- **Đã triển khai/đã kiểm chứng**: chỉ được dùng sau khi đối chiếu mã nguồn và kết quả kiểm tra thực tế; agent điều phối cập nhật bằng chứng riêng.
- Ảnh bìa, tên sách, tác giả, bài viết và ngày phát hành là fixture minh họa; không phải cam kết kinh doanh. Milestone không có giá bán hoặc tồn kho thật.
- [Validation](./validation.md) ghi source commit, kết quả chạy thực và giới hạn; roadmap không phải danh sách tính năng đã hoàn thành.

## Mục lục

| Tài liệu                                                                  | Nội dung                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Tầm nhìn và phạm vi](./product-vision.md)                                | Người dùng, giá trị, giới hạn bản demo                                               |
| [Danh mục module tổng thể](./module-inventory.md)                         | Toàn bộ nhóm chức năng và giai đoạn dự kiến                                          |
| [Lộ trình](./roadmap.md)                                                  | Phase 2–5, điều kiện vào/ra                                                          |
| [Kiến trúc](./architecture.md)                                            | Modular monolith, stack, ranh giới module                                            |
| [Mô hình miền sách](./domain-model.md)                                    | Work, Series, Volume, EditionContent, Edition, Product, SKU                          |
| [Tồn kho](./inventory.md)                                                 | SKU × location, ledger, reservation                                                  |
| [CMS và lịch phát hành](./cms-releases.md)                                | Biên tập, trạng thái xuất bản, độ chính xác ngày                                     |
| [An toàn và dữ liệu](./security.md)                                       | Commerce/auth/payment tắt, không credentials                                         |
| [Hệ thiết kế](./design-system.md)                                         | Token màu/chữ thực tế, bố cục và mục tiêu accessibility                              |
| [Motion](./motion.md)                                                     | Hiệu ứng thực tế, reduced motion và ý tưởng chưa triển khai                          |
| [Sitemap](./sitemap.md)                                                   | Route demo hiện có, navigation và commercial boundary                                |
| [Validation ban đầu](./validation.md)                                     | Snapshot lịch sử của foundation                                                      |
| [Quality gate PR #1](./quality-gate.md)                                   | Findings/fixes, CI thực tế, 18 captures, motion acceptance và GO/NO-GO               |
| [Phát triển và kiểm thử](./development.md)                                | Toolchain, scripts thực tế, CI và cách tái tạo evidence                              |
| [Dependency và môi trường](./dependencies.md)                             | Snapshot phiên bản thực do agent điều phối cung cấp, tương thích và nợ tooling       |
| [Quyết định kiến trúc](./adrs.md)                                         | ADR và hệ quả                                                                        |
| [Phase3 plan](./phase3-plan.md)                                           | B.2a accepted/merged; B.2b dormant controls under validation                         |
| [Reviewed Batch3.2B plan](./batch-3-2b-plan.md)                           | Sanitized preserved plan; later integration/ceremonies/UI unapproved                 |
| [Security foundation ADR-015](./adr-015-security-foundation.md)           | Canonical persistence, exact privileges, isolation, governance, audit/reconciliation |
| [Batch3.2B.1 validation](./batch-3-2b1-validation.md)                     | Historical foundation/regression evidence                                            |
| [Preserved B.2 plan](./batch-3-2b2-plan.md)                               | Sanitized local planning deliverable; B.2a only approved                             |
| [Unmounted provider ADR-016](./adr-016-unmounted-provider-proof.md)       | Actual SDK observation/session boundary; no admission authority                      |
| [Batch3.2B.2a validation](./batch-3-2b2a-validation.md)                   | Tested runtime facts, limitations, gates and review                                  |
| [Dormant controls ADR-017](./adr-017-durable-admission-controls.md)       | B.2b gated authority, replay, approval generations and failure model                 |
| [Batch3.2B.2b validation](./batch-3-2b2b-validation.md)                   | Actual execution ledger; full acceptance and final-HEAD CI pending                   |
| [Staff security plan](./batch-3-2-security-plan.md)                       | Proposed full boundary; no operational authorization                                 |
| [Auth spike ADR-011](./adr-011-authentication-spike-provider.md)          | Exact provider/version and isolated evaluation scope                                 |
| [Session/MFA ADR-012](./adr-012-staff-session-and-mfa.md)                 | Admission, expiration and recovery restrictions                                      |
| [Owner recovery ADR-013](./adr-013-staff-bootstrap-and-owner-recovery.md) | Offline bootstrap, single Owner and recovery approval                                |
| [Privileges/audit ADR-014](./adr-014-auth-privileges-rbac-and-audit.md)   | Purpose credentials, RBAC and transaction boundaries                                 |
| [Auth advisories](./auth-spike-advisories.md)                             | Bounded official review and open dependency findings                                 |
| [Spike evidence](./auth-spike-validation.md)                              | Actual results and limits, not production certification                              |
| [Dependency audit remediation](./dependency-audit-remediation.md)         | Exact affected paths, scoped compatibility exception and validation                  |
| [ADR-010 catalog](./adr-010-catalog-persistence.md)                       | Cardinalities, UUID/public IDs, constraints và read contracts                        |
| [Catalog database](./catalog-database.md)                                 | Isolated local setup, migrations/seed, adapters và CI                                |
| [Batch3.1 validation](./batch-3-1-validation.md)                          | Actual local results, limitations và final PR CI evidence                            |
| [Chi phí tương lai](./future-costs.md)                                    | Khoản mục chưa được duyệt chi                                                        |

## Quyền sở hữu và giới hạn

- Chỉ làm việc trong dự án chính thức, nhánh tính năng được giao; không tạo bản sao dự án hoặc tự chuyển nhánh.
- Không triển khai production, mua dịch vụ hoặc thêm bí mật để hoàn thiện demo.
- Chưa xác nhận cửa hàng vật lý, địa chỉ, kho, tồn thực hay đối tác vận chuyển.
- Tài liệu xác nhận chạy lệnh/validation do agent điều phối phụ trách; bộ tài liệu này không tạo hoặc ghi đè báo cáo đó.

Các liên kết giữa tài liệu dùng đường dẫn tương đối từ tài liệu hiện tại để mở đúng trên GitHub. Implementation frontend đã được agent điều phối bổ sung; báo cáo validation của agent điều phối là nguồn có thẩm quyền về những gì thực sự được kiểm chứng, không phải các bảng kế hoạch trong hồ sơ này.
