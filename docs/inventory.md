# Thiết kế tồn kho và reservation — tương lai

**Phase 4 dự kiến, chưa có kho/tồn thật được xác nhận.** Phase 2/3 không nhận đơn, không giữ hàng. Nhãn tồn ở fixture phải mang nghĩa minh họa, không phải lời hứa bán.

## Đơn vị quản lý

Tồn kho được xác định bởi **SKU × location**. Location là kho/điểm bán/vùng quản lý đã được vận hành xác nhận, không suy ra từ địa chỉ giả. Hàng hư, cách ly hoặc đang vận chuyển không tự tính là khả dụng bán.

Dự kiến:

- `onHand`: hàng đang thuộc số dư tại location theo ledger.
- `reserved`: tổng reservation đang hiệu lực và có thể phân bổ bán.
- `unavailable`: lượng bị cách ly/hư hỏng, không trùng phần reserved.
- `available = onHand - reserved - unavailable` cho cùng SKU/location và chính sách đã chọn.
- Không nhận giá trị âm để che oversell; phát hiện sai lệch phải báo lỗi/đối soát. Hàng inbound và preorder là nghiệp vụ riêng, không giả thành onHand.

## Ledger bất biến

Mỗi movement gồm ID, SKU, location, delta có dấu, loại nghiệp vụ, thời điểm, tham chiếu chứng từ, actor và idempotency key. Các loại dự kiến: nhập mua, xuất bán, hoàn hàng qua kiểm tra, điều chỉnh kiểm kê, chuyển kho, đóng/tháo box/bundle.

- Không sửa/xóa lịch sử để đổi số dư; dùng bút toán đảo và bút toán đúng có lý do.
- Balance/materialized view chỉ là projection; có khả năng đối chiếu tổng ledger.
- Chuyển kho có hai phía và trạng thái in-transit minh bạch; không cộng hàng vào hai location cùng lúc.
- Phân quyền điều chỉnh, lưu audit; giá vốn/kế toán là phần thiết kế riêng.

## Reservation dự kiến

Chu trình: `active → committed | released | expired`. TTL do nghiệp vụ quyết định; không mặc định giỏ hàng đã giữ tồn.

1. Checkout tương lai đọc giá và availability lại phía server.
2. Transaction khóa/điều kiện cập nhật theo SKU/location, xác nhận đủ tồn và tạo reservation duy nhất.
3. Payment thành công không tự xuất hàng hai lần: commit reservation theo use case order/fulfillment có idempotency.
4. Hủy/hết hạn/thanh toán thất bại giải phóng đúng một lần.
5. Race giữa expiry và payment webhook phải có state transition nguyên tử; nếu không còn reservation, xử lý exception/refund theo chính sách, không bán vượt tồn âm thầm.

`committed` không tự có nghĩa ledger đã xuất nếu quy trình xuất kho tại lúc ship; phải xác định thời điểm ghi xuất và loại trừ committed allocation khỏi lượng bán được đến khi xuất. Không trừ reservation và ledger hai lần cho cùng lượng hàng.

## Invariants và kiểm thử đề xuất

- Ledger và allocation liên quan được ghi trong transaction thích hợp.
- Concurrent checkout không cùng chiếm một đơn vị cuối; request/webhook retry không tạo duplicate.
- Expiry, cancel, return, partial shipment và transfer có reconciliation.
- Virtual bundle reserve mọi component nguyên tử theo số lượng tối thiểu; prepacked bundle dùng tồn SKU gói.
- Không trừ kho theo Work, Series, Product hay ISBN; chỉ SKU/location hợp lệ.
- Kiểm thử clock/TTL, deadlock retry, rollback, audit, kiểm kê và backup/restore trước khi bật commerce.
