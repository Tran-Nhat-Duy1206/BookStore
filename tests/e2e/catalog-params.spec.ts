import { test, expect } from "@playwright/test";

test("padded category URLs keep results and selected controls consistent", async ({
  page,
}) => {
  await page.goto("/catalog?category=%20manga%20&sort=%20title%20");
  await expect(page.locator(".book-card")).toHaveCount(2);
  await expect(page.getByLabel("Thể loại", { exact: true })).toHaveValue(
    "manga",
  );
  await expect(page.getByLabel("Sắp xếp", { exact: true })).toHaveValue(
    "title",
  );
  await expect(page.locator('.chip[aria-current="true"]')).toHaveText("Manga");
});

test("unrecognized category and sort safely fall back to matching UI defaults", async ({
  page,
}) => {
  await page.goto("/catalog?category=not-a-category&sort=not-a-sort");
  await expect(page.getByLabel("Thể loại", { exact: true })).toHaveValue("all");
  await expect(page.getByLabel("Sắp xếp", { exact: true })).toHaveValue(
    "default",
  );
  await expect(page.locator(".book-card")).toHaveCount(12);
  await expect(page.locator('.chip[aria-current="true"]')).toHaveText("Tất cả");
});
