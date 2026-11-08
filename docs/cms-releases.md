# CMS, nội dung và lịch phát hành dự kiến

**Phase 2 dùng fixture; Phase 3 mới dự kiến CMS thực.** Không khẳng định có trang quản trị, lịch chạy hay nguồn dữ liệu production.

## Workflow biên tập

`draft → in_review → scheduled/published → archived` là workflow đề xuất. Trả về draft khi cần sửa; quyền publish khác quyền viết. Revision, actor, timestamp, lý do thay đổi và preview phải rõ; bản nháp không lọt qua API công khai/cache/search index.

Nội dung news dự kiến gồm ID, slug, tiêu đề, excerpt, body có cấu trúc/được sanitize, cover và alt, tác giả/biên tập, chuyên mục/tags, publishedAt, updatedAt và liên kết Product/Series có kiểm tra tham chiếu. Không chèn script hoặc raw HTML không kiểm soát.

## Phân biệt các ngày

- **Ngày xuất bản bài viết**: timestamp thời điểm bài được công khai; không phải ngày sách phát hành.
- **Ngày phát hành sách**: thông tin miền gắn Edition hoặc đợt phát hành có nguồn. Tái bản hoặc đổi lịch có thể là sự kiện riêng.
- **Thời điểm hệ thống ghi nhận/chỉnh sửa**: audit timestamp; không dùng thay ngày phát hành chưa biết.

## Độ chính xác ngày phát hành

Dự kiến một trường precision rõ ràng cùng dữ liệu tương ứng:

| Precision | Dữ liệu | Hiển thị |
|---|---|---|
| `day` | Ngày lịch ISO `YYYY-MM-DD` hợp lệ | “Dự kiến 18/09/2027” hoặc “18/09/2027” theo mức xác nhận |
| `month` | Năm + tháng, không tự thêm ngày | “Tháng 09/2027” |
| `quarter` | Năm + quý | “Quý III/2027” |
| `year` | Năm | “Năm 2027” |
| `unknown` | Không có ngày | “Chưa công bố ngày” |

Các giá trị ở bảng là **ví dụ minh họa**, không phải lịch phát hành sách có thật. Không biến “tháng 9” thành ngày 01/09 hoặc “năm 2027” thành 01/01 để giả độ chính xác. Không suy đoán năm thiếu từ ngữ cảnh mà không kiểm tra nguồn.

- `certainty`: tentative/confirmed độc lập với precision; ngày chính xác vẫn có thể chỉ dự kiến.
- `status`: planned/delayed/released/cancelled theo nguồn; không tự chuyển “released” chỉ vì ngày đã qua.
- Date-only lưu như ngày lịch, không chuyển qua UTC làm lệch ngày. Timestamp bài viết lưu theo chuẩn thống nhất và trình bày theo `Asia/Ho_Chi_Minh`; lịch scheduled cần timezone rõ ràng.
- Với khoảng thời gian, lưu start/end và precision thật, không chọn ngẫu nhiên một ngày đại diện.
- Validation bắt ngày hợp lệ, tháng/quý hợp lệ, khoảng ngày có thứ tự, trường dữ liệu khớp precision.

## Nguồn và thay đổi

Release cần source URL/tên nguồn, thời điểm kiểm tra, ghi chú và người xác nhận. Ưu tiên nhà xuất bản/đơn vị phát hành; nguồn thứ cấp phải ghi rõ. Đổi lịch giữ lịch sử ngày cũ, ngày mới, lý do, nguồn và timestamp. Không thay ngày lịch sử để làm giống “đúng từ đầu”.

## Hiển thị và tìm kiếm

Lịch hiển thị nhãn “Dự kiến”, “Chưa xác định” và thông báo fixture khi là demo. Sắp xếp ngày không chính xác theo nhóm tháng/quý/năm phù hợp, không đưa ngày ảo vào structured data. Nội dung cần kiểm tra quyền sử dụng ảnh, alt text, Unicode tiếng Việt, liên kết hỏng và metadata SEO trung thực trước khi xuất bản.
