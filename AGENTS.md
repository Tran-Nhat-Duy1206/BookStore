# Continuation guardrails

- Chỉ làm việc trong official project `E:\BookStore`, feature branch được giao. Không tạo project clone, chuyển nhánh, merge, commit, push hoặc chạy Git nếu nhiệm vụ chưa cho phép.
- Đọc [hồ sơ dự án](<docs/index.md>) trước khi tiếp tục. Phân biệt kế hoạch với trạng thái đã triển khai; không ghi “đã hoàn thành/đã kiểm thử” nếu thiếu bằng chứng thực.
- Phạm vi được owner duyệt hiện tại: Phase 3 / Batch 3.1 — local PostgreSQL và catalog read foundation. Prisma 7.10.1, migrations/seed và read adapters được phép trong batch này; fixture vẫn mặc định. Đọc [ADR-010](<docs/adr-010-catalog-persistence.md>) và [Phase 3 plan](<docs/phase3-plan.md>). Không bắt đầu Batch 3.2 hoặc merge PR mới khi chưa được phép.
- Phase 3 là catalog–news MVP, commerce vẫn tắt. Phase 4 mới xem xét commerce; Phase 5 readers/POS. Không mở rộng phạm vi âm thầm.
- Không bật staff/customer auth, admin mutation endpoints, checkout, payment, nhận đơn, giữ tồn, shipping thật; không yêu cầu/ghi cloud/production credentials hoặc PII. Local-only random database credentials được phép trong ignored .env.local/.local; không commit/log/upload chúng. UI giỏ/yêu thích nếu có phải ghi rõ demo.
- Không bịa cửa hàng, địa chỉ, tồn kho, lịch phát hành hoặc dữ liệu khách hàng. Fixture phải được nhận diện; ngày tháng giữ đúng precision và nguồn.
- Tôn trọng Work/Series/Volume/EditionContent/Edition/Product/SKU; tồn tương lai theo SKU × location, không ISBN/Work.
- Thiết kế cream–brown–amber, Lora/Be Vietnam Pro; semantic tokens, keyboard/focus/contrast và reduced-motion. Không dùng motion để chặn đọc nội dung.
- Không deploy, mua dịch vụ, provisioning cloud/database hoặc thêm dependency ngoài phạm vi đã duyệt.
- Tuân thủ phạm vi file của từng nhiệm vụ; không sửa README/manifest/source/test/config khi chỉ được giao docs. Báo cáo validation do agent điều phối sở hữu, không ghi đè.
- Scripts thực ở [package.json](<package.json>); hướng dẫn ở [development](<docs/development.md>) và [catalog database](<docs/catalog-database.md>). Kiểm tra scripts trước khi chạy, ghi đúng kết quả/chưa chạy; không tuyên bố tests passed thiếu bằng chứng. Không sửa/reset/drop/stop database hoặc service của project khác; chỉ isolated BookStore instance/port được xác minh.
