# Mộc & Mực — BookStore

Cozy Bookstore Frontend Foundation cho repository chính thức [Tran-Nhat-Duy1206/BookStore](https://github.com/Tran-Nhat-Duy1206/BookStore).

**Mộc & Mực là tên tạm thời.** Toàn bộ sách, tác giả, bài viết và lịch phát hành đều hư cấu. Bìa là hình học/SVG nguyên bản được tạo cho dự án. Không có cửa hàng, địa chỉ, tồn kho, ISBN hoặc sản phẩm bán thật được công bố.

## Chạy tại máy

Yêu cầu Node `^22.12.0 || ^24.0.0 || >=26.0.0`, pnpm `11.7.0` (qua Corepack hoặc bản cài tương ứng).

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Mở `http://localhost:3000`. `DATA_SOURCE=fixture` là mặc định: không cần database, environment file, payment credentials hoặc cloud account. Font được đóng gói cục bộ qua Fontsource, không gọi Google Fonts runtime/build.

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

E2E dùng production build tại `http://127.0.0.1:3100`, tự khởi động/dừng server. Chạy `pnpm build` trước. Không chiếm dụng URL GUI DSH. Playwright tải Chromium lần đầu; không phải dịch vụ trả phí.

## Frontend được triển khai

- Responsive shell, search, mobile menu và quick-cart drawer.
- Homepage editorial, categories, curated books, series, releases và announcements.
- `/catalog`: tìm tiếng Việt có/không dấu, filter category, sort, URL shareable và empty state.
- `/products/[slug]`, `/series/[slug]`: ấn bản/tập/bộ, gồm ví dụ omnibus.
- `/news`, `/news/[slug]`: editorial và thông báo phát hành/hàng mới minh họa.
- `/releases`: agenda, confirmed/tentative/postponed/unknown, giữ precision ngày/tháng/quý.
- `/wishlist`, `/cart`: dữ liệu localStorage, không account; quantity/removal, validation dữ liệu local và đồng bộ storage events giữa tab. Không phải transaction store.
- CSS tokens, font Lora/Be Vietnam Pro, pointer tilt, card elevation, nav underline, reveal/stagger, bounded hero parallax, animated drawers, reduced-motion fallback.

## Commerce tắt hoàn toàn

Không triển khai checkout, customer authentication, API tạo đơn/payment, notification subscription hoặc shipping. Không có giá/tồn kho thật; trial cart không giữ hàng hoặc tạo đơn. Cấu hình `commercialEnabled: false` không tự mở được commerce vì chưa có endpoint/backend tương ứng.

## Cấu hình và domain

Brand/localization ở `src/config/site.ts`: mặc định `vi-VN`, `VND`, `Asia/Ho_Chi_Minh`; không phải giới hạn kinh doanh vĩnh viễn. Fictional fixtures ở `src/modules/catalog/` và `src/modules/editorial/`. Product DTO hiện là projection frontend nhẹ, **không phải schema database cuối**.

Kiến trúc modular monolith. Batch3.1 thêm PostgreSQL/Prisma7.10.1 cho **local catalog read foundation**, không production activation. [ADR-010](./docs/adr-010-catalog-persistence.md) chốt Series/Work/Volume/Edition/Product/SKU, public IDs và invariants; inventory operations vẫn tương lai.

## Local catalog database — Batch3.1

[Hướng dẫn local/CI](./docs/catalog-database.md) có native helper hoặc Docker Compose, dedicated loopback ports55432/55433, migrations, seed và source selection. Không dùng database/port5432 của project khác.

```sh
pnpm db:local:init
pnpm db:local:start
pnpm db:migrate
pnpm db:seed
pnpm test:db
pnpm db:local:stop
```

Fixture/database adapters trả cùng public DTOs và giữ IDs/URLs/local collections. Database mode opt-in không fallback khi lỗi; unknown/draft metadata không bị bịa thành dữ liệu công khai. Scripts build/typecheck tự generate Prisma client, không yêu cầu DB connection. Xem [Batch3.1 validation](./docs/batch-3-1-validation.md).

## Tài liệu và trạng thái

- [Mục lục](./docs/index.md)
- [Architecture](./docs/architecture.md)
- [Domain](./docs/domain-model.md)
- [Design & motion](./docs/design-system.md)
- [Dependencies và compatibility](./docs/dependencies.md)
- [Development/testing](./docs/development.md)
- [Roadmap và phạm vi tương lai](./docs/roadmap.md)

[Validation milestone ban đầu](./docs/validation.md) giữ bằng chứng lịch sử. [Quality gate PR #1](./docs/quality-gate.md) bổ sung review/rendered evidence, fixes và kết quả mở rộng: 24 unit tests, 56 browser cases đạt, 6 skip có chủ đích theo loại pointer/thiết bị. Không coi roadmap là feature đã hoàn thành.

GitHub Actions chạy frozen install, TypeScript, lint, unit, build và Chromium-only E2E cho PR targeting `main`, với `contents: read`, không deploy/secrets. Thêm job PostgreSQL riêng cho migrations/parity và database-mode E2E; [workflow runs](https://github.com/Tran-Nhat-Duy1206/BookStore/actions/workflows/quality-gate.yml) ghi actual checks của từng PR. Screenshot của 9 trang × 2 layouts nằm trong artifact `frontend-review-evidence` (retention 7 ngày), hoặc tạo lại local theo [development](./docs/development.md).

## Giới hạn milestone

Light mode, dữ liệu demo và local browser persistence. Có local catalog database/read foundation; chưa có staff/customer auth, admin mutations, CMS persistence, inventory operations, SEO production/indexing (vẫn `noindex`), tài khoản đồng bộ, commerce, POS hoặc deployment. Không triển khai paid services. Chỉ merge khi owner phê duyệt PR; không tự mở milestone tiếp theo.
