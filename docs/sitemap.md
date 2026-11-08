# Sitemap và navigation — Frontend Foundation

Các route dưới đây đã có source và được browser regression kiểm tra trong milestone. Tất cả nội dung là fixture/demo, không phải commerce production. Bằng chứng và giới hạn nằm trong [validation](./validation.md).

| Route | Nội dung hiện tại | Trạng thái |
|---|---|---|
| `/` | Editorial hero, categories, books, series, news, releases | Implemented demo |
| `/catalog` | Accent-insensitive search, category filter, sorting, URL và empty state | Implemented demo |
| `/products/[slug]` | 12 sách/ấn bản hư cấu, metadata, series links, trial cart/wishlist | Implemented demo; không ISBN/giá/tồn thật |
| `/series/[slug]` | 2 series, thứ tự các ấn bản, ví dụ omnibus | Implemented demo |
| `/news` | 6 bài, featured announcement, category filter | Implemented demo |
| `/news/[slug]` | Bài viết, ngày mẫu, related books | Implemented demo |
| `/releases` | 5 release mẫu, status filter; day/month/quarter/unknown | Implemented demo |
| `/wishlist` | Local wishlist, empty state, xóa và focus handoff | Implemented local-only |
| `/cart` | Local trial cart, quantity 1–9, xóa, empty state | Implemented local-only; không checkout |

## Điều hướng

- Desktop: brand/home → Kệ sách → Manga shortcut → Lịch phát hành → Chuyện tiệm sách.
- Mobile: menu drawer có search, cùng destinations; header có search trực tiếp.
- Series được truy cập từ homepage và product links, không cần trang index rỗng.
- Wishlist là page link; cart icon mở quick drawer, từ đó tới trang giỏ.
- Category/search results → product → series → các volume/edition.
- News → article → related product hoặc release agenda.
- Footer chỉ có liên kết hoạt động; không contact/address/store hours giả.

## Fallbacks và commercial boundary

- Unknown product/article/series slug dùng not-found; browser suite kiểm chứng một product slug sai trả 404.
- Route loading/error có giao diện chung; không cố ý gây lỗi runtime production để chụp trạng thái.
- `/checkout`, `/auth`, `/api/checkout`, `/api/orders`, `/api/payments` không được triển khai; browser request tests xác nhận không nhận POST thương mại thành công.
- Toàn bộ demo có metadata `noindex, nofollow`, không structured data giả về Product/InStock/rating/LocalBusiness.
- Đây là navigation sitemap, không phải sitemap XML production.

## Tương lai, chưa triển khai

Work-level route, comparison, checkout/order tracking, customer account/bookshelf, notifications, admin, support, policies được duyệt, events và physical locations chỉ mở trong phase tương ứng. Không tạo dead links để mô phỏng các module này.
