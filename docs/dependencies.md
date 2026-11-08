# Dependency và môi trường hiện tại

Snapshot phiên bản do agent điều phối cung cấp trong đợt triển khai Frontend Foundation. Đây là ghi nhận toolchain/dependency, **không phải kết luận mọi route hoặc bài kiểm thử đã đạt**. Kết quả và giới hạn kiểm chứng thuộc báo cáo validation của agent điều phối.

## Phiên bản được lựa chọn

| Thành phần | Phiên bản | Ghi chú |
|---|---|---|
| Next.js | 16.4.5 | App Router |
| React | 19.3.1 | Giao diện frontend |
| TypeScript | 6.0.3 | Giữ trong khoảng tương thích parser `<6.1` |
| Tailwind CSS | 4.3.5 | Styling |
| Motion | 14.10.1 | Motion tương tác, cần reduced-motion |
| Radix | 1.3.1 | UI primitives |
| Fontsource | 5.3.0 | Font assets; Lora và Be Vietnam Pro |
| ESLint | 9.39.5 | Giữ phiên bản 9 do tương thích plugin |
| Prettier | 3.9.1 | Formatting toolchain |
| Vitest | 5.1 | Unit/integration testing toolchain |
| Playwright | 1.65 | E2E/browser testing toolchain |
| pnpm | 11.7.0 | Package manager |
| Node.js môi trường kiểm chứng | 24.19 | Môi trường agent điều phối dùng; không tự suy ra kết quả chạy |

Node engines được khai báo: `^22.12 || ^24 || >=26`. Khoảng engines là chính sách phiên bản, không có nghĩa tất cả phiên bản trong khoảng đều đã được kiểm thử. Đối chiếu manifest/lockfile thật khi setup và sau mọi thay đổi dependency; không dùng snapshot tài liệu thay cho lockfile.

## Tương thích và nợ tooling

- TypeScript 7 không được chọn vì parser hiện tại yêu cầu TypeScript `<6.1`; giữ TypeScript 6.0.3. Nâng major phải đánh giá đồng bộ parser, Next, ESLint và test tools, không chỉ sửa một version.
- ESLint 9.39.5 được giữ vì React plugin có peer range `^9.7`, chưa hỗ trợ ESLint 10 trong cấu hình được chọn. Cảnh báo deprecated của tooling là **nợ kỹ thuật đã biết**, không nên che giấu hoặc ép nâng major vượt peer compatibility để xóa cảnh báo.
- Trước khi nâng cấp, kiểm tra release notes/peer dependencies và chạy lại các lệnh thực có trong dự án; ghi kết quả riêng. Không coi snapshot này là audit lỗ hổng hay bảo đảm hỗ trợ lâu dài.

## Không được cài/bật cho milestone

Prisma và database backend chưa được cài/triển khai cho demo. PostgreSQL là định hướng tương lai; Prisma là khuyến nghị cần review ở Phase 3. Không có dịch vụ trả phí được phê duyệt, không credentials, không payment/auth/checkout thật. Dependency UI hoặc test runner tồn tại không chứng minh dịch vụ thương mại đã hoạt động.

Liên quan: [Phát triển và kiểm thử](<./development.md>), [Kiến trúc](<./architecture.md>), [ADRs](<./adrs.md>).
