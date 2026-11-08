# Phát triển và kiểm thử — hướng dẫn dự kiến

## Phạm vi làm việc

Chỉ làm trong `E:\BookStore`, official project và feature branch được giao. Tài liệu này không yêu cầu tự chạy Git hoặc chuyển nhánh. Không sửa README, dependency/config hoặc source chỉ để làm khớp một tài liệu kế hoạch. Khi khác biệt xuất hiện, báo agent điều phối để xác nhận trạng thái thực.

## Chuẩn bị môi trường

Dự kiến Node.js bản tương thích với phiên bản Next đã chọn và pnpm theo phiên bản được dự án pin. **Không giả định version cụ thể hoặc dependency đã cài**; đối chiếu manifest/lockfile/toolchain thật trước khi setup. Không cài Prisma, database hoặc dịch vụ cloud cho demo. Không tạo `.env` có credentials để chạy fixture.

Sau khi project scaffold và scripts được chủ sở hữu xác nhận, mới thực hiện cài đặt dependency theo lockfile/chính sách dự án. Nếu thiếu script thì báo thiếu; không tuyên bố lệnh chạy được và không tự sửa manifest ngoài nhiệm vụ.

## Lệnh mục tiêu

Các lệnh sau là **kế hoạch giao diện phát triển**, không phải chứng cứ scripts hiện hữu hay kết quả chạy:

```text
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

| Lệnh dự kiến | Mục đích | Điều kiện |
|---|---|---|
| `pnpm dev` | Dev server để review UI | Scaffold, dependencies và script đã có; dùng URL thật server báo |
| `pnpm typecheck` | Kiểm tra type không emit | TypeScript/script đã cấu hình |
| `pnpm lint` | Quy tắc lint của dự án | Lint tool và script đã xác nhận |
| `pnpm test` | Unit/integration cục bộ | Test runner được chọn và fixtures xác định |
| `pnpm build` | Production build | Không cần secret/db khi demo được thiết kế đúng |
| `pnpm test:e2e` | Browser hành trình người dùng | E2E runner/browser và target server sẵn sàng |

Không dùng câu “tests passed”, “build thành công” nếu chưa chạy và ghi nhận kết quả thực. Build thành công cũng không đồng nghĩa E2E, accessibility hay security đã đạt.

## Ma trận kiểm thử dự kiến

- **Type/static:** contract fixture, props, import boundaries, metadata shape.
- **Domain:** Work/EditionContent nhiều–nhiều; thứ tự Volume; precision ngày; composition không vòng lặp.
- **UI:** search/filter/reset, unknown slug/not-found, empty state, ảnh fallback, tiêu đề tiếng Việt dài.
- **State demo:** wishlist/cart local persistence/reset nếu có, invalid data xử lý an toàn; không gọi endpoint thương mại, không reserve stock.
- **E2E:** home → catalog → product → series; news list → article; releases; wishlist/cart minh họa, CTA disabled và thông báo đúng phạm vi.
- **Accessibility:** keyboard, focus order, labels, landmarks, reduced motion, contrast, screen reader thủ công, zoom/reflow.
- **Responsive:** mobile hẹp, tablet, desktop; không horizontal overflow do tên sách/filters.
- **Security/content:** không secret/PII, không auth/payment thật, sanitize nội dung khi có CMS, fixture badge và ngày trung thực.
- **Phase 3+:** repository/database, migration/restore, quyền publish và preview isolation.
- **Phase 4+:** concurrency/reservation, idempotency payment, retry/refund, money/server validation; chưa thuộc demo.

## Bàn giao kết quả kiểm chứng

Agent điều phối sở hữu báo cáo validation riêng; tài liệu này không tạo/ghi đè báo cáo đó. Mỗi lần chạy cần ghi: ngày giờ, command, môi trường/URL nếu có, exit code, output đáng chú ý, giới hạn/chưa chạy. Lệnh không tồn tại hoặc thất bại phải ghi đúng, không thay bằng dấu tick. Không lưu credentials/PII vào log hoặc ảnh minh chứng.
