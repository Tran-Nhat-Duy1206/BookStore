# Kiến trúc dự kiến

## Quyết định nền tảng

**Modular monolith**: một ứng dụng triển khai chính với ranh giới nghiệp vụ rõ, chưa cần microservices. Thiết kế này đã được chọn làm định hướng, không khẳng định cấu trúc thư mục hay backend đã tồn tại.

| Thành phần | Định hướng | Trạng thái tài liệu |
|---|---|---|
| Next.js App Router + React | Routing, render nội dung, server/client boundary | Phase 2 dự kiến/đối chiếu mã nguồn khi nghiệm thu |
| TypeScript | Kiểu dữ liệu và hợp đồng module | Dự kiến |
| Tailwind CSS | Styling dựa semantic tokens | Dự kiến |
| Motion | Chuyển động tương tác nhỏ, tôn trọng reduced motion | Dự kiến |
| Fixture repository | Nguồn dữ liệu demo xác định, không API giả nhận giao dịch | Phase 2 dự kiến |
| PostgreSQL | Lưu trữ quan hệ và transaction khi có backend | Phase 3 trở đi, chưa triển khai ở demo |
| Prisma | ORM/migration được khuyến nghị để đánh giá | **Tương lai, không cài trong milestone này** |
| External payment/shipping/storage | Adapter riêng khi có nhu cầu | Chưa tích hợp, không credentials |

## Luồng phụ thuộc

```text
Next routes / UI
      ↓
Application use cases (catalog, editorial, releases; commerce tương lai)
      ↓
Domain contracts + repository interfaces
      ↑
Adapters: fixture (Phase 2) → PostgreSQL/ORM (Phase 3+)
```

UI không phụ thuộc trực tiếp chi tiết ORM. Fixture adapter có cùng hợp đồng đọc cốt lõi để thay nguồn dữ liệu mà không thay nghĩa Work/Edition/SKU. Không tạo fake checkout endpoint để làm demo trông như hoạt động thật.

## Phân lớp dự kiến

- **Presentation:** routes, layout, accessible components; phân trang, filter và trạng thái tương tác.
- **Application:** orchestration use case; validation đầu vào; quyền; transaction boundary.
- **Domain:** entity/value object, invariants sách, ngày phát hành, giá, reservation.
- **Infrastructure:** repository, database, media, provider adapters; không kéo dependency hạ tầng vào component dùng chung.

Tên thư mục cụ thể phải theo cấu trúc mã nguồn thực tế; tài liệu không yêu cầu tự tạo scaffold ngoài phạm vi.

## Quy ước Next/React dự kiến

- Ưu tiên server rendering cho trang nội dung và SEO; Client Component chỉ nơi thực sự có tương tác.
- Dữ liệu catalog công khai có thể cache theo chính sách; preview/quản trị không cache chung; tồn kho/giá trong checkout tương lai phải tính lại phía server.
- Route slug có thể thay đổi nhưng định danh domain phải ổn định; có chiến lược redirect/canonical khi chuyển slug.
- Không lộ database URL, signing secret hay token qua biến public hoặc bundle client.
- Các use case cross-module dùng contract/event nội bộ có version; chưa cần message broker. Outbox có thể bổ sung khi xử lý sự kiện bền vững thật.

## Backend tương lai

PostgreSQL cung cấp khóa ngoại, unique constraints và transaction cho metadata lẫn stock ledger. Đánh giá Prisma với transaction, migrations, query quan trọng, connection pooling và runtime compatibility trước khi chọn chính thức. Migration phải review, có kế hoạch backup/rollback; không chạy production migration từ demo.

## Vận hành dự kiến

Cấu hình theo môi trường, logs không PII, theo dõi lỗi/latency, backup và thử phục hồi, health checks, dependency/security review. Không mặc định cài analytics, cloud SDK, database hoặc dịch vụ tính phí chỉ vì được nêu trong kiến trúc.

Quyết định và đánh đổi: [ADRs](<./adrs.md>).
