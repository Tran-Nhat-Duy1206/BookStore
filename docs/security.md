# An toàn, quyền riêng tư và giới hạn demo

## Trạng thái bắt buộc

Trong milestone frontend và catalog–news MVP: **checkout/payment tắt; customer auth tắt; không nhận đơn hoặc credentials**. Nêu tính năng trong roadmap không phải phê duyệt bật tính năng đó.

- Không yêu cầu người dùng nhập số thẻ, mật khẩu, OTP, địa chỉ giao hàng hoặc dữ liệu cá nhân thật để xem demo.
- Không tạo khóa payment/cloud/database, không commit `.env` thật, không dùng credential cá nhân hoặc production.
- Không thêm client-side secret; biến public chỉ chứa cấu hình thật sự công khai.
- Không giả checkout thành công, mã đơn, email xác nhận hoặc webhook thật.
- Nút checkout/đăng nhập nếu xuất hiện phải disabled hoặc thay bằng thông báo phạm vi rõ ràng, không liên kết tới endpoint nhận giao dịch.
- UI disabled không phải biện pháp bảo vệ backend: endpoint thương mại không được triển khai/bật để vượt qua giới hạn bằng request trực tiếp.

## Dữ liệu demo

Fixture cần được nhận diện là minh họa, không chứa thông tin khách hàng thật. Wishlist/cart demo chỉ dùng ID và số lượng cần thiết ở trình duyệt nếu được xây; cho phép xóa/reset, không tuyên bố đã đồng bộ tài khoản hoặc giữ hàng. Tránh analytics/cookie theo dõi chưa có đánh giá consent.

## Phase 3 — CMS tương lai

Nếu quản trị CMS được phê duyệt, phải có identity quản trị riêng, RBAC tối thiểu, kiểm tra quyền phía server và audit publish. Customer login vẫn tắt. Không dựng trang admin công khai với mật khẩu hard-code hoặc “bảo vệ” chỉ bằng route ẩn.

Dự kiến bảo vệ input/schema, sanitize nội dung rich text, upload MIME/size/extension và quyền đọc file, chống XSS/CSRF theo session model, rate limit, dependency review, security headers. Không coi phần này là các biện pháp đã cài đặt.

## Trước commerce Phase 4

Cần threat model và kiểm chứng: tính tiền server-side; authorization tài nguyên; idempotency checkout/payment; xác thực chữ ký webhook; chống replay; tách môi trường; secrets management; logs che dữ liệu nhạy cảm; provider-hosted payment để hạn chế dữ liệu thẻ; legal/privacy/retention; backup/restore và incident response. Scope PCI và nghĩa vụ pháp lý phải được đánh giá, không mặc định được đáp ứng.

## Khi phát hiện bí mật hoặc sự cố

Không sao chép secret vào docs/chat/log. Báo vị trí và loại rủi ro không kèm giá trị; chủ sở hữu thu hồi/rotate theo quy trình. Không tự ý xóa lịch sử, chạy Git rewrite hoặc gọi API production để “thử”. Không tuyên bố an toàn tuyệt đối hay đã audit nếu chưa có bằng chứng kiểm tra.
