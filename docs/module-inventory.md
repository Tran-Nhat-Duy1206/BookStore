# Danh mục module tổng thể

Đây là **master inventory dự kiến**, không phải danh sách đã xây xong. Phase thể hiện mốc sớm nhất nên xem xét, không phải cam kết triển khai tất cả chức năng trong mốc đó.

| Module | Trách nhiệm và dữ liệu chính | Giai đoạn dự kiến |
|---|---|---|
| Storefront shell | Header/footer, điều hướng, responsive, empty/error/not-found | 2 |
| Design system | Typography, tokens, component states, motion, accessibility | 2 |
| Catalog | Work, Edition, Product, taxonomy, contributors, publishers, ISBN | 2 fixture; 3 dữ liệu thật |
| Series/reading order | Series, Volume, thứ tự đọc, ngoại truyện, mapping nội dung | 2 fixture; 3 chuẩn hóa |
| Discovery/search | Tìm kiếm, lọc, sắp xếp, phân trang; search service riêng chưa cần | 2 local; 3 server |
| Editorial/news | Bài viết, chuyên mục, tác giả, trạng thái duyệt, nội dung liên quan | 2 fixture; 3 CMS |
| Releases | Lịch phát hành, ngày chính xác/ước lượng, thay đổi và nguồn | 2 fixture; 3 CMS |
| Media | Bìa sách, ảnh biên tập, alt text, bản quyền, upload có kiểm soát | 2 asset local; 3 quản lý |
| Wishlist | Yêu thích cục bộ demo; đồng bộ tài khoản chỉ khi identity được duyệt | 2 demo; 4/5 thật |
| Cart | Giỏ minh họa, số lượng; không đặt hàng/reserve | 2 demo; 4 thật |
| Pricing | Giá SKU, tiền tệ, lịch hiệu lực, thuế/quy tắc hiển thị | 2 fixture; 4 thật |
| Promotions | Mã giảm giá, điều kiện, giới hạn, phân bổ ưu đãi | 4 |
| Identity/access | Identity quản trị cho CMS riêng; customer auth/RBAC/session | 3 quản trị; 4/5 khách hàng |
| Customers/privacy | Hồ sơ, địa chỉ, consent, xuất/xóa dữ liệu, retention | 4 |
| Orders/checkout | Tính lại giá, order snapshots, trạng thái đơn, idempotency | 4 |
| Payments/refunds | Payment intent, webhook xác thực, đối soát, hoàn tiền | 4 |
| Inventory | Location, SKU ledger, reservation, nhập/xuất/điều chỉnh | 4 |
| Procurement/suppliers | Nhà cung cấp, phiếu nhập, chi phí vốn, nhận hàng | 4, mở rộng 5 |
| Fulfillment/shipping | Picking, packing, shipment, tracking, phí vận chuyển | 4 |
| Returns/support | Yêu cầu hỗ trợ, đổi trả, kiểm tra hàng, credit/refund | 4 |
| Notifications | Email giao dịch, opt-in, retry, chống trùng | 4 |
| Readers/community | Tủ sách, tiến độ đọc, review, moderation, báo cáo lạm dụng | 5 |
| Loyalty | Điểm, hạng, điều chỉnh và audit; không trộn với số dư tiền | 5 |
| POS | Ca làm, máy bán hàng, offline/reconciliation, hóa đơn, trả hàng | 5 |
| Reporting | Catalog quality, xuất bản; doanh thu/tồn kho khi có dữ liệu thật | 3 rồi 4/5 |
| Administration | Dashboard, permissions, audit log, cấu hình có version | 3, mở rộng 4/5 |
| Platform/operations | Database migrations, backup, monitoring, CI, bảo mật, phục hồi | 3, tăng dần |
| SEO/content delivery | Metadata, canonical, sitemap XML, robots, structured data trung thực | 2 nền tảng; 3 thật |
| Integrations | Nhà xuất bản, thanh toán, vận chuyển, kế toán; adapter boundary | 4/5 |

## Quy tắc ranh giới

- Module sở hữu dữ liệu và use case của mình; không cho UI tự sửa ledger hay trạng thái payment.
- Catalog mô tả sách; pricing định giá SKU; inventory quyết định khả dụng; order chụp dữ liệu tại thời điểm giao dịch.
- News có thể dẫn đến Product/Series nhưng không sở hữu metadata sách.
- Reader review khác nội dung biên tập đã duyệt; cần moderation riêng.
- Một module được liệt kê không có nghĩa dependency, endpoint, schema, credential hoặc màn hình của nó đã tồn tại.
