# Frontend Foundation — bằng chứng kiểm chứng ban đầu

> Snapshot lịch sử tại source `4a99b28`, trước PR #1 quality review. Kết quả suite cũ không bao phủ populated cart reflow hoặc actual hover/press. [Quality gate hiện tại](./quality-gate.md) ghi các gaps được tái hiện, fixes, suite mở rộng và CI; dùng báo cáo mới cùng latest PR checks cho quyết định merge.

## Phạm vi và source

Milestone duy nhất: Cozy Bookstore Frontend Foundation. Source/test/config commit: `4a99b28f4a497a44ea3a99f8b3c4daa2e2a0b512`. Documentation baseline trên feature branch: `afb3475`; main baseline: `ff1a3d6`.

Workspace `E:\BookStore` đã truy cập được trong phiên full-access. Ban đầu không có file hay Git repository; `git ls-remote` official remote không trả refs. Đã khởi tạo main và push baseline, sau đó tạo `feat/bookstore-foundation`. Origin fetch/push đều là `https://github.com/Tran-Nhat-Duy1206/BookStore.git`. Không truy cập TaleAtlas, không force-push, không merge, không sửa quyền Windows.

Môi trường chạy: Windows, Node 24.19.0, pnpm 11.7.0. Các kết quả dưới đây là lệnh thực tế, không phải chỉ tiêu dự kiến.

## Kết quả lệnh

| Lệnh | Kết quả |
|---|---|
| `pnpm install --frozen-lockfile` | PASS, lockfile đồng bộ, không cần credentials |
| `pnpm typecheck` | PASS; `next typegen && tsc --noEmit` |
| `pnpm lint` | PASS, không lỗi/cảnh báo lint ở lượt cuối |
| `pnpm test` | PASS, 24/24 unit tests |
| `pnpm build` | PASS, Next production build, 28 prerendered entries và dynamic discovery routes |
| `pnpm test:e2e` | PASS: 31 passed, 1 skipped trong 32 project cases, khoảng 1.1 phút |
| `pnpm peers check` | Không peer dependency issues |
| `pnpm audit --prod` | Không known vulnerabilities theo registry tại thời điểm chạy; không phải security certification |
| `git diff --cached --check` | PASS trước commit source |
| `git ls-files '.env*'` | Không có environment files tracked |

E2E dùng production server do Playwright quản lý tại `127.0.0.1:3100`, không thay thế DSH GUI và không deploy. Build đã chạy trên cùng source trước browser suite cuối; các lần bổ sung sau đó chỉ là test/doc và typecheck script được chạy lại.

## Unit coverage

- Unique IDs/slugs và category coverage: 12 sách, 6 categories, 2 series.
- Standalone, series bidirectional references và omnibus fixture.
- Editorial/release references và bốn release states.
- Demo notice/localization/commerce-off, không price/stock fields hoặc commercial claims.
- Vietnamese accent/đ/NFD/case/whitespace normalization.
- Author và token search, category combinations, unknown query, empty input.
- Title/recent/default sorting, stable ties và không mutation input.

## Browser coverage

Hai project: desktop Chromium và Chromium với mobile/touch emulation. Không gọi mobile emulation là thử trên iPhone/Safari thật.

- Homepage render, không pageerror trong lượt homepage, original cover components.
- Home không overflow tại 320/375/768/1024/1440 CSS px.
- Catalog, product, series, news/index/detail, releases, cart, wishlist không overflow tại 320/768/1440 CSS px.
- Search không dấu, filter, sort, product links, empty state và reset.
- Dirty form controls được reset đúng sau category/reset client navigation.
- Wishlist/cart persistence sau navigation/reload; quantity, delete và empty state.
- Cross-tab sequential mutations giữ cart và wishlist; không biến localStorage thành transaction store.
- LocalStorage hỏng được recover; storage bị chặn vẫn hoạt động trong phiên và báo giới hạn.
- Repeated additions cập nhật thông báo với quantity mới.
- Wishlist removal chuyển focus tới empty CTA.
- Mobile menu: skip link, Tab/Shift+Tab focus trap, Escape và trigger focus restoration.
- Cart drawer: quantity, Escape và trigger focus restoration.
- Fine-pointer tilt thực sự tạo transform trên desktop; **skip có chủ đích trên touch project**, nơi tilt không nên chạy.
- Reduced motion: tilt/hero transform bị tắt và button transition bằng 0.
- News announcement/detail/related book, series omnibus và release states/filter.
- Internal links thu thập từ các template chính trả 200; bad product slug trả 404.
- POST tới checkout/auth/order/payment paths chưa triển khai không trả thành công thương mại.

## Accessibility và visual review

Axe rules `wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa` không phát hiện violations trên `/`, `/catalog`, một product detail, `/news`, `/releases`, `/wishlist`, `/cart` trong cả hai browser projects.

Lượt đầu đã phát hiện color contrast của cover-gold và news ornament chưa đủ. Đã sửa màu thực tế, giữ nguyên rule và chạy lại đạt. Không exclude các lỗi để lấy kết quả pass.

Đã xem trực tiếp ảnh render homepage desktop/mobile và product desktop/mobile; typography, cover layout và responsive stacking được kiểm tra bằng ảnh. Screenshot/report/trace là local outputs trong `test-results/` và `playwright-report/`, được gitignore, có thể tạo lại bằng E2E.

**Không tuyên bố đạt WCAG toàn diện:** chưa manual screen-reader test với NVDA/VoiceOver, chưa kiểm thử Safari/Firefox/thiết bị thật, text zoom 200–400%, forced-colors hoặc mọi trạng thái overlay bằng axe. Không có Lighthouse/CWV field metrics hoặc performance benchmark. Loading/error components có source nhưng chưa ép lỗi production để kiểm thử mọi nhánh recovery.

## Source review và các lỗi đã sửa

Review độc lập không tìm P0/P1 trong phạm vi source. Các findings về form URL sync, hai tab ghi đè dữ liệu, focus sau removal và repeated live announcements đã được sửa/bổ sung regression tests. Header active state hiện theo page; category chips mới là nơi biểu diễn filter được chọn.

Secret-pattern scan trên source/config/docs không tìm private keys, GitHub tokens, AWS access keys hoặc live payment keys. Không có `fetch`, `dangerouslySetInnerHTML` hoặc `process.env` trong frontend hiện tại; secret scan cơ bản không thay một audit chuyên sâu.

## Trạng thái sản phẩm

**Implemented demo:** shell, homepage, discovery/detail/series, 6 editorial fixtures, 5 release fixtures, local wishlist/trial cart, original SVG covers, motion và fallback states.

**Disabled/not implemented:** customer auth, checkout, real orders, payment/shipping, subscription delivery, admin/backend/database/Prisma, real inventory, POS, production deployment.

**Known limitations:** light mode only; dữ liệu hư cấu; localStorage không đồng bộ account và không bảo đảm concurrent atomic writes; ESLint 9 deprecated do peer compatibility hiện tại, được ghi trong dependencies. Không có known blocking bug sau các checks nêu trên; không suy ra mọi lỗi đã được loại trừ.

## Hướng dẫn reviewer

1. Checkout feature branch và `pnpm install --frozen-lockfile`.
2. `pnpm dev` để review ở localhost:3000, không cần env/database.
3. Chạy typecheck/lint/test/build; cài Chromium rồi chạy E2E theo README.
4. Review design, content labels và scope trước khi phê duyệt merge.
5. Không merge hoặc bắt đầu backend/commerce chỉ vì report này tồn tại. Commercial activation luôn cần phê duyệt riêng.
