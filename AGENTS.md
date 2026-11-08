# Continuation guardrails

- Chỉ làm việc trong official project `E:\BookStore`, feature branch được giao. Không tạo project clone, chuyển nhánh, merge, commit, push hoặc chạy Git nếu nhiệm vụ chưa cho phép.
- Đọc [hồ sơ dự án](<docs/index.md>) trước khi tiếp tục. Phân biệt kế hoạch với trạng thái đã triển khai; không ghi “đã hoàn thành/đã kiểm thử” nếu thiếu bằng chứng thực.
- Phạm vi hiện tại: Cozy Bookstore frontend demo, fixture; Next.js App Router, React, TypeScript, Tailwind, Motion; modular monolith. PostgreSQL tương lai; Prisma chỉ khuyến nghị, không tự cài.
- Phase 3 là catalog–news MVP, commerce vẫn tắt. Phase 4 mới xem xét commerce; Phase 5 readers/POS. Không mở rộng phạm vi âm thầm.
- Không bật customer auth, checkout, payment, nhận đơn, giữ tồn, shipping thật; không yêu cầu/ghi credentials hoặc PII. UI giỏ/yêu thích nếu có phải ghi rõ demo.
- Không bịa cửa hàng, địa chỉ, tồn kho, lịch phát hành hoặc dữ liệu khách hàng. Fixture phải được nhận diện; ngày tháng giữ đúng precision và nguồn.
- Tôn trọng Work/Series/Volume/EditionContent/Edition/Product/SKU; tồn tương lai theo SKU × location, không ISBN/Work.
- Thiết kế cream–brown–amber, Lora/Be Vietnam Pro; semantic tokens, keyboard/focus/contrast và reduced-motion. Không dùng motion để chặn đọc nội dung.
- Không deploy, mua dịch vụ, provisioning cloud/database hoặc thêm dependency ngoài phạm vi đã duyệt.
- Tuân thủ phạm vi file của từng nhiệm vụ; không sửa README/manifest/source/test/config khi chỉ được giao docs. Báo cáo validation do agent điều phối sở hữu, không ghi đè.
- Lệnh dev/typecheck/lint/test/build/test:e2e trong docs là mục tiêu dự kiến; kiểm tra scripts thực trước khi chạy, ghi đúng kết quả/chưa chạy, không tuyên bố tests passed không có bằng chứng.
