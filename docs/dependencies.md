# Dependency và môi trường hiện tại

Snapshot frontend toolchain cùng phần bổ sung Batch3.1 catalog database phía dưới. Đây là ghi nhận toolchain/dependency, **không phải kết luận mọi route hoặc bài kiểm thử đã đạt**. Kết quả và giới hạn kiểm chứng thuộc báo cáo validation của agent điều phối.

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

## Batch 3.1 — approved local catalog persistence

| Package/runtime | Pinned version | Purpose |
|---|---|---|
| prisma / @prisma/client / @prisma/adapter-pg | 7.10.1 | Stable CLI, generated server client and PostgreSQL driver adapter |
| pg / @types/pg | 8.23.1 | PostgreSQL protocol and types |
| tsx | 4.23.15 | Local TypeScript seed/migration/test tooling |
| dotenv | 18.0.9 | Ignored local CLI configuration; existing environment wins |
| server-only | 0.0.1 | Next server/client boundary |
| PostgreSQL | 18; Compose/CI image18.3-alpine | Isolated local/ephemeral catalog databases only |

Prisma CLI registry latest pointed to8.0.0-rc.33 during selection; use stable7.10.1 rather than installing the RC. Prisma's Node range includes the selected Node24.19.0 and its TypeScript peer accepts6.0.3. pnpm allows only the required engines/esbuild/Prisma lifecycle scripts by package name.

The pg8 driver currently emits a query-queue deprecation warning on transaction/error paths; tests use the supported pinned major8, not pg9. Track upstream compatibility before a major upgrade rather than suppressing warnings. ESLint9 debt remains separately documented above.

PostgreSQL/Prisma are now authorized for Batch3.1 only. No cloud/production credentials, paid services, auth/admin mutations, inventory operations, payment/checkout or deployment are approved. See [local catalog guide](./catalog-database.md). Dependency presence does not activate commerce.

Liên quan: [Phát triển và kiểm thử](<./development.md>), [Kiến trúc](<./architecture.md>), [ADRs](<./adrs.md>).
