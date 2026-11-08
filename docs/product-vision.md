# Tầm nhìn và phạm vi sản phẩm

**Trạng thái:** định hướng được duyệt; chức năng dưới đây là dự kiến nếu chưa có bằng chứng nghiệm thu riêng.

## Tầm nhìn

Cozy Bookstore là không gian khám phá sách tiếng Việt ấm áp, chậm rãi và đáng tin cậy: tìm được cuốn sách phù hợp, hiểu đúng phiên bản, theo dõi bộ truyện và lịch phát hành. Cảm giác quán sách gần gũi không được dùng để giả định đã có cửa hàng vật lý.

### Nhóm người dùng dự kiến

- Độc giả phổ thông: duyệt sách theo chủ đề, đọc giới thiệu và tin biên tập.
- Người sưu tầm/đọc series: phân biệt tập, bản dịch, tái bản, omnibus và box set.
- Biên tập viên: chuẩn hóa metadata, chuẩn bị nội dung, công bố lịch phát hành có nguồn.
- Nhân sự vận hành tương lai: quản lý giá, SKU, kho, đơn hàng, POS khi được phê duyệt.

## Kết quả mong muốn

1. Giao diện dễ đọc trên điện thoại và desktop, ưu tiên nội dung hơn áp lực mua hàng.
2. Danh mục sách không nhầm tác phẩm với phiên bản thương mại.
3. Tin tức và lịch phát hành minh bạch: dự kiến khác ngày chính thức; fixture khác dữ liệu thật.
4. Nền tảng đủ cấu trúc để bổ sung nghiệp vụ, không triển khai thương mại sớm.

## Phạm vi theo mốc

- **Phase 2 — Frontend demo:** layout, điều hướng, catalog, chi tiết sách/series, tin tức, lịch phát hành; fixture; wishlist/cart có thể minh họa cục bộ và ghi rõ không nhận đơn.
- **Phase 3 — Catalog–news MVP:** dữ liệu bền vững và quy trình biên tập có kiểm soát; catalog/news/releases hoạt động thực khi có nghiệm thu. **Commerce vẫn tắt.**
- **Phase 4 — Commerce:** chỉ bắt đầu sau phê duyệt riêng về thanh toán, pháp lý, dữ liệu, tồn kho và vận hành.
- **Phase 5 — Readers/POS:** tài khoản/cộng đồng độc giả mở rộng và điểm bán vật lý, khi thực sự có nhu cầu và điều kiện.

Chi tiết: [Lộ trình](<./roadmap.md>) và [Danh mục module](<./module-inventory.md>).

## Không thuộc milestone hiện tại

- Checkout, tạo đơn thật, thu tiền, hoàn tiền, đăng nhập/đăng ký khách hàng và lưu dữ liệu cá nhân thật.
- Hứa hẹn còn hàng, giao hàng, đổi trả, địa chỉ hoặc giờ mở cửa chưa được xác nhận.
- CMS production, backend/database production, tích hợp đối tác, email/SMS thực.
- Search engine ngoài, recommendation AI, microservices, POS, dịch vụ trả phí.

## Tiêu chí đánh giá dự kiến

Đánh giá hành trình khám phá sách, khả năng phân biệt phiên bản, độ rõ nguồn/ngày phát hành, khả năng truy cập và tính nhất quán trạng thái demo. Các KPI conversion, doanh thu, SLA chỉ được đặt khi có baseline và commerce được phê duyệt; không bịa số liệu tăng trưởng hoặc phản hồi khách hàng.
