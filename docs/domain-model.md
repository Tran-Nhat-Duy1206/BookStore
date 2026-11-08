# Mô hình miền sách dự kiến

Tách **nội dung trí tuệ**, **ấn bản xuất bản** và **đơn vị bán/giữ kho**. Đây là thiết kế tương lai; không khẳng định đã có schema hoặc migration.

## Thuật ngữ và quan hệ

| Khái niệm | Ý nghĩa | Không được đồng nhất với |
|---|---|---|
| Work | Tác phẩm trừu tượng, tiêu đề gốc, tác giả, mô tả nội dung | ISBN, bản dịch, SKU |
| Series | Nhóm tác phẩm/tập có liên hệ, thứ tự xuất bản hoặc thứ tự đọc | Một SKU hay một box set |
| Volume | Đơn vị tập logic trong series; có nhãn, thứ tự sortable, loại chính/ngoại truyện | Mỗi lần tái bản hoặc mỗi cuốn vật lý |
| EditionContent | Bản ghi nối Edition với Work/Volume, thứ tự và phạm vi nội dung được bao gồm | Bản thân Edition hay hàng tồn |
| Edition | Một ấn bản cụ thể: ngôn ngữ, dịch giả, nhà xuất bản, định dạng, lần in/ấn bản khi cần, ISBN nếu có | Trang bán hàng hoặc một bản copy vật lý |
| Product | Offer/merchandising entity có slug, nội dung trưng bày và loại single/box/bundle | Work, hoặc số lượng tồn |
| SKU | Biến thể thương mại cụ thể được định giá, bán và theo dõi tồn | ISBN hoặc Product slug |

Quan hệ dự kiến:

- Series có nhiều Volume; Volume liên kết Work theo quy tắc metadata. Work có thể xuất hiện trong nhiều ngữ cảnh series qua quan hệ riêng, không ép một Work chỉ có một series.
- Edition có nhiều EditionContent; mỗi dòng tham chiếu Work và có thể Volume, với `sequence`, phạm vi chương/phần và ghi chú đầy đủ/rút gọn nếu cần.
- Một Work/Volume có thể xuất hiện ở nhiều Edition. Đây là quan hệ nhiều–nhiều thông qua EditionContent, không phải cột `volumeNumber` đơn trên Edition.
- Product có một hay nhiều SKU. SKU sách đơn gắn Edition; SKU box/bundle gắn cấu phần theo quy tắc bên dưới. Không bắt buộc mọi sản phẩm hàng hóa tương lai phải có Edition.
- ISBN là identifier của ấn bản phù hợp, không dùng làm primary key SKU; có sách không có ISBN và tái bản cần xác minh identifier.

## Ví dụ tránh nhập nhằng

### Omnibus

Một ấn bản gộp nội dung tập 1–3 trong **một cuốn**: một Edition, ba EditionContent có thứ tự/phạm vi, một Product và SKU của cuốn đó. Kho đếm cuốn omnibus, không tự trừ SKU bản tập lẻ 1/2/3.

### Box set

Một hộp vật lý của nhà xuất bản gồm nhiều cuốn: Product loại box, SKU hộp đóng gói riêng nếu nhập/xuất như hộp; composition ghi số lượng từng Edition/SKU. Tồn hộp và tồn tập lẻ độc lập cho đến khi có nghiệp vụ tháo/đóng hộp ghi ledger; không cộng hai bên để bán trùng.

### Bundle

Gói bán do cửa hàng tạo, ví dụ hai sách + bookmark, không nhất thiết có ISBN riêng. Nếu **virtual bundle**, khả dụng tính từ component SKU và mỗi component được reserve/xuất theo số lượng; không tạo thêm tồn của bundle. Nếu **prepacked bundle**, có SKU tồn riêng và nghiệp vụ chuyển đổi component thành gói được ghi ledger. Chọn rõ chế độ, không kết hợp hai cách để đếm trùng.

## Quy tắc dữ liệu dự kiến

- ID ổn định tách khỏi slug. Tiêu đề tiếng Việt có Unicode và normalization nhất quán.
- Contributors có vai trò tác giả/dịch giả/họa sĩ/biên tập; vai trò ở Work và Edition khác nhau.
- Ngôn ngữ, khổ sách, số trang, binding và nhà xuất bản thuộc Edition theo nguồn; không suy đoán từ ảnh.
- Volume dùng `sortOrder` riêng khỏi nhãn “Tập 0”, “Ngoại truyện”, “1.5”; thứ tự đọc có thể khác thứ tự xuất bản.
- Giá tiền dùng đơn vị tiền tệ và số nguyên theo đơn vị nhỏ nhất hoặc decimal chính xác; không dùng floating point tùy tiện. Giá fixture không phải giá cam kết.
- Composition không được tạo vòng lặp; số lượng cấu phần nguyên dương; có version để đơn hàng tương lai lưu snapshot.
- Product/Edition chưa xuất bản không được hiện công khai chỉ vì tồn tại trong database.
- Điều chỉnh metadata không được làm thay đổi ngầm order snapshot hoặc ledger đã ghi.

Liên quan: [Tồn kho](<./inventory.md>), [CMS và releases](<./cms-releases.md>).
