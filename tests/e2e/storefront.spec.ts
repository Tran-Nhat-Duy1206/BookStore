import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("homepage, original artwork and responsive layout", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Có một thế giới",
  );
  await expect(
    page.getByRole("link", { name: "Dạo quanh kệ sách" }),
  ).toBeVisible();
  await expect(page.locator(".book-card")).toHaveCount(4);
  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize(
    testInfo.project.name.startsWith("mobile")
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
  );
  await page.screenshot({
    path: `test-results/home-${testInfo.project.name}.png`,
    fullPage: true,
    scale: "css",
  });
  expect(errors).toEqual([]);
});

test("responsive content pages do not overflow", async ({ page }, testInfo) => {
  for (const path of [
    "/catalog",
    "/products/khu-vuon-sau-con-mua",
    "/series/nhung-mua-o-lung-may",
    "/news",
    "/news/hen-voi-tiem-tra",
    "/releases",
    "/cart",
    "/wishlist",
  ]) {
    await page.goto(path);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${path} @ ${width}`,
      ).toBe(true);
    }
  }
  await page.setViewportSize(
    testInfo.project.name.startsWith("mobile")
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
  );
  await page.goto("/products/khu-vuon-sau-con-mua");
  await page.screenshot({
    path: `test-results/product-${testInfo.project.name}.png`,
    fullPage: true,
    scale: "css",
  });
});

test("search, filtering, sort, detail and honest empty state", async ({
  page,
}) => {
  await page.goto("/catalog");
  await expect(page.locator(".book-card")).toHaveCount(12);
  await page.getByLabel("Tên sách, tác giả hoặc nội dung").fill("dem trang");
  await page.getByRole("button", { name: "Tìm & lọc" }).click();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page
    .getByRole("heading", { name: "Đêm trăng trên mái nhà" })
    .getByRole("link")
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Đêm trăng trên mái nhà",
  );
  await expect(
    page.getByText("Chưa mở bán · Không tồn kho thật"),
  ).toBeVisible();
  await page.goto("/catalog?category=light-novel&sort=title");
  await expect(page.locator(".book-card")).toHaveCount(3);
  await expect(page.locator(".book-card h3").first()).toHaveText(
    "Người giữ những vì sao",
  );
  await page.goto("/catalog?q=not-a-real-book");
  await expect(
    page.getByRole("heading", { name: "Chưa tìm thấy câu chuyện này" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Trở lại tất cả sách" }).click();
  await expect(page.locator(".book-card")).toHaveCount(12);
});

test("wishlist and trial cart persist, quantity and delete work without commerce", async ({
  page,
}) => {
  await page.goto("/products/khu-vuon-sau-con-mua");
  await page
    .getByRole("button", {
      name: "Yêu thích: Khu vườn sau cơn mưa",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Thêm vào giỏ thử nghiệm", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Không tạo đơn hàng");
  await page.goto("/wishlist");
  await expect(
    page.getByRole("heading", { name: "Khu vườn sau cơn mưa", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".collection-row")).toHaveCount(1);
  await page.goto("/cart");
  await page
    .getByRole("button", { name: "Tăng số lượng Khu vườn sau cơn mưa" })
    .click();
  await expect(
    page.getByLabel("Số lượng Khu vườn sau cơn mưa", { exact: true }),
  ).toHaveText("2");
  await page
    .getByRole("button", { name: "Xóa Khu vườn sau cơn mưa", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Giỏ sách còn một khoảng trống" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Thanh toán|Đặt hàng|Đăng nhập/ }),
  ).toHaveCount(0);
});

test("cart drawer works and restores focus", async ({ page }) => {
  await page.goto("/products/khu-vuon-sau-con-mua");
  await page
    .getByRole("button", { name: "Thêm vào giỏ thử nghiệm", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mở giỏ thử nghiệm (1)", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Tăng số lượng Khu vườn sau cơn mưa" })
    .click();
  await expect(
    dialog.getByLabel("Số lượng Khu vườn sau cơn mưa", { exact: true }),
  ).toHaveText("2");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Mở giỏ thử nghiệm (2)", exact: true }),
  ).toBeFocused();
});

test("URL navigation resets dirty catalog controls", async ({ page }) => {
  await page.goto("/catalog");
  await page.getByLabel("Tên sách, tác giả hoặc nội dung").fill("discard this");
  await page.getByLabel("Sắp xếp", { exact: true }).selectOption("title");
  await page.getByRole("link", { name: "Manga", exact: true }).click();
  await expect(page.getByLabel("Tên sách, tác giả hoặc nội dung")).toHaveValue(
    "",
  );
  await expect(page.getByLabel("Thể loại", { exact: true })).toHaveValue(
    "manga",
  );
  await expect(page.getByLabel("Sắp xếp", { exact: true })).toHaveValue(
    "default",
  );
  await expect(page.locator(".book-card")).toHaveCount(2);
  await page.getByRole("link", { name: "Xóa bộ lọc", exact: true }).click();
  await expect(page.getByLabel("Thể loại", { exact: true })).toHaveValue("all");
});

test("two tabs preserve independent cart and wishlist changes", async ({
  page,
  context,
}) => {
  await page.goto("/products/khu-vuon-sau-con-mua");
  const second = await context.newPage();
  await second.goto("/products/dem-trang-tren-mai-nha");
  await page
    .getByRole("button", { name: "Thêm vào giỏ thử nghiệm", exact: true })
    .click();
  await expect(
    second.getByRole("button", { name: "Mở giỏ thử nghiệm (1)", exact: true }),
  ).toBeVisible();
  await second
    .getByRole("button", {
      name: "Yêu thích: Đêm trăng trên mái nhà",
      exact: true,
    })
    .click();
  await page.goto("/cart");
  await expect(page.locator(".collection-row")).toHaveCount(1);
  await page.goto("/wishlist");
  await expect(
    page.getByRole("heading", { name: "Đêm trăng trên mái nhà", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Bỏ yêu thích: Đêm trăng trên mái nhà",
      exact: true,
    })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("link", { name: "Khám phá kệ sách", exact: true }),
  ).toBeFocused();
});

test("repeated additions announce current quantity", async ({ page }) => {
  await page.goto("/products/khu-vuon-sau-con-mua");
  const add = page.getByRole("button", {
    name: "Thêm vào giỏ thử nghiệm",
    exact: true,
  });
  await add.click();
  await expect(page.getByRole("status")).toContainText("1 quyển");
  await add.click();
  await expect(page.getByRole("status")).toContainText("2 quyển");
});

test("storage unavailable keeps session usable and reports limitation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException("Unavailable", "SecurityError");
    };
    Storage.prototype.setItem = () => {
      throw new DOMException("Unavailable", "SecurityError");
    };
  });
  await page.goto("/products/khu-vuon-sau-con-mua");
  await page
    .getByRole("button", { name: "Thêm vào giỏ thử nghiệm", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "chỉ lưu trong phiên này",
  );
  await page
    .getByRole("button", { name: "Thêm vào giỏ thử nghiệm", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Mở giỏ thử nghiệm (2)", exact: true }),
  ).toBeVisible();
});

test("fine pointer actually tilts original book art", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("mobile"),
    "Touch devices intentionally do not tilt",
  );
  await page.goto("/");
  const tilt = page.locator(".book-stage [data-tilt]").first();
  await tilt.scrollIntoViewIfNeeded();
  const rect = await tilt.boundingBox();
  if (!rect) throw new Error("Book cover not visible");
  await page.mouse.move(rect.x + rect.width * 0.8, rect.y + rect.height * 0.3);
  await expect
    .poll(() => tilt.evaluate((el) => getComputedStyle(el).transform))
    .not.toBe("none");
});

test("corrupt local data recovers without false saved data", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("bookstore-demo-v1", "{broken-json"),
  );
  await page.goto("/wishlist");
  await expect(
    page.getByRole("heading", {
      name: "Cuốn sách yêu thích đầu tiên đang chờ bạn",
    }),
  ).toBeVisible();
});

test("news, announcements and all release states link to real pages", async ({
  page,
}) => {
  await page.goto("/news");
  await expect(page.locator(".news-card")).toHaveCount(6);
  await page
    .locator(".news-card")
    .getByRole("heading", { name: "Hẹn với Tiệm trà cuối chân trời" })
    .getByRole("link")
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Hẹn với Tiệm trà cuối chân trời",
  );
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.goto("/releases");
  await expect(page.locator(".release-row")).toHaveCount(5);
  for (const label of [
    "Ngày xác định · mẫu",
    "Dự kiến",
    "Đã hoãn",
    "Chưa rõ ngày",
  ])
    await expect(
      page.locator(".release-list").getByText(label, { exact: true }).first(),
    ).toBeVisible();
  await page.getByRole("link", { name: "Đã hoãn", exact: true }).click();
  await expect(page.locator(".release-row")).toHaveCount(1);
  await page
    .getByRole("heading", { name: "Những lá thư gửi mùa thu" })
    .getByRole("link")
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Những lá thư gửi mùa thu",
  );
  await page.goto("/series/nhung-mua-o-lung-may");
  await expect(page.locator(".book-card")).toHaveCount(3);
});

test("keyboard skip link and modal focus lifecycle", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Bỏ qua đến nội dung" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  if (!testInfo.project.name.startsWith("mobile"))
    await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByRole("button", { name: "Mở menu", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Đóng menu" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("link", { name: "Chuyện tiệm sách" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("reduced motion removes tilt and decorative transform", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const tilt = page.locator("[data-tilt]").first();
  await tilt.hover();
  expect(await tilt.evaluate((el) => getComputedStyle(el).transform)).toBe(
    "none",
  );
  expect(
    await page
      .locator(".hero-art")
      .evaluate((el) => getComputedStyle(el).transform),
  ).toBe("none");
  expect(
    await page
      .locator(".button")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
});

test("essential routes pass automated accessibility checks", async ({
  page,
}) => {
  for (const path of [
    "/",
    "/catalog",
    "/products/khu-vuon-sau-con-mua",
    "/news",
    "/releases",
    "/wishlist",
    "/cart",
  ]) {
    await page.goto(path);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      result.violations,
      `${path}: ${JSON.stringify(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))}`,
    ).toEqual([]);
  }
});

test("all exposed page links resolve and disabled commerce endpoints do not exist", async ({
  page,
  request,
}) => {
  const links = new Set<string>();
  for (const path of [
    "/",
    "/catalog",
    "/news",
    "/releases",
    "/products/khu-vuon-sau-con-mua",
    "/series/nhung-mua-o-lung-may",
    "/news/hen-voi-tiem-tra",
    "/wishlist",
    "/cart",
  ]) {
    await page.goto(path);
    for (const href of await page
      .locator("a[href]")
      .evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")!)))
      if (href.startsWith("/")) links.add(href);
  }
  for (const href of links)
    expect((await request.get(href)).status(), href).toBe(200);
  for (const path of [
    "/checkout",
    "/auth",
    "/api/checkout",
    "/api/orders",
    "/api/payments",
  ])
    expect((await request.post(path)).status(), path).toBeGreaterThanOrEqual(
      400,
    );
  expect((await request.get("/products/not-a-book")).status()).toBe(404);
});
