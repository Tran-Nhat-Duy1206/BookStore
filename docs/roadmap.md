# Lộ trình triển khai dự kiến

Không gán ngày hoàn thành giả định. Mỗi phase cần review và phê duyệt trước khi tăng phạm vi. Trạng thái tính năng trong tài liệu là **dự kiến**, không phải kết quả triển khai.

## Phase 2 — Frontend Foundation / demo

**Đầu vào:** định hướng Cozy Bookstore, official project và feature branch được giao.

**Dự kiến:** Next.js App Router, React, TypeScript, Tailwind, Motion; fixture typed; shell và các route ở [Sitemap](<./sitemap.md>); responsive, loading/empty/error phù hợp; local wishlist/cart minh họa nếu được xây.

**Không làm:** database thật, cài Prisma, auth khách hàng, checkout, API payment/shipping, deploy hoặc dịch vụ trả phí.

**Gate đề xuất:** parent ghi nhận lệnh đã chạy, kết quả và giới hạn; kiểm tra link/route, keyboard/reduced-motion, không có CTA tạo giao dịch thật, không credentials. Demo không tự động chứng minh đạt gate.

## Phase 3 — Catalog–news MVP

**Đầu vào:** demo được duyệt, schema miền được review, có nguồn nội dung hợp pháp và kế hoạch vận hành.

**Dự kiến:** PostgreSQL, migration; cân nhắc Prisma sau ADR/cài đặt riêng; repository thật; catalog/series/search cơ bản; CMS news/releases với workflow draft–review–publish; media và audit; backup/restore. Nếu có quản trị CMS, identity quản trị phải được thiết kế/bảo mật riêng, không bật customer auth.

**Commerce vẫn tắt:** không nhận đơn, không reserve tồn, không payment; wishlist/cart nếu có vẫn được ghi rõ demo hoặc loại khỏi MVP.

**Gate đề xuất:** quyền xuất bản, validation metadata, ngày phát hành, truy xuất nguồn, restore drill, bảo mật CMS, search/accessibility và quy trình sửa nội dung được kiểm chứng.

## Phase 4 — Commerce

**Đầu vào bắt buộc:** chủ sở hữu phê duyệt commerce, có dữ liệu kho thực, quy trình giao nhận/đổi trả, pháp lý/chính sách riêng tư, nhà cung cấp và ngân sách được duyệt.

**Dự kiến:** customer identity khi cần; SKU/pricing, inventory ledger/reservation, cart/checkout, orders, payment/webhook/refund, shipping, notifications, support, đối soát.

**Gate đề xuất:** chống oversell và request trùng; tiền tính phía server; sandbox provider trước production; kiểm chứng webhook/retry; audit, phân quyền, backup, incident runbook, kiểm thử end-to-end. Không bật chỉ vì UI đã có nút mua.

## Phase 5 — Readers / POS

**Đầu vào:** commerce ổn định; độc giả/cửa hàng vật lý có nhu cầu đã xác nhận.

**Dự kiến:** tủ sách cá nhân, tiến độ đọc, reviews/moderation, loyalty; POS với SKU × location, ca làm, thiết bị, khả năng offline và đồng bộ/đối soát được thiết kế riêng.

**Gate đề xuất:** consent/retention, chống lạm dụng nội dung, quyền nhân viên, sai lệch kho, đồng bộ sự kiện và phục hồi POS được kiểm chứng. POS không mặc định có trong MVP.

## Nguyên tắc chuyển phase

Không dùng lịch mong muốn để bỏ qua gate. Chỉ chuyển trạng thái “dự kiến” sang “đã triển khai” kèm bằng chứng thực tế. Phụ thuộc trả phí, credentials, deployment và thay đổi pháp lý luôn cần phê duyệt riêng; chi phí ở [Chi phí tương lai](<./future-costs.md>).
