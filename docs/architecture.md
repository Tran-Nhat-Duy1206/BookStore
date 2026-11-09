# Kiến trúc dự kiến

## Quyết định nền tảng

**Modular monolith**: một ứng dụng với ranh giới nghiệp vụ rõ, chưa cần microservices. Frontend Foundation đã merge; Batch3.1 bổ sung catalog read boundary và local persistence. Admin/backend nghiệp vụ ngoài catalog read vẫn chưa triển khai. [Phase3 plan](./phase3-plan.md) phân biệt batch được duyệt và phần tương lai.

| Thành phần | Định hướng | Trạng thái tài liệu |
|---|---|---|
| Next.js App Router + React | Routing, render nội dung, server/client boundary | Frontend Foundation đã triển khai |
| TypeScript | Public DTO/read contracts | Đã triển khai |
| Tailwind CSS | Semantic tokens | Giữ nguyên |
| Motion | Hiệu ứng nhỏ/reduced motion | Giữ nguyên |
| Fixture repository | Typed default adapter, không DB dependency | Batch3.1 |
| PostgreSQL | Isolated local/CI catalog persistence | Batch3.1; không production |
| Prisma | Client/adapter/CLI7.10.1, migrations/seed | Batch3.1 được duyệt |
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

## Catalog persistence hiện tại và backend tương lai

[ADR-010](./adr-010-catalog-persistence.md) và [local guide](./catalog-database.md) mô tả14 catalog tables, reviewed additive migrations, seed hư cấu, UUID/public IDs và read-only PostgreSQL projection. Storefront lấy public book manifest từ server, không ORM types/records. Fixture là mặc định; database failures không fallback. Runtime dynamic rendering tránh fixture HTML cũ khi đổi source; request memoization không phải public persistent cache.

Stock ledger, admin identity, authorization và publishing là batch sau, chưa triển khai. Không chạy production migration hoặc mở commerce từ demo.

## Vận hành dự kiến

Cấu hình theo môi trường, logs không PII, theo dõi lỗi/latency, backup và thử phục hồi, health checks, dependency/security review. Không mặc định cài analytics, cloud SDK, database hoặc dịch vụ tính phí chỉ vì được nêu trong kiến trúc.

Quyết định và đánh đổi: [ADRs](<./adrs.md>).
