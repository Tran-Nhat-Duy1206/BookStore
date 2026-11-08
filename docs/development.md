# Phát triển, kiểm thử và CI

## Phạm vi

Official repository `Tran-Nhat-Duy1206/BookStore`, workspace `E:\BookStore`. Chỉ sửa task được giao, giữ feature branch hiện tại; không merge hoặc bắt đầu Phase 3 khi chưa được phép. Frontend chạy bằng fixtures, không cần database, `.env`, cloud account hoặc commercial credentials.

## Toolchain

- Node 24.19.0 là phiên bản local/CI được chọn; pnpm 11.7.0 theo packageManager.
- Engine range trong manifest cho phép một số Node versions khác; không suy ra tất cả đều đã được kiểm thử.
- Versions, compatibility và ESLint tooling debt: [dependencies](./dependencies.md).
- Fonts được package cục bộ; original CSS/SVG covers không phụ thuộc API ảnh bên ngoài.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Dev server mặc định `http://localhost:3000`. Nếu port bận, dùng URL thực mà server báo, không thay server GUI DSH và không tự deploy.

## Scripts hiện có

| Lệnh | Thực hiện |
|---|---|
| `pnpm typecheck` | `next typegen && tsc --noEmit` |
| `pnpm lint` | ESLint source, test và config |
| `pnpm test` | Vitest unit fixture/search/domain-projection checks |
| `pnpm build` | Next production build |
| `pnpm start` | Chạy build đã có, không phải deploy |
| `pnpm test:e2e` | Playwright desktop Chromium và mobile/touch Chromium emulation |

Lần đầu cần browser:

```sh
pnpm exec playwright install --only-shell chromium
pnpm build
pnpm test:e2e
```

Trên Linux CI dùng `pnpm exec playwright install --with-deps --only-shell chromium` để bổ sung OS dependencies. Không cài Firefox/WebKit vì suite hiện tại không chạy chúng.

Playwright tự khởi động/dừng production server `127.0.0.1:3100`; port này phải rảnh. `reuseExistingServer: false` tránh vô tình kiểm thử server/source cũ. Test failures không tự retry để che flakiness. Chạy build mới sau mỗi source change trước E2E.

## Coverage và evidence

- `tests/unit/catalog.test.ts`: fixture integrity, relationships và Vietnamese discovery logic.
- `tests/e2e/storefront.spec.ts`: các hành trình cơ bản, accessibility automation, storage failures, keyboard, reduced motion và link/commercial boundary.
- `tests/e2e/catalog-params.spec.ts`: URL normalization và filter selection nhất quán.
- `tests/e2e/quality-gate.spec.ts`: 9 route captures, populated collections/reflow, motion thực và toast focus safety.
- Screenshot outputs: `test-results/quality-gate/{desktop-chromium|mobile-chromium}/{home,catalog,product,series,news,article,releases,wishlist,cart}.png`.
- Reports/traces: `playwright-report/`, `test-results/`; đều gitignored, không chứa credentials hoặc dữ liệu khách thật.

Visual capture test dùng reduced motion để ảnh ổn định; motion acceptance tests riêng chạy `no-preference` và kiểm tra transform/exit thật. Screenshot capture không tương đương visual-diff regression baseline. Reflow ở CSS viewport 640/320 không phải native browser zoom certification.

## GitHub Actions

Workflow `.github/workflows/quality-gate.yml` chạy khi PR targeting `main` được mở/cập nhật, kể cả Draft PR. Chạy frozen install → TypeScript → ESLint → unit → production build → Chromium-only E2E. Standard `ubuntu-24.04` LTS, Node 24.19.0, pnpm 11.7.0; không paid runner hoặc deployment. Runner được pin để tránh migration tự động của `ubuntu-latest`.

Permissions chỉ `contents: read`; checkout không persist credentials; actions pin bằng commit SHA. [pnpm/action-setup v6.1.1](https://raw.githubusercontent.com/pnpm/action-setup/v6.1.1/action.yml) và [upload-artifact v7.0.2](https://raw.githubusercontent.com/actions/upload-artifact/v7.0.2/action.yml) khai báo Node24, không dựa vào runner ép action Node20 deprecated sang Node24. Không `pull_request_target`, secrets, DB/service containers hoặc external commercial integration. Concurrency hủy lượt cũ của cùng PR; timeout 20 phút. Artifact `frontend-review-evidence` giữ reports/screenshots/traces trong 7 ngày, kể cả khi test thất bại; có thể tạo lại local sau khi artifact hết hạn.

CI pass không tự merge và workflow không tự thiết lập required branch protection. Owner có thể cấu hình required check sau khi duyệt; chưa tự thay repository policy.

## Bằng chứng và giới hạn

- [Validation milestone ban đầu](./validation.md) là snapshot lịch sử, không bao phủ mọi state.
- [Quality gate PR #1](./quality-gate.md) ghi kết quả review hiện tại, CI run, fixes và GO/NO-GO.
- Không gọi emulation là thiết bị thật, không khẳng định WCAG certification/CWV từ build hoặc axe.
- Backend/DB migrations, payment/stock concurrency, POS/offline sync và security review tương ứng vẫn thuộc phase tương lai.
