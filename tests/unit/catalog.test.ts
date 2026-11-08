import { describe, expect, it } from "vitest";
import { books, categories, series, type Book } from "@/modules/catalog/data";
import { discoverBooks, normalizeSearch } from "@/modules/catalog/search";
import { articles, releases } from "@/modules/editorial/data";
import { site } from "@/config/site";

const ids = (items: readonly Book[]) => items.map((book) => book.id);

function expectUnique(values: string[]) {
  expect(new Set(values).size).toBe(values.length);
  expect(values.every((value) => value.trim().length > 0)).toBe(true);
}

describe("Vietnamese fictional catalog integrity", () => {
  it("has unique, usable identifiers and route slugs", () => {
    expect(books.length).toBeGreaterThanOrEqual(10);
    expect(books.length).toBeLessThanOrEqual(12);
    for (const collection of [books, categories, series, articles, releases]) {
      expectUnique(collection.map((item) => item.id));
    }
    for (const collection of [books, series, articles]) {
      expectUnique(collection.map((item) => item.slug));
      for (const item of collection)
        expect(item.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("populates every category and includes literature and original comic formats", () => {
    expect(categories.map((category) => category.id)).toEqual(
      expect.arrayContaining([
        "van-hoc",
        "manga",
        "manhwa",
        "manhua",
        "light-novel",
      ]),
    );
    for (const category of categories) {
      expect(category.label.trim()).not.toBe("");
      expect(category.description.trim()).not.toBe("");
      expect(books.some((book) => book.category === category.id)).toBe(true);
    }
    for (const book of books)
      expect(categories.some((category) => category.id === book.category)).toBe(
        true,
      );
  });

  it("has complete Vietnamese metadata and only supported original cover motifs", () => {
    for (const book of books) {
      for (const text of [
        book.title,
        book.author,
        book.volume,
        book.edition,
        book.description,
        book.eyebrow,
      ]) {
        expect(text.trim().length).toBeGreaterThan(0);
      }
      expect(book.language).toBe("Tiếng Việt");
      expect(Number.isInteger(book.year)).toBe(true);
      expect(["forest", "clay", "navy", "gold", "plum", "sage"]).toContain(
        book.color,
      );
      expect([
        "moon",
        "mountain",
        "botanical",
        "stars",
        "waves",
        "sun",
      ]).toContain(book.motif);
      expect(book.description).toContain("hư cấu");
    }
  });

  it("links both series bidirectionally and retains standalone and omnibus editions", () => {
    expect(series).toHaveLength(2);
    for (const collection of series) {
      expectUnique(collection.bookIds);
      expect(collection.bookIds.length).toBeGreaterThanOrEqual(2);
      for (const id of collection.bookIds) {
        expect(books.find((book) => book.id === id)?.seriesId).toBe(
          collection.id,
        );
      }
    }
    for (const book of books.filter((item) => item.seriesId)) {
      expect(
        series.find((item) => item.id === book.seriesId)?.bookIds,
      ).toContain(book.id);
    }
    expect(books.some((book) => !book.seriesId)).toBe(true);
    expect(
      books.some(
        (book) =>
          /hợp tuyển/.test(book.edition) && /gộp/.test(book.description),
      ),
    ).toBe(true);
  });

  it("links complete editorial articles to existing books", () => {
    expect(articles.length).toBeGreaterThan(0);
    expect(articles.some((article) => article.featured)).toBe(true);
    for (const article of articles) {
      expect(article.title.trim()).not.toBe("");
      expect(article.excerpt.trim()).not.toBe("");
      expect(article.kind.trim()).not.toBe("");
      expect(article.body.length).toBeGreaterThan(0);
      expect(
        article.body.every((paragraph) => paragraph.trim().length > 0),
      ).toBe(true);
      expect(article.body.join(" ")).toContain("hư cấu");
      expect(article.date).toMatch(/^2027-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(article.date))).toBe(false);
      expect(article.bookIds.length).toBeGreaterThan(0);
      for (const id of article.bookIds)
        expect(books.some((book) => book.id === id)).toBe(true);
    }
  });

  it("labels all four release states as fictional 2027 demonstrations, not live promises", () => {
    expect(new Set(releases.map((release) => release.status))).toEqual(
      new Set(["confirmed", "tentative", "postponed", "unknown"]),
    );
    for (const release of releases) {
      expect(books.some((book) => book.id === release.bookId)).toBe(true);
      expect(release.dateLabel).toContain("2027");
      expect(release.dateLabel).toContain("minh họa");
      expect(release.note).toMatch(/hư cấu|trình diễn/);
      expect(release.note).toMatch(/không|chưa/);
    }
  });

  it("disables commerce and avoids pricing, stock, or fulfillment claims in fixtures", () => {
    expect(site).toMatchObject({
      name: "Mộc & Mực",
      locale: "vi-VN",
      currency: "VND",
      timeZone: "Asia/Ho_Chi_Minh",
      commercialEnabled: false,
    });
    expect(site.demoNotice).toContain("tạm thời");
    expect(site.demoNotice).toContain("hư cấu");
    expect(site.demoNotice).toContain("Không bán hàng");
    expect(site.demoNotice).toContain("không dùng tranh bìa có bản quyền");
    const forbiddenKeys =
      /^(price|salePrice|originalPrice|stock|inStock|inventory|quantity|availability|purchaseUrl|checkoutUrl)$/i;
    for (const record of [
      ...books,
      ...categories,
      ...series,
      ...articles,
      ...releases,
    ]) {
      expect(Object.keys(record).some((key) => forbiddenKeys.test(key))).toBe(
        false,
      );
    }
    const catalogCopy = JSON.stringify({
      books,
      categories,
      series,
      articles,
      releases,
    });
    expect(catalogCopy).not.toMatch(
      /\d[\d.,]*\s*(?:₫|VND|đồng)\b|còn hàng|hết hàng|giao hàng trong|mua ngay|thêm vào giỏ/i,
    );
  });
});

describe("normalizeSearch", () => {
  it.each([
    ["  ĐÊM   Trăng\n trên\t MÁI nhà  ", "dem trang tren mai nha"],
    ["Đỗ Mây", "do may"],
    ["Khu vườn sau cơn mưa", "khu vuon sau con mua"],
    ["Tiệm trà".normalize("NFD"), "tiem tra"],
    ["", ""],
    [" \t\n ", ""],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeSearch(input)).toBe(expected);
  });

  it("is idempotent", () => {
    const normalized = normalizeSearch("  Đỗ MÂY và một khu VƯỜN ");
    expect(normalizeSearch(normalized)).toBe(normalized);
  });
});

describe("discoverBooks", () => {
  it("returns a new array in curated order for omitted or blank queries", () => {
    for (const options of [
      undefined,
      {},
      { query: "" },
      { query: " \t\n " },
      { category: "all" },
    ]) {
      const result = discoverBooks(books, options);
      expect(result).toEqual(books);
      expect(result).not.toBe(books);
    }
  });

  it("matches Vietnamese titles with or without accents, uppercase, and đ", () => {
    const expected = ["dem-trang-tren-mai-nha"];
    expect(ids(discoverBooks(books, { query: "ĐÊM TRĂNG" }))).toEqual(expected);
    expect(ids(discoverBooks(books, { query: "dem trang" }))).toEqual(expected);
    expect(
      ids(discoverBooks(books, { query: "Đêm trăng".normalize("NFD") })),
    ).toEqual(expected);
  });

  it("matches author names without Vietnamese accents", () => {
    expect(ids(discoverBooks(books, { query: "do may" }))).toEqual(
      expect.arrayContaining(["ban-do-cua-gio", "dem-trang-tren-mai-nha"]),
    );
    expect(
      discoverBooks(books, { query: "HA MOC" }).every(
        (book) => book.author === "Hạ Mộc",
      ),
    ).toBe(true);
    expect(discoverBooks(books, { query: "HA MOC" })).toHaveLength(2);
  });

  it("requires every query word while allowing words across title and author fields", () => {
    expect(ids(discoverBooks(books, { query: "MÂY   trăng ĐỖ mái" }))).toEqual([
      "dem-trang-tren-mai-nha",
    ]);
    expect(
      discoverBooks(books, { query: "trang tu-khoa-khong-ton-tai" }),
    ).toEqual([]);
  });

  it("combines category and query filters and trims category values", () => {
    expect(
      ids(discoverBooks(books, { query: "do may", category: " manga " })),
    ).toEqual(["ban-do-cua-gio", "dem-trang-tren-mai-nha"]);
    expect(
      discoverBooks(books, { query: "do may", category: "van-hoc" }),
    ).toEqual([]);
    expect(discoverBooks(books, { category: "not-a-category" })).toEqual([]);
    expect(discoverBooks(books, { category: " " })).toEqual(books);
  });

  it("returns no matches for an unknown query or empty input collection", () => {
    expect(discoverBooks(books, { query: "xyz-khong-co-sach-nay" })).toEqual(
      [],
    );
    expect(discoverBooks([], { query: "trang", sort: "recent" })).toEqual([]);
    expect(discoverBooks([])).toEqual([]);
  });

  it("sorts titles with Vietnamese collation", () => {
    const result = discoverBooks(books, { sort: "title" });
    expect(ids(result)).toEqual(
      ids([...books].sort((a, b) => a.title.localeCompare(b.title, "vi-VN"))),
    );
    expect(new Set(ids(result))).toEqual(new Set(ids(books)));
    expect(ids(result)).not.toEqual(ids(books));
  });

  it("sorts recent editions first and keeps curated order for equal years", () => {
    const result = discoverBooks(books, { sort: "recent" });
    expect(result.map((book) => book.year)).toEqual(
      books.map((book) => book.year).sort((a, b) => b - a),
    );
    for (const year of new Set(books.map((book) => book.year))) {
      expect(ids(result.filter((book) => book.year === year))).toEqual(
        ids(books.filter((book) => book.year === year)),
      );
    }
  });

  it("preserves curated order for default and unrecognized sorting modes", () => {
    expect(discoverBooks(books, { sort: "default" })).toEqual(books);
    expect(discoverBooks(books, { sort: "unsupported" })).toEqual(books);
  });

  it("never mutates the input array or its books, including while filtering and sorting", () => {
    const input = Object.freeze(
      books.map((book) => Object.freeze({ ...book })),
    );
    const snapshot = JSON.stringify(input);
    for (const sort of ["title", "recent", "default"]) {
      const result = discoverBooks(input, { query: "hư cấu", sort });
      expect(result).not.toBe(input);
      expect(result.length).toBeGreaterThan(0);
      expect(JSON.stringify(input)).toBe(snapshot);
    }
  });
});
