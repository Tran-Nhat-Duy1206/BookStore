# Sitemap: dự kiến và bằng chứng triển khai

**Sổ trạng thái của tài liệu:** bảng dưới đây giữ phạm vi thiết kế, không phải danh sách route đã kiểm chứng. Implementation frontend hiện đã được agent điều phối bổ sung; báo cáo validation của agent điều phối là nguồn có thẩm quyền về trạng thái thực. Không suy ra mọi route đã được kiểm chứng từ việc xuất hiện trong bảng hoặc dependency đã cài. Cột bằng chứng chỉ được cập nhật sau khi đối chiếu mã nguồn và kiểm tra. Sitemap điều hướng này khác sitemap XML SEO.

| Route | Nội dung dự kiến | Trạng thái/bằng chứng trong hồ sơ |
|---|---|---|
| `/` | Trang chủ, tuyển chọn sách, series, tin và lịch phát hành | Dự kiến; chưa xác nhận |
| `/catalog` | Danh mục, tìm kiếm/lọc/sắp xếp, empty state | Dự kiến; chưa xác nhận |
| `/products/[slug]` | Chi tiết Product, Edition/ISBN, nội dung tập, SKU minh họa | Dự kiến; chưa xác nhận |
| `/series/[slug]` | Tổng quan series, thứ tự tập/đọc, các Edition liên quan | Dự kiến; chưa xác nhận |
| `/news` | Danh sách bài biên tập | Dự kiến; chưa xác nhận |
| `/news/[slug]` | Bài viết, nguồn, thời điểm xuất bản, liên kết sách | Dự kiến; chưa xác nhận |
| `/releases` | Lịch theo precision và certainty, không dùng ngày ảo | Dự kiến; chưa xác nhận |
| `/wishlist` | Danh sách yêu thích demo/local nếu được xây | Dự kiến; chưa xác nhận; không customer auth |
| `/cart` | Giỏ minh họa nếu được xây, thông báo không nhận đơn | Dự kiến; chưa xác nhận; checkout tắt |

## Cấu trúc điều hướng dự kiến

Header: trang chủ → catalog → series qua liên kết nội dung → news → releases; wishlist/cart là tiện ích demo có nhãn phù hợp. Footer chỉ dùng liên hệ, chính sách và địa chỉ đã được xác nhận; không bịa địa chỉ/giờ mở cửa để lấp chỗ trống.

## Quy tắc route

- Slug không tồn tại trả not-found phù hợp; không trả trang fixture đầu tiên như thể khớp slug.
- Query filter/search cần URL rõ, có trạng thái rỗng, reset và khả năng back/forward.
- Không có `/checkout`, `/login`, `/register`, `/payment` hoạt động trong milestone; không tạo link chết hoặc CTA giả tới các route này.
- Route động có metadata/canonical theo nội dung thực; không tạo schema Product “InStock” hoặc rating giả từ fixture.
- Wishlist/cart demo không được index như nội dung biên tập. Chính sách robots/noindex theo môi trường cần được thiết kế và xác nhận, không coi là đã cấu hình.
- CMS/admin và route commerce tương lai chưa thuộc sitemap công khai đã duyệt; cần quyết định riêng trước khi thêm.

Liên quan: [CMS/releases](<./cms-releases.md>), [An toàn](<./security.md>).
