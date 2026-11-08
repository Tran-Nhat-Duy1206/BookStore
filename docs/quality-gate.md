# PR #1 — Quality gate, CI và visual review

## Phạm vi

Review Frontend Foundation, không Phase 3. Baseline đầu vào `4ff0470c7e322e59a3784f6391fdf82973644b31`; branch `feat/bookstore-foundation`; [Draft PR #1](https://github.com/Tran-Nhat-Duy1206/BookStore/pull/1). Repository/remote và working tree đã được kiểm tra trước sửa. Không sửa ACL, truy cập repository khác, merge, deploy, cài database/auth/payment hoặc dùng dịch vụ trả phí.

Báo cáo này bổ sung [validation ban đầu](./validation.md), không biến kết quả lịch sử thành chứng nhận mọi trạng thái. Final HEAD, GitHub run URL và quyết định bàn giao được ghi ở PR comment của quality gate; check trên HEAD mới nhất là nguồn CI có thẩm quyền.

## Findings theo severity

Không tìm P0/P1 trong phạm vi review và bộ kiểm tra đã chạy. Sáu vấn đề dưới đây được xác nhận bằng browser trên baseline trước sửa; không tính lại các lỗi đã sửa ở milestone trước.

| Severity | Finding đã tái hiện | Thay đổi có lý do | Regression evidence |
|---|---|---|---|
| P2 | Populated cart overflow ở 320px; suite cũ chỉ kiểm tra cart rỗng | Quantity cho phép wrap; mobile tracks dùng minmax/44px; ≤370px chuyển 2 cột, giữ touch target | Reflow cả 9 route với 2 saved/cart books, 320/640/844 widths |
| P2 | Toast tồn tại vĩnh viễn che focused footer control ở 320px; hit-test không tới link | Dismiss button, auto-dismiss 8s khi không focus, dismiss khi focus ra ngoài; close trả focus về tác nhân nếu còn | Actual elementFromPoint + overlap, manual close/focus return và expiry |
| P2 | Hover elevation không chạy: Reveal inline transform ghi đè CSS card transform | Semantic outer article sở hữu hover, inner Reveal sở hữu scroll transform | Root transform từ 0 tới khoảng -3px rồi reset |
| P2 | Button đang hover không shrink khi giữ press vì CSS cascade | Explicit `.button:hover:active` scale0.97; reduced-motion override tương ứng | Mouse hover rồi giữ down: scale <0.985 và ≥0.96; mouseup vẫn thêm giỏ |
| P3 | Padded category URL cho đúng results nhưng select/chips hiển thị All; invalid category cũng lệch UI | Trim/whitelist category và sort một lần cho rendering lẫn discovery; invalid về defaults | Padded manga/title → 2 sách + matching controls; unknown → 12 sách + All/default |
| P3 | Hero parallax vẫn chạy trên touch landscape 844px | Bổ sung no-hover/coarse-pointer media gate bên cạnh narrow viewport | Touch portrait + landscape transform none, desktop vẫn bounded0–12px |

Focused baseline suite mới: **10 failed, 13 passed, 5 skipped**; failures lặp giữa projects và không tương đương 10 lỗi riêng. Không bỏ assertions hoặc retry để biến failure thành pass. Lượt đầy đủ sau sửa đạt kết quả bên dưới.

## Phạm vi thay đổi

- Một workflow CI tối thiểu.
- Source: catalog parameter boundary, BookCard transform ownership, collection reflow/press/parallax CSS và noncritical feedback lifecycle.
- Tests mới: catalog parameter regressions và quality-gate visual/motion/focus checks.
- Docs đồng bộ trạng thái thực, CI/test instructions và motion conditions.
- Không đổi dependency versions, lockfile, fixtures/business data, backend boundary hoặc roadmap. Không rewrite components đang hoạt động ngoài nguyên nhân đã tái hiện.

## Validation local

Windows, Node24.19.0, pnpm11.7.0; production server do Playwright quản lý tại `127.0.0.1:3100` và dừng sau suite.

| Kiểm tra | Kết quả |
|---|---|
| Frozen dependency install | PASS |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | 24/24 PASS |
| `pnpm build` | PASS, không credentials/database |
| `pnpm test:e2e` | 56 PASS, 6 intentional SKIP trong62 project cases |
| Runtime review | Không pageerror trên9 representative routes; hydration-console diagnostics được kiểm tra trong capture test |
| Accessibility automation | Existing axe checks trên7 route ở2 projects không violations |
| Navigation/commerce boundary | Internal destinations trả200; bad product404; commercial POST endpoints không hoạt động |

Skips là applicability, không né lỗi: original touch tilt; quality-gate mobile tilt/card-hover/button-hover/desktop-nav; desktop không chạy touch-only menu test. Keyboard, touch navigation, drawer exits và reduced motion vẫn có checks thực trên projects phù hợp.

## GitHub Actions

Workflow [quality-gate.yml](../.github/workflows/quality-gate.yml):

- Trigger `pull_request` targeting `main`, kể cả Draft PR.
- `ubuntu-latest`, Node24.19.0, pnpm11.7.0 khớp configuration; frozen lockfile.
- TypeScript → ESLint → unit → production build → Chromium-only E2E.
- Chỉ cài Chromium headless shell và OS dependencies suite cần; không Firefox/WebKit.
- `contents: read`, checkout `persist-credentials: false`, pinned action SHAs.
- Không secrets, `pull_request_target`, deployment, paid services hoặc commercial integrations.
- Concurrency cùng PR, timeout20 phút; artifact `frontend-review-evidence`, retention7 ngày.

[Run CI đầu tiên](https://github.com/Tran-Nhat-Duy1206/BookStore/actions/runs/42452796304) trên `01ee001f71492b5f54773edafc991ff13ec0b60a` đã thực sự **success**, bao gồm mọi step. Đây là baseline CI trước expanded tests, không dùng run cũ để chứng minh HEAD sau sửa. [PR checks](https://github.com/Tran-Nhat-Duy1206/BookStore/pull/1/checks) và final quality-gate PR comment ghi run mới nhất tương ứng HEAD bàn giao.

Không tự cấu hình branch protection/required check hoặc merge. Owner có thể đặt required workflow sau khi duyệt.

## Visual review: 18 captures

Đã chạy app và xem ảnh render cả desktop1440×1000 và mobile390×844; screenshot full-page `scale: css`, sau font load. Wishlist/cart có2 sách được thêm qua UI, không chỉ empty states. Capture dùng reduced motion để ổn định ảnh; motion acceptance chạy riêng với normal motion.

Outputs gitignored, không commit ảnh build vào source. Local hoặc artifact CI có cấu trúc:

```text
test-results/quality-gate/
├── desktop-chromium/
└── mobile-chromium/
    home.png
    catalog.png
    product.png
    series.png
    news.png
    article.png
    releases.png
    wishlist.png
    cart.png
```

Mỗi folder đều có đủ9 filenames. Xem artifact `frontend-review-evidence` trong run mới nhất; sau7 ngày có thể tạo lại bằng E2E. Đây là capture evidence, chưa phải pixel-diff baselines.

| Trang | Nhận xét render |
|---|---|
| Homepage | Cream/brown, editorial hierarchy, original illustrated covers và shelf motif nhất quán; mobile stack không che CTA |
| Catalog | Search/filter/chips rõ ràng, mobile2 cột, full titles ngoài bìa; không giả price/stock |
| Product | Bìa nguyên bản, description/edition/volume riêng, demo và local actions rõ |
| Series | Volume1/2 và omnibus được phân biệt; 3 items không bị trình bày thành3 tập mới |
| News listing | Featured announcement, categories và6 bài có link thật; visual typography đồng bộ |
| Article | Heading/excerpt/body phân cấp, readable measure, related book và demo disclaimer |
| Releases | Certainty badge có chữ, giữ date precision và postponed/unknown; agenda thích hợp mobile |
| Wishlist | Populated rows, removal/add action và local-only notice |
| Trial cart | Quantity/remove không có tổng tiền/checkout; narrow populated reflow đã sửa |

Design follow-ups không chặn foundation: metadata8–12px và chữ nhỏ trong thumbnail bìa cần human readability review với người dùng; title/author ngoài artwork là nguồn thông tin đọc chính. Decorative article heading khá lớn ở mobile nhưng không clip hoặc chặn nội dung. Không đổi toàn bộ typography/layout chỉ vì sở thích cá nhân.

## Motion acceptance thực tế

| Hiệu ứng | Đã kiểm tra |
|---|---|
| Book tilt | Mouse hai hướng, signed axes, amplitude quanh±4°, reset pointer leave; touch không yêu cầu tilt |
| Hover elevation | Card root lift thật sau reveal, reset và không layout shift bằng thay đổi flow |
| Button feedback | Hover translate và held press scale cùng hoạt động |
| Navigation | Underline scale tới/mất khi hover; mobile menu navigation bằng tap |
| Reveal/stagger | Nội dung opacity1, settle y0 sau scroll; configured delays0/40/80/120ms; không đo frame timing riêng từng item |
| Ambient/parallax | Desktop scroll maps0–12px, xbounded±8; touch portrait/landscape và reduced motion off |
| Drawers | Panel enter/exit thực qua frame probe, overlay removal, Escape, focus trap/return và touch close/navigation |
| Reduced motion | Decorative transforms/transitions bị tắt, cart/menu actions vẫn dùng được |
| Feedback | Accessible live status, dismissal/expiry, focus không bị toast che |

Không xác định measured jank/long-task regression trong interaction suite, nhưng **không có profiling/FPS/CWV benchmark**, nên không tuyên bố 60fps hoặc production performance SLA. MatchMedia/bounding-box reads và animated shadow vẫn cần profile trước catalog lớn. Không WebGL, scroll hijacking hoặc perpetual decorative animation mới.

Chưa triển khai: magnetic buttons, page-turn transitions, cursor-following ambient toàn trang và personal interactive bookshelf. Hero pointer response không được gọi là custom cursor; wishlist không được gọi là bookshelf Phase5.

## States, security và giới hạn

- Loading skeleton, error+retry và not-found có source; empty states/search reset/local storage recovery có checks. Chưa cố ý tạo production runtime crash để exercise mọi error-boundary path.
- Không phát hiện hydration/runtime exception trong captured routes; không coi9 samples là chứng minh mọi edge state.
- Chưa Safari/Firefox, physical device, NVDA/VoiceOver, native browser/text zoom hoặc full WCAG certification. 320/640 reflow là viewport-equivalent checks, không thay native zoom.
- localStorage không atomic transaction store và không account sync.
- Light mode, demo-only content; ESLint9 deprecated tooling debt giữ nguyên vì peer compatibility.
- Không real address/availability/credentials, customer auth, checkout/order/payment endpoints, notification subscriptions, backend/DB/Prisma/POS/deploy. Demo banner vẫn có mặt trong mọi capture.

## GO / NO-GO

**GO cho việc owner xem xét merge frontend demo**, với điều kiện latest HEAD có quality workflow success, changeset được review và owner phê duyệt rõ ràng. Không còn finding blocking trong phạm vi kiểm tra sau fixes; những giới hạn trên phải được chấp nhận như scope frontend foundation.

Đây không phải GO cho production commerce/deployment, không phải lệnh merge và không cho phép Phase3. Agent dừng sau quality gate, để PR ở Draft và chờ owner.
