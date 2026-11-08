import { expect, test, type Locator, type Page } from "@playwright/test";

// PR #1 quality gate only. These are rendered-evidence/interaction checks, not
// performance benchmarks, browser-zoom certification or screenshot baselines.
const routes = [
  { name: "home", path: "/" },
  { name: "catalog", path: "/catalog" },
  { name: "product", path: "/products/khu-vuon-sau-con-mua" },
  { name: "series", path: "/series/nhung-mua-o-lung-may" },
  { name: "news", path: "/news" },
  { name: "article", path: "/news/hen-voi-tiem-tra" },
  { name: "releases", path: "/releases" },
  { name: "wishlist", path: "/wishlist" },
  { name: "cart", path: "/cart" },
] as const;

async function fontsAndFrames(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function openPage(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), `GET ${path}`).toBe(200);
  await expect(page.locator("main h1")).toBeVisible();
  await fontsAndFrames(page);
}

async function populateThroughUI(page: Page) {
  for (const book of [
    { slug: "khu-vuon-sau-con-mua", title: "Khu vườn sau cơn mưa" },
    { slug: "dem-trang-tren-mai-nha", title: "Đêm trăng trên mái nhà" },
  ]) {
    await openPage(page, `/products/${book.slug}`);
    await page
      .getByRole("button", { name: `Yêu thích: ${book.title}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Thêm vào giỏ thử nghiệm", exact: true })
      .click();
  }
  await expect(
    page.getByRole("button", { name: "Mở giỏ thử nghiệm (2)", exact: true }),
  ).toBeVisible();
}

async function transform(locator: Locator) {
  return locator.evaluate((element) => {
    const value = getComputedStyle(element).transform;
    const matrix =
      value === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(value);
    return {
      x: matrix.m41,
      y: matrix.m42,
      scaleX: Math.hypot(matrix.m11, matrix.m12, matrix.m13),
      rotateX: (Math.atan2(matrix.m23, matrix.m22) * 180) / Math.PI,
      rotateY: (Math.atan2(matrix.m31, matrix.m11) * 180) / Math.PI,
    };
  });
}

async function instantScroll(page: Page, top: number) {
  await page.evaluate(
    (y) => window.scrollTo({ top: y, behavior: "instant" }),
    top,
  );
  await fontsAndFrames(page);
}

type ExitSample = {
  connected: boolean;
  state: string | null;
  x: number;
  opacity: number;
};
async function probeDrawerExit(page: Page) {
  await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(
      ".mobile-drawer[role='dialog']",
    );
    if (!panel) throw new Error("No open drawer to inspect");
    const target = window as typeof window & {
      __qualityExitSamples?: ExitSample[];
    };
    const samples: ExitSample[] = [];
    target.__qualityExitSamples = samples;
    function collect() {
      const style = getComputedStyle(panel!);
      const matrix =
        style.transform === "none"
          ? new DOMMatrixReadOnly()
          : new DOMMatrixReadOnly(style.transform);
      samples.push({
        connected: panel!.isConnected,
        state: panel!.getAttribute("data-state"),
        x: matrix.m41,
        opacity: Number(style.opacity),
      });
      if (panel!.isConnected) requestAnimationFrame(collect);
    }
    requestAnimationFrame(collect);
  });
}
async function expectExitedWithMotion(page: Page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".drawer-overlay")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const target = window as typeof window & {
          __qualityExitSamples?: ExitSample[];
        };
        return (
          target.__qualityExitSamples?.some((sample) => !sample.connected) ??
          false
        );
      }),
    )
    .toBe(true);
  const samples = await page.evaluate(() => {
    const target = window as typeof window & {
      __qualityExitSamples?: ExitSample[];
    };
    return target.__qualityExitSamples ?? [];
  });
  expect(
    samples.some(
      (sample) =>
        sample.connected &&
        sample.state === "closed" &&
        (sample.x > 1 || sample.opacity < 0.98),
    ),
    "normal-motion drawer must render an exit, not only disappear",
  ).toBe(true);
}

test("quality gate: nine representative populated page captures and runtime errors", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydrat|Minified React error|server rendered|didn't match/i.test(
        message.text(),
      )
    )
      hydrationErrors.push(message.text());
  });
  await populateThroughUI(page);
  // Reduced motion is scoped to this visual-capture test. Normal-motion tests
  // below explicitly request no-preference and inspect actual transforms.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const route of routes) {
    await openPage(page, route.path);
    if (route.name === "wishlist" || route.name === "cart")
      await expect(page.locator(".collection-row")).toHaveCount(2);
    await expect(page.locator(".demo-banner")).toContainText(
      "KHÔNG GIAN THỬ NGHIỆM",
    );
    await page.screenshot({
      path: `test-results/quality-gate/${testInfo.project.name}/${route.name}.png`,
      fullPage: true,
      scale: "css",
    });
  }
  expect(
    runtimeErrors,
    "uncaught browser exceptions across all nine routes",
  ).toEqual([]);
  expect(
    hydrationErrors,
    "React hydration console errors across all nine routes",
  ).toEqual([]);
});

test("quality gate: landscape and zoom-equivalent reflow includes populated collections", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await populateThroughUI(page);
  const viewports = [
    { width: 844, height: 390, label: "landscape" },
    {
      width: 640,
      height: 400,
      label: "1280x800 at 200% equivalent CSS viewport",
    },
    {
      width: 320,
      height: 450,
      label: "1280-wide at 400% equivalent reflow width",
    },
  ];
  for (const route of routes) {
    await openPage(page, route.path);
    if (route.name === "wishlist" || route.name === "cart")
      await expect(page.locator(".collection-row")).toHaveCount(2);
    for (const viewport of viewports) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await fontsAndFrames(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${route.path}: ${viewport.label}`,
      ).toBe(true);
    }
  }
  // This tests equivalent reflow widths, NOT native browser zoom, text-only
  // zoom, OS scaling or visual performance on a physical mobile device.
});

test("quality gate: real tilt has both signed axes, bounded amplitude and reset", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("mobile"),
    "Fine-pointer tilt is intentionally unavailable for touch",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPage(page, "/products/khu-vuon-sau-con-mua");
  const tilt = page.locator(".product-cover-stage [data-tilt]");
  await tilt.scrollIntoViewIfNeeded();
  for (const corner of [0.85, 0.15]) {
    const bounds = await tilt.boundingBox();
    if (!bounds) throw new Error("Book cover has no rendered box");
    await page.mouse.move(
      bounds.x + bounds.width * corner,
      bounds.y + bounds.height * (1 - corner),
    );
    const sign = corner > 0.5 ? 1 : -1;
    await expect
      .poll(async () => {
        const value = await transform(tilt);
        return value.rotateX * sign > 1.5 && value.rotateY * sign > 1.5;
      })
      .toBe(true);
    const value = await transform(tilt);
    expect(Math.abs(value.rotateX)).toBeLessThanOrEqual(4.25);
    expect(Math.abs(value.rotateY)).toBeLessThanOrEqual(4.25);
  }
  await page.mouse.move(0, 0);
  await expect
    .poll(async () => {
      const value = await transform(tilt);
      return Math.abs(value.rotateX) < 0.1 && Math.abs(value.rotateY) < 0.1;
    })
    .toBe(true);
});

test("quality gate: actual book-card root hover elevation survives reveal", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("mobile"),
    "Desktop card elevation is gated by layout/pointer mode",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPage(page, "/");
  const card = page.locator(".featured-section .book-card").first();
  await card.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await expect
    .poll(async () => Math.abs((await transform(card)).y))
    .toBeLessThan(0.15);
  await card.hover({ position: { x: 8, y: 8 } });
  await expect.poll(async () => (await transform(card)).y).toBeLessThan(-2.5);
  expect((await transform(card)).y).toBeGreaterThanOrEqual(-4.25);
  await page.mouse.move(0, 0);
  await expect
    .poll(async () => Math.abs((await transform(card)).y))
    .toBeLessThan(0.15);
});

test("quality gate: primary button hover and actual held press both respond", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("mobile"),
    "Hover acceptance requires fine pointer; touch has its own functional test",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPage(page, "/products/khu-vuon-sau-con-mua");
  const button = page.getByRole("button", {
    name: "Thêm vào giỏ thử nghiệm",
    exact: true,
  });
  await button.hover();
  await expect.poll(async () => (await transform(button)).y).toBeLessThan(-1.8);
  await page.mouse.down();
  try {
    await expect
      .poll(async () => (await transform(button)).scaleX)
      .toBeLessThan(0.985);
    expect((await transform(button)).scaleX).toBeGreaterThanOrEqual(0.96);
  } finally {
    await page.mouse.up();
  }
  await expect(
    page.getByRole("button", { name: "Mở giỏ thử nghiệm (1)", exact: true }),
  ).toBeVisible();
});

test("quality gate: navigation underline animates to and from hover", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("mobile"),
    "Mobile uses drawer navigation, not desktop underline",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPage(page, "/");
  const link = page.locator(".desktop-nav a[href='/catalog']");
  const indicatorScale = () =>
    link.evaluate((element) => {
      const value = getComputedStyle(element, "::after").transform;
      return value === "none" ? 1 : new DOMMatrixReadOnly(value).m11;
    });
  await page.mouse.move(0, 0);
  await expect.poll(indicatorScale).toBeLessThan(0.01);
  await link.hover();
  await expect.poll(indicatorScale).toBeGreaterThan(0.99);
  await page.mouse.move(0, 0);
  await expect.poll(indicatorScale).toBeLessThan(0.01);
});

test("quality gate: scroll reveals settle visibly and carry deterministic stagger metadata", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPage(page, "/");
  const cards = page.locator(".featured-section .book-card");
  const delays = await cards.evaluateAll((elements) =>
    elements.map((element) =>
      Number.parseFloat(
        getComputedStyle(
          element.querySelector("[style*='--reveal-delay']") ?? element,
        ).getPropertyValue("--reveal-delay"),
      ),
    ),
  );
  expect(delays).toEqual([0, 0.04, 0.08, 0.12]);
  const firstReveal = cards.first();
  const revealState = () =>
    firstReveal.evaluate((element) => {
      const reveal =
        element.querySelector<HTMLElement>("[style*='--reveal-delay']") ??
        element.closest<HTMLElement>("[style*='--reveal-delay']") ??
        element;
      const style = getComputedStyle(reveal);
      const matrix =
        style.transform === "none"
          ? new DOMMatrixReadOnly()
          : new DOMMatrixReadOnly(style.transform);
      return { y: matrix.m42, opacity: Number(style.opacity) };
    });
  expect(
    (await revealState()).opacity,
    "content must not start invisible",
  ).toBe(1);
  await firstReveal.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await expect
    .poll(async () => Math.abs((await revealState()).y))
    .toBeLessThan(0.15);
  expect((await revealState()).opacity).toBe(1);
  // Custom properties prove ordered configured delay, not measured frame timing.
});

test("quality gate: hero parallax is bounded and disabled in mobile portrait and landscape", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPage(page, "/");
  const art = page.locator(".hero-art");
  await page.mouse.move(0, 0);
  if (testInfo.project.name.startsWith("mobile")) {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await instantScroll(page, 600);
      expect(
        await art.evaluate((element) => getComputedStyle(element).transform),
        `touch layout ${viewport.width} wide`,
      ).toBe("none");
    }
  } else {
    await instantScroll(page, 0);
    await expect
      .poll(async () => Math.abs((await transform(art)).y))
      .toBeLessThan(0.1);
    await instantScroll(page, 300);
    await expect
      .poll(async () => Math.abs((await transform(art)).y - 6))
      .toBeLessThan(0.5);
    await instantScroll(page, 1200);
    await expect
      .poll(async () => Math.abs((await transform(art)).y - 12))
      .toBeLessThan(0.15);
    const value = await transform(art);
    expect(value.y).toBeLessThanOrEqual(12.15);
    expect(Math.abs(value.x)).toBeLessThanOrEqual(8.15);
  }
});

test("quality gate: reduced motion disables decoration without disabling actions", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPage(page, "/");
  await instantScroll(page, 600);
  expect(
    await page
      .locator(".hero-art")
      .evaluate((element) => getComputedStyle(element).transform),
  ).toBe("none");
  const tilt = page.locator("[data-tilt]").first();
  await tilt.dispatchEvent("pointermove", {
    pointerType: "mouse",
    clientX: 500,
    clientY: 500,
  });
  expect(
    await tilt.evaluate((element) => getComputedStyle(element).transform),
  ).toBe("none");
  expect(
    await page
      .locator(".button")
      .first()
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe("0s");
  await openPage(page, "/products/khu-vuon-sau-con-mua");
  await page
    .getByRole("button", { name: "Thêm vào giỏ thử nghiệm", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mở giỏ thử nghiệm (1)", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("quality gate: normal cart drawer renders exit and returns keyboard focus", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPage(page, "/products/khu-vuon-sau-con-mua");
  await page
    .getByRole("button", { name: "Thêm vào giỏ thử nghiệm", exact: true })
    .click();
  const trigger = page.getByRole("button", {
    name: "Mở giỏ thử nghiệm (1)",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Đóng giỏ thử nghiệm" }),
  ).toBeFocused();
  await expect
    .poll(async () => Math.abs((await transform(panel)).x))
    .toBeLessThan(0.2);
  await expect
    .poll(() =>
      panel.evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeGreaterThan(0.99);
  await probeDrawerExit(page);
  await page.keyboard.press("Escape");
  await expectExitedWithMotion(page);
  await expect(trigger).toBeFocused();
});

test("quality gate: mobile touch menu traps focus, animates exit and navigates", async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith("mobile"),
    "Touch workflow belongs to mobile project",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPage(page, "/");
  const trigger = page.getByRole("button", { name: "Mở menu", exact: true });
  await trigger.tap();
  const panel = page.getByRole("dialog");
  const close = panel.getByRole("button", { name: "Đóng menu", exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    panel.getByRole("link", { name: "Chuyện tiệm sách", exact: true }),
  ).toBeFocused();
  await expect
    .poll(async () => Math.abs((await transform(panel)).x))
    .toBeLessThan(0.2);
  await probeDrawerExit(page);
  await close.tap();
  await expectExitedWithMotion(page);
  await expect(trigger).toBeFocused();
  await trigger.tap();
  await panel.getByRole("link", { name: "Kệ sách", exact: true }).tap();
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("quality gate: feedback is dismissible, restores focus and expires", async ({
  page,
}) => {
  await openPage(page, "/products/khu-vuon-sau-con-mua");
  const add = page.getByRole("button", {
    name: "Thêm vào giỏ thử nghiệm",
    exact: true,
  });
  await add.click();
  await expect(page.getByRole("status")).toContainText("1 quyển");
  await page
    .getByRole("button", { name: "Đóng thông báo", exact: true })
    .click();
  await expect(page.getByRole("status")).toBeEmpty();
  await expect(add).toBeFocused();
  await add.click();
  await expect(page.getByRole("status")).toContainText("2 quyển");
  await expect(page.getByRole("status")).toBeEmpty({ timeout: 10000 });
});

test("quality gate: action feedback does not cover focused footer control at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openPage(page, "/products/khu-vuon-sau-con-mua");
  await page
    .getByRole("button", { name: "Thêm vào giỏ thử nghiệm", exact: true })
    .click();
  const target = page.locator(".site-footer a").last();
  await target.evaluate((element) => {
    element.scrollIntoView({ block: "end", behavior: "instant" });
    window.scrollBy({ top: 40, behavior: "instant" });
    (element as HTMLElement).focus({ preventScroll: true });
  });
  await expect(target).toBeFocused();
  const result = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const feedback = document.querySelector<HTMLElement>(".live-feedback");
    const feedbackRect = feedback?.getBoundingClientRect();
    const feedbackStyle = feedback ? getComputedStyle(feedback) : null;
    const feedbackVisible = Boolean(
      feedback?.textContent?.trim() &&
      feedbackStyle?.display !== "none" &&
      Number(feedbackStyle?.opacity) > 0,
    );
    return {
      inViewport: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
      ownsHit: hit === element || Boolean(hit && element.contains(hit)),
      visuallyCovered: Boolean(
        feedbackVisible &&
        feedbackRect &&
        x >= feedbackRect.left &&
        x <= feedbackRect.right &&
        y >= feedbackRect.top &&
        y <= feedbackRect.bottom,
      ),
    };
  });
  expect(result.inViewport).toBe(true);
  expect(
    result.ownsHit,
    "focused link must be the hit-test target, not feedback overlay",
  ).toBe(true);
  expect(
    result.visuallyCovered,
    "pointer-events:none alone does not prevent visual focus occlusion",
  ).toBe(false);
});
