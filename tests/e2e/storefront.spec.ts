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

test("category links retain submitted filters through navigation and history", async ({
  page,
}) => {
  await page.goto("/catalog");
  const query = page.getByLabel("Tên sách, tác giả hoặc nội dung");
  const category = page.getByLabel("Thể loại", { exact: true });
  const sort = page.getByLabel("Sắp xếp", { exact: true });
  const chips = page.locator(".chip-row");
  const cards = page.locator(".book-card h3");
  const count = page.locator(".result-line span");
  const submitted = "Tiếng Việt";

  await query.fill(submitted);
  await sort.selectOption("title");
  await page.getByRole("button", { name: "Tìm & lọc" }).click();
  await expect(count).toHaveText(`12 sách minh họa cho “${submitted}”`);

  const activeLink = chips.getByRole("link", {
    name: "Light novel",
    exact: true,
  });
  await query.fill("bản nháp");
  await sort.selectOption("recent");
  // Tab from the preceding chip to test keyboard order and focus visibility.
  await chips.getByRole("link", { name: "Văn học", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(activeLink).toBeFocused();
  await expect(activeLink).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");

  const expectLightNovel = async () => {
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === "/catalog" &&
        url.searchParams.get("q") === submitted &&
        url.searchParams.get("sort") === "title" &&
        url.searchParams.get("category") === "light-novel",
    );
    await expect(query).toHaveValue(submitted);
    await expect(sort).toHaveValue("title");
    await expect(category).toHaveValue("light-novel");
    await expect(chips.locator('[aria-current="true"]')).toHaveText(
      "Light novel",
    );
    await expect(count).toHaveText(`3 sách minh họa cho “${submitted}”`);
    await expect(cards).toHaveText([
      "Người giữ những vì sao",
      "Thành phố ngủ trong mây",
      "Tiệm trà cuối chân trời",
    ]);
  };
  await expectLightNovel();
  await query.fill("bản nháp trên cùng danh mục");
  await sort.selectOption("recent");
  await activeLink.click();
  await expectLightNovel();
  await page.reload();
  await expectLightNovel();
  await chips.getByRole("link", { name: "Tất cả", exact: true }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/catalog" &&
      url.searchParams.get("q") === submitted &&
      url.searchParams.get("sort") === "title" &&
      !url.searchParams.has("category"),
  );
  await expect(query).toHaveValue(submitted);
  await expect(sort).toHaveValue("title");
  await expect(category).toHaveValue("all");
  await expect(chips.locator('[aria-current="true"]')).toHaveText("Tất cả");
  await expect(cards).toHaveCount(12);
  await page.goBack();
  await expectLightNovel();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
  await page.getByRole("link", { name: "Xóa bộ lọc", exact: true }).click();
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(query).toHaveValue("");
  await expect(sort).toHaveValue("default");
  await expect(category).toHaveValue("all");
  await expect(cards).toHaveCount(12);
});

const narrowedTitles = ["Người giữ những vì sao", "Tiệm trà cuối chân trời"];
const narrowedSlugs = ["nguoi-giu-nhung-vi-sao", "tiem-tra-cuoi-chan-troi"];
const narrowedFilters = {
  q: "Lam Khê",
  category: "light-novel",
  sort: "title",
};
const narrowedQuery = new URLSearchParams(narrowedFilters).toString();

async function expectNarrowedCatalog(page: import("@playwright/test").Page) {
  await expect(page.locator(".book-card h3")).toHaveText(narrowedTitles);
  await expect(page.locator(".result-line span")).toHaveText(
    "2 sách minh họa cho “Lam Khê”",
  );
  for (const [index, slug] of narrowedSlugs.entries()) {
    const card = page.locator(".book-card").nth(index);
    const href = `/products/${slug}?${narrowedQuery}`;
    await expect(card.locator(".cover-link")).toHaveAttribute("href", href);
    await expect(card.locator("h3 a")).toHaveAttribute("href", href);
  }
}

test("product return restores narrowed results in a new tab after reload", async ({
  page,
  context,
  isMobile,
}) => {
  await page.goto("/catalog");
  await expect(page.locator(".book-card")).toHaveCount(12);
  const firstCard = page.locator(".book-card").first();
  for (const selector of [".cover-link", "h3 a"]) {
    await expect(firstCard.locator(selector)).toHaveAttribute(
      "href",
      "/products/khu-vuon-sau-con-mua",
    );
  }
  const query = page.getByLabel("Tên sách, tác giả hoặc nội dung");
  await query.fill(narrowedFilters.q);
  await page
    .getByLabel("Thể loại", { exact: true })
    .selectOption("light-novel");
  await page.getByLabel("Sắp xếp", { exact: true }).selectOption("title");
  await page.getByRole("button", { name: "Tìm & lọc" }).click();
  await expectNarrowedCatalog(page);
  await query.fill("bản nháp không được chuyển tiếp");
  const titleLink = page.locator(".book-card h3 a").first();
  let product;
  if (isMobile) {
    // Open the emitted URL in a fresh tab without relying on browser history.
    const href = await titleLink.getAttribute("href");
    expect(href).not.toBeNull();
    product = await context.newPage();
    await product.goto(new URL(href!, page.url()).href);
  } else {
    const opened = context.waitForEvent("page");
    await titleLink.click({ button: "middle" });
    product = await opened;
  }
  await expect(product.getByRole("heading", { level: 1 })).toHaveText(
    narrowedTitles[0],
  );
  const returnLink = product.getByRole("link", {
    name: "Trở lại kết quả",
    exact: true,
  });
  await expect(returnLink).toHaveAttribute("href", `/catalog?${narrowedQuery}`);
  await product.reload();
  await expect(returnLink).toHaveAttribute("href", `/catalog?${narrowedQuery}`);
  await expect(
    product.locator(".related-section .book-card h3 a").first(),
  ).toHaveAttribute("href", "/products/tiem-tra-cuoi-chan-troi");
  await product
    .locator(".breadcrumb")
    .getByRole("link", { name: "Trang chủ" })
    .focus();
  await product.keyboard.press("Tab");
  await expect(returnLink).toBeFocused();
  await expect(returnLink).toHaveCSS("outline-style", "solid");
  await expect
    .poll(() =>
      product.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
  await product.keyboard.press("Enter");
  await expect(product).toHaveURL(`/catalog?${narrowedQuery}`);
  await expect(
    product.getByLabel("Tên sách, tác giả hoặc nội dung"),
  ).toHaveValue(narrowedFilters.q);
  await expect(product.getByLabel("Thể loại", { exact: true })).toHaveValue(
    "light-novel",
  );
  await expect(product.getByLabel("Sắp xếp", { exact: true })).toHaveValue(
    "title",
  );
  await expectNarrowedCatalog(product);
});

test("product accepts only catalog fields and keeps metadata and 404 behavior", async ({
  page,
}) => {
  const path = "/products/nguoi-giu-nhung-vi-sao";
  await page.goto("/");
  await expect(page.locator(".book-card h3 a").first()).toHaveAttribute(
    "href",
    /^\/products\/[^?]+$/,
  );
  await page.goto(path);
  const title = await page.title();
  expect(title).toContain(narrowedTitles[0]);
  const canonical = await page
    .locator('link[rel="canonical"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  const returnLink = page.getByRole("link", {
    name: "Trở lại kết quả",
    exact: true,
  });
  const fallback = page
    .locator(".breadcrumb")
    .getByRole("link", { name: "Kệ sách" });
  await expect(returnLink).toHaveCount(0);
  await expect(fallback).toHaveAttribute("href", "/catalog");
  await page.goto(
    `${path}?q=a&q=b&category=manga&category=light-novel&sort=title&sort=recent&returnTo=%2F%2Fevil.example`,
  );
  await expect(returnLink).toHaveCount(0);
  await expect(fallback).toHaveAttribute("href", "/catalog");
  await page.goto(
    `${path}?category=%2F%2Fevil.example&sort=unlisted&returnTo=https%3A%2F%2Fevil.example`,
  );
  await expect(returnLink).toHaveCount(0);
  await expect(fallback).toHaveAttribute("href", "/catalog");

  await page.goto(`${path}?q=a&q=b&sort=title&returnTo=%2F%2Fevil.example`);
  await expect(returnLink).toHaveAttribute("href", "/catalog?sort=title");

  const q = "Tiếng Việt & + # % ? //evil.example";
  const input = new URLSearchParams({
    q,
    category: " light-novel ",
    sort: " recent ",
    returnTo: "//evil.example",
  });
  await page.goto(`${path}?${input}`);
  const expected = new URLSearchParams({
    q,
    category: "light-novel",
    sort: "recent",
  });
  await expect(returnLink).toHaveAttribute("href", `/catalog?${expected}`);
  await expect(page).toHaveTitle(title);
  expect(
    await page
      .locator('link[rel="canonical"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
  ).toEqual(canonical);
  await returnLink.click();
  await expect(page).toHaveURL(`/catalog?${expected}`);
  await expect(page.getByLabel("Tên sách, tác giả hoặc nội dung")).toHaveValue(
    q,
  );
  const missing = await page.goto(`/products/not-a-real-book?${expected}`);
  expect(missing?.status()).toBe(404);
});

const lightNovelCatalog = "/catalog?category=light-novel";
const lightNovelGenreLink = "Xem thêm sách thuộc thể loại Light novel";

async function expectDefaultLightNovelCatalog(
  page: import("@playwright/test").Page,
) {
  await expect(page).toHaveURL(lightNovelCatalog);
  await expect(page.getByLabel("Tên sách, tác giả hoặc nội dung")).toHaveValue(
    "",
  );
  await expect(page.getByLabel("Thể loại", { exact: true })).toHaveValue(
    "light-novel",
  );
  await expect(page.getByLabel("Sắp xếp", { exact: true })).toHaveValue(
    "default",
  );
  await expect(page.locator(".result-line span")).toHaveText("3 sách minh họa");
  await expect(page.locator(".book-card h3 a")).toHaveText([
    "Tiệm trà cuối chân trời",
    "Người giữ những vì sao",
    "Thành phố ngủ trong mây",
  ]);
  for (const [index, slug] of [
    "tiem-tra-cuoi-chan-troi",
    "nguoi-giu-nhung-vi-sao",
    "thanh-pho-ngu-trong-may",
  ].entries()) {
    await expect(page.locator(".book-card h3 a").nth(index)).toHaveAttribute(
      "href",
      `/products/${slug}?category=light-novel`,
    );
  }
}

test("product genre browsing stays distinct from the original search", async ({
  page,
  context,
  isMobile,
}) => {
  const path = `/products/${narrowedSlugs[0]}`;
  const genre = page.getByRole("link", {
    name: lightNovelGenreLink,
    exact: true,
  });
  const back = page.getByRole("link", { name: "Trở lại kết quả", exact: true });
  await page.goto(path);
  await expect(back).toHaveCount(0);
  await expect(
    page.locator(".breadcrumb").getByRole("link", { name: "Kệ sách" }),
  ).toHaveAttribute("href", "/catalog");
  await expect(genre).toHaveAttribute("href", lightNovelCatalog);
  if (isMobile) {
    await genre.tap();
    await expectDefaultLightNovelCatalog(page);
    await page.setViewportSize({ width: 320, height: 750 });
  } else {
    const opened = context.waitForEvent("page");
    await genre.click({ button: "middle" });
    const tab = await opened;
    await expectDefaultLightNovelCatalog(tab);
    await tab.close();
  }

  await page.goto(`/catalog?${narrowedQuery}`);
  await expectNarrowedCatalog(page);
  await page.locator(".book-card h3 a").first().click();
  await expect(page).toHaveURL(`${path}?${narrowedQuery}`);
  await expect(back).toHaveAttribute("href", `/catalog?${narrowedQuery}`);
  await expect(genre).toHaveAttribute("href", lightNovelCatalog);
  await page
    .getByRole("button", {
      name: `Yêu thích: ${narrowedTitles[0]}`,
      exact: true,
    })
    .focus();
  await page.keyboard.press("Tab");
  await expect(genre).toBeFocused();
  await expect(genre).toHaveCSS("outline-style", "solid");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
  await page.keyboard.press("Enter");
  await expectDefaultLightNovelCatalog(page);
  await page.goBack();
  await expect(back).toHaveAttribute("href", `/catalog?${narrowedQuery}`);
  await back.click();
  await expect(page).toHaveURL(`/catalog?${narrowedQuery}`);
  await expectNarrowedCatalog(page);

  // A different incoming category must not choose the book's discovery link.
  await page.goto(`${path}?q=Lam+Kh%C3%AA&category=manga&sort=recent`);
  await expect(back).toHaveAttribute(
    "href",
    "/catalog?q=Lam+Kh%C3%AA&category=manga&sort=recent",
  );
  await expect(genre).toHaveAttribute("href", lightNovelCatalog);
  await page.goto("/products/ban-do-cua-gio?category=light-novel");
  await expect(
    page.getByRole("link", {
      name: "Xem thêm sách thuộc thể loại Manga",
      exact: true,
    }),
  ).toHaveAttribute("href", "/catalog?category=manga");
});

const compareFirst = "khu-vuon-sau-con-mua";
const compareSecond = "nhung-la-thu-gui-mua-thu";
const comparisonURL = `/compare?book=${compareFirst}&with=${compareSecond}`;

async function expectComparison(page: import("@playwright/test").Page) {
  const table = page.getByRole("table", { name: "Thông tin hai cuốn sách" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Thông tin",
    "Khu vườn sau cơn mưa",
    "Những lá thư gửi mùa thu",
  ]);
  for (const [label, left, right] of [
    ["Tập / nội dung", "Tập 1", "Tập 2"],
    ["Ấn bản minh họa", "Bản minh họa hư cấu", "Bản tiêu chuẩn minh họa"],
    ["Ngôn ngữ", "Tiếng Việt", "Tiếng Việt"],
    ["Năm xuất bản (minh họa)", "2027", "2027"],
  ]) {
    await expect(
      table
        .getByRole("row")
        .filter({
          has: page.getByRole("rowheader", { name: label, exact: true }),
        })
        .getByRole("cell"),
    ).toHaveText([left, right]);
  }
}

test("series comparison preserves selected books and public metadata", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 750 });
  await page.goto(`/products/${compareFirst}`);
  const select = page.getByLabel("Chọn sách cùng bộ để so sánh", {
    exact: true,
  });
  await expect(select.locator("option")).toHaveText([
    "Chọn một cuốn sách",
    "Những lá thư gửi mùa thu",
    "Những mùa ở Lũng Mây",
  ]);
  await expect(select).toHaveValue("");
  await select.selectOption(compareSecond);
  await select.focus();
  await page.keyboard.press("Tab");
  const submit = page.getByRole("button", {
    name: "So sánh sách",
    exact: true,
  });
  await expect(submit).toBeFocused();
  await expect(submit).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(comparisonURL);
  await expectComparison(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
  await page.reload();
  await expectComparison(page);
  const table = page.getByRole("table");
  for (const [title, slug] of [
    ["Khu vườn sau cơn mưa", compareFirst],
    ["Những lá thư gửi mùa thu", compareSecond],
  ]) {
    await expect(
      table.getByRole("link", { name: title, exact: true }),
    ).toHaveAttribute("href", `/products/${slug}`);
  }
  await table
    .getByRole("link", { name: "Những lá thư gửi mùa thu", exact: true })
    .click();
  await expect(page).toHaveURL(`/products/${compareSecond}`);
  await page.goto(
    `/compare?book=${compareSecond}&with=${compareFirst}&series=untrusted`,
  );
  await expect(table.getByRole("columnheader")).toHaveText([
    "Thông tin",
    "Những lá thư gửi mùa thu",
    "Khu vườn sau cơn mưa",
  ]);
  await expect(
    table
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: "Tập / nội dung" }) })
      .getByRole("cell"),
  ).toHaveText(["Tập 2", "Tập 1"]);
});

test("invalid series comparisons offer a safe recovery without substituting books", async ({
  page,
}) => {
  await page.goto("/products/ban-do-cua-gio");
  await expect(
    page.getByRole("button", { name: "So sánh sách", exact: true }),
  ).toHaveCount(0);
  for (const query of [
    `book=${compareFirst}`,
    `book=${compareFirst}&book=${compareFirst}&with=${compareSecond}`,
    `book=${compareFirst}&with=${compareSecond}&with=${compareSecond}`,
    `book=${compareFirst}&with=${compareFirst}`,
    `book=${compareFirst}&with=unknown-book`,
    `book=${compareFirst}&with=nguoi-giu-nhung-vi-sao&series=nhung-mua-o-lung-may`,
    `book=${compareFirst}&with=ban-do-cua-gio`,
    `book=${compareFirst}&with=https%3A%2F%2Fevil.example&returnTo=%2F%2Fevil.example`,
    `book=${compareFirst}&with=%00${compareSecond}`,
  ]) {
    await test.step(query, async () => {
      await page.goto(`/compare?${query}`);
      await expect(
        page.getByRole("heading", { name: "Không thể so sánh lựa chọn này" }),
      ).toBeVisible();
      await expect(page.getByRole("table")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Trở lại kệ sách", exact: true }),
      ).toHaveAttribute("href", "/catalog");
    });
  }
  await page
    .getByRole("link", { name: "Trở lại kệ sách", exact: true })
    .click();
  await expect(page).toHaveURL("/catalog");
});

test.describe("catalog GET navigation without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("series comparison submits a native GET without JavaScript", async ({
    page,
  }) => {
    await page.goto(`/products/${compareFirst}`);
    await page
      .getByLabel("Chọn sách cùng bộ để so sánh", { exact: true })
      .selectOption(compareSecond);
    await page
      .getByRole("button", { name: "So sánh sách", exact: true })
      .click();
    await expect(page).toHaveURL(comparisonURL);
    await expectComparison(page);
  });

  test("product genre discovery opens the category-only catalog", async ({
    page,
  }) => {
    await page.goto(`/products/${narrowedSlugs[0]}?${narrowedQuery}`);
    await expect(
      page.getByRole("link", { name: "Trở lại kết quả", exact: true }),
    ).toHaveAttribute("href", `/catalog?${narrowedQuery}`);
    await page
      .getByRole("link", { name: lightNovelGenreLink, exact: true })
      .click();
    await expectDefaultLightNovelCatalog(page);
  });

  test("product links return to matching catalog cards", async ({ page }) => {
    await page.goto(`/catalog?${narrowedQuery}`);
    await expectNarrowedCatalog(page);
    await page
      .getByRole("link", { name: `Xem ${narrowedTitles[0]}`, exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      narrowedTitles[0],
    );
    await page
      .getByRole("link", { name: "Trở lại kết quả", exact: true })
      .click();
    await expect(page).toHaveURL(`/catalog?${narrowedQuery}`);
    await expectNarrowedCatalog(page);
  });

  test("encoded search stays intact in category links and empty results", async ({
    page,
  }) => {
    await page.goto("/catalog");
    const submitted = "Tiếng Việt & + # % ?";
    const query = page.getByLabel("Tên sách, tác giả hoặc nội dung");
    await query.fill(submitted);
    await page.getByLabel("Sắp xếp", { exact: true }).selectOption("recent");
    await page.getByRole("button", { name: "Tìm & lọc" }).click();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("q") === submitted,
    );
    await expect(page.locator(".result-line span")).toHaveText(
      `0 sách minh họa cho “${submitted}”`,
    );

    const manga = page
      .locator(".chip-row")
      .getByRole("link", { name: "Manga", exact: true });
    await query.fill("bản nháp");
    await manga.click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === "/catalog" &&
        url.searchParams.get("q") === submitted &&
        url.searchParams.get("sort") === "recent" &&
        url.searchParams.get("category") === "manga" &&
        Array.from(url.searchParams.keys()).length === 3 &&
        !url.hash,
    );
    await expect(query).toHaveValue(submitted);
    await expect(page.getByLabel("Thể loại", { exact: true })).toHaveValue(
      "manga",
    );
    await expect(page.getByLabel("Sắp xếp", { exact: true })).toHaveValue(
      "recent",
    );
    await expect(manga).toHaveAttribute("aria-current", "true");
    await expect(page.locator(".result-line span")).toHaveText(
      `0 sách minh họa cho “${submitted}”`,
    );
    await expect(
      page.getByRole("heading", { name: "Chưa tìm thấy câu chuyện này" }),
    ).toBeVisible();
    await expect(page.locator(".book-card")).toHaveCount(0);
  });
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
