# Chạy bản demo release tại máy

`staging-demo` chỉ chạy bản dựng storefront ở chế độ đọc fixture trên máy hiện tại. Sách, tác giả, bài viết và lịch phát hành đều hư cấu. Giỏ hàng và danh sách yêu thích chỉ lưu trong trình duyệt, không tạo giao dịch, giữ hàng hay sửa dữ liệu trên máy chủ. Không mở tài khoản, quản trị, đặt trước, checkout hoặc thanh toán. Đây không phải staging với dữ liệu thật hay quy trình triển khai production; `NODE_ENV=production` chỉ là chế độ chạy bản dựng của Next.js.

## Điểm khởi chạy và cấu hình

```text
pnpm exec tsx scripts/start-release.ts staging-demo [--port=NNNN]
```

- Launcher chỉ lắng nghe tại `127.0.0.1`, mặc định cổng `3001`. Nếu chỉ định cổng, dùng đúng dạng `--port=NNNN` với số thập phân chuẩn từ `1024` đến `65535`, không có dấu, khoảng trắng hay số 0 đứng đầu. Cổng `3000` và các cổng bị Next.js giới hạn (ví dụ `6000`) không được phép. Không có tùy chọn đổi host.
- `staging-real` và `production-real` là hai chế độ được nhận diện nhưng bị chặn; không chế độ nào khởi động máy chủ với dữ liệu thật. `pnpm start` là lệnh tương thích gọi thẳng `next start`, không qua các kiểm tra cấu hình hay ràng buộc host/cổng của launcher. Không dùng lệnh đó để thay thế launcher khi kiểm tra bản demo release.
- Launcher xét môi trường tiến trình được kế thừa, không đọc tệp `.env*` để chọn chế độ. Phải đặt rõ `DATA_SOURCE=fixture` đúng nguyên văn; giá trị mặc định của storefront không thay cho yêu cầu này. `DATABASE_URL`, `TEST_DATABASE_URL` và `BOOKSTORE_LOCAL_DB_READS` phải vắng mặt hoặc là chuỗi rỗng; mọi giá trị không rỗng, kể cả chỉ chứa khoảng trắng, đều bị từ chối.
- Khi gọi Next.js, launcher đặt `DATA_SOURCE=fixture` và `NODE_ENV=production`, đồng thời truyền cả ba biến database ở trên dưới dạng chuỗi rỗng để Next.js không nạp lại các giá trị đó từ tệp `.env*`. Launcher cũng bỏ `NODE_OPTIONS`, `NODE_PATH`, `PORT`, `HOSTNAME` và các biến nội bộ `__NEXT_PRIVATE_*` được kế thừa khỏi môi trường tiến trình con. Đây là cấu hình cho lần chạy demo, không phải bộ lọc toàn bộ môi trường hay kiểm soát triển khai.

## Build và chạy

Từ thư mục gốc repository, dùng phiên shell dành riêng cho demo và cài dependencies theo [README](../README.md#chạy-tại-máy). Launcher cần bản dựng storefront từ `pnpm build` và không tự build. Không chạy migrations, seed hoặc dịch vụ database cho demo này. Tách môi trường build khỏi cấu hình có thông tin kết nối thật; launcher chỉ bảo vệ lần khởi chạy, không sửa cấu hình hay nội dung của bản dựng đã có.

**POSIX shell** — cổng mặc định, `http://127.0.0.1:3001`:

```sh
unset DATABASE_URL TEST_DATABASE_URL BOOKSTORE_LOCAL_DB_READS
export DATA_SOURCE=fixture
pnpm build && pnpm exec tsx scripts/start-release.ts staging-demo
```

**PowerShell** — ví dụ chọn cổng `3002`, `http://127.0.0.1:3002`:

```powershell
Remove-Item Env:DATABASE_URL, Env:TEST_DATABASE_URL, Env:BOOKSTORE_LOCAL_DB_READS -ErrorAction SilentlyContinue
$env:DATA_SOURCE = 'fixture'
pnpm build
if ($LASTEXITCODE -ne 0) { throw 'Build failed; demo not started.' }
pnpm exec tsx scripts/start-release.ts staging-demo --port=3002
```

## Kiểm tra và dừng

1. Giữ launcher ở phiên terminal chạy foreground. Kiểm tra nó không báo lỗi hoặc thoát và dùng đúng địa chỉ/cổng của lần chạy. Kiểm tra cổng trước khi khởi động không giữ chỗ: socket kiểm tra đã đóng trước khi Next.js bind, nên tiến trình khác có thể lấy cổng trước. Nếu cổng bận hoặc lần chạy thoát, không xem trang đang trả lời trên cổng đó là demo của mình. Không dừng tiến trình khác; sửa cấu hình hoặc chọn một cổng hợp lệ còn trống rồi chạy lại.
2. Không có endpoint readiness; log khởi động hay cổng mở không chứng minh storefront hoạt động. Từ terminal thứ hai, chỉ kiểm tra các trang dưới đây khi launcher của mình vẫn chạy. Giới hạn tối đa 5 giây mỗi yêu cầu, không tự lặp; nếu timeout, khác `200` hoặc nội dung không khớp, coi lần chạy chưa đạt và xem thông báo lỗi. Kiểm tra GET `/catalog` trên POSIX: `curl --noproxy 127.0.0.1 --max-time 5 -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/catalog`. Trên PowerShell: `curl.exe --noproxy 127.0.0.1 --max-time 5 -sS -o NUL -w '%{http_code}\n' http://127.0.0.1:3002/catalog`. Thay cổng và đường dẫn theo lần chạy thực tế.
3. Kiểm tra nhanh nội dung: `/` có thương hiệu **Cá Tỏ BookStore** và dòng “Bản trình diễn · Sách minh họa · Chưa mở bán”; `/catalog` có “Khu vườn sau cơn mưa”; `/products/khu-vuon-sau-con-mua` hiển thị đúng tên sách và tác giả hư cấu An Nhiên; `/releases` ghi rõ các mốc lịch là hư cấu. Trên trang chủ, phần lịch minh họa nói rõ đây không phải thông báo phát hành hoặc nhận đặt trước; footer ghi “Không tài khoản. Không thanh toán.” Đây chỉ là kiểm tra hiển thị fixture, không phải chứng nhận readiness hay phê duyệt triển khai.
4. Khi xong hoặc khi kiểm tra thất bại, nhấn `Ctrl+C` ở terminal đã chạy launcher và chờ tiến trình của lần chạy đó thoát. Nếu vẫn còn listener, xác minh quyền sở hữu trước khi xử lý; không dừng tiến trình chỉ vì nó đang dùng cổng đã chọn. Không mở demo ra mạng bằng proxy hoặc tunnel và không dùng để phục vụ lưu lượng production.
