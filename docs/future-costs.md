# Chi phí tương lai — chưa được duyệt chi

Tài liệu này tách riêng ngân sách khỏi ADR và roadmap. **Không phải báo giá, đề nghị mua hay xác nhận dịch vụ đã hoạt động.** Milestone hiện tại không deploy, không sử dụng dịch vụ trả phí, không tạo tài khoản thanh toán hoặc credentials.

## Khoản mục cần khảo sát

| Khoản mục dự kiến | Khi xem xét | Yếu tố ảnh hưởng |
|---|---|---|
| Domain/DNS | Khi có kế hoạch public được duyệt | TLD, gia hạn, quyền sở hữu, email DNS |
| Hosting Next/application | Phase 3 hoặc launch được duyệt | Request, compute, bandwidth, build, vùng triển khai |
| PostgreSQL + pooling | Phase 3 | Storage, RAM/CPU, connections, HA, I/O |
| Backup/restore | Phase 3 | Retention, dung lượng, offsite, thời gian diễn tập |
| Media/object storage/CDN | Phase 3 | Ảnh gốc/biến thể, egress, transformations |
| Monitoring/logging | Phase 3 | Retention log, event volume, alerting, PII masking |
| Email giao dịch | Phase 4 | Lượt gửi, domain authentication, retry, deliverability |
| Payment provider | Phase 4 | Phí giao dịch, hoàn tiền, đối soát, settlement, thuế |
| Shipping integrations | Phase 4 | Hợp đồng, phí vận chuyển, COD, hoàn hàng |
| Search chuyên dụng | Chỉ khi đo nhu cầu | Dung lượng index, query, vận hành; ưu tiên giải pháp đơn giản trước |
| Security/compliance/legal | Trước commerce | Chính sách, đánh giá bảo mật, nghĩa vụ dữ liệu/thuế/hóa đơn |
| Nội dung và bản quyền | Phase 2 trở đi | Quyền bìa sách, font, ảnh, biên tập và nguồn dữ liệu |
| POS hardware/software | Phase 5 | Máy quét, máy in, thiết bị, offline sync, hỗ trợ tại điểm bán |
| Nhân sự vận hành/hỗ trợ | Khi mở dịch vụ thật | Kiểm kê, hỗ trợ, sự cố, moderation, bảo trì |

## Cách lập dự toán khi được yêu cầu

1. Chốt traffic, vùng, storage, số sản phẩm/bài/ảnh, RPO/RTO và mức sẵn sàng.
2. Lập ít nhất kịch bản thử nghiệm, cơ sở và tăng trưởng; phân biệt một lần, định kỳ và usage-based.
3. Lấy báo giá có ngày, tiền tệ, thuế và nguồn; không đưa số giả hoặc coi free tier là miễn phí vĩnh viễn.
4. Đặt budget alert, giới hạn, người chịu trách nhiệm và phương án hủy/xuất dữ liệu.
5. Chủ sở hữu duyệt trước provisioning/deployment; free tier vẫn cần duyệt nếu đòi tài khoản, thẻ hoặc xử lý dữ liệu thật.

Prisma có thể có thư viện mã nguồn mở nhưng không vì vậy coi toàn bộ stack có chi phí bằng không; hạ tầng, backup, vận hành và các dịch vụ thương mại tùy chọn là khoản riêng. Chưa có nhà cung cấp hoặc tổng ngân sách được xác nhận trong hồ sơ này.
