import { renderToStaticMarkup } from "react-dom/server";
import { jsx } from "react/jsx-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import Product from "@/app/products/[slug]/page";
import SeriesDetail, { generateMetadata } from "@/app/series/[slug]/page";
import { DemoProvider } from "@/components/demo-state";
import type {
  Book,
  CatalogSnapshot,
  Series,
} from "@/modules/catalog/contracts";
import { readCatalog } from "@/modules/catalog/read-catalog";

vi.mock("@/modules/catalog/read-catalog", () => ({ readCatalog: vi.fn() }));
// A route component can run without Next's router; model only its terminating boundary signal.
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("test: Next notFound boundary");
  },
}));

const catalog = vi.mocked(readCatalog);
const book = (id: string, overrides: Partial<Book> = {}): Book => ({
  id,
  slug: id,
  title: `Book ${id}`,
  author: "Test author",
  category: "test-genre",
  volume: "Tập 1",
  edition: "Test edition",
  language: "Tiếng Việt",
  description: "In-memory public book.",
  year: 2027,
  color: "forest",
  motif: "botanical",
  eyebrow: "Test book",
  ...overrides,
});
const series = (id: string, bookIds: string[]): Series => ({
  id,
  slug: id,
  title: `Series ${id}`,
  description: `Description ${id}`,
  bookIds,
});
const genre = {
  id: "test-genre",
  label: "Test genre",
  description: "Public test genre",
};
const snapshot = (
  overrides: Partial<CatalogSnapshot> = {},
): CatalogSnapshot => ({
  books: [],
  categories: [],
  series: [],
  ...overrides,
});
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const product = (slug: string) =>
  Product({ ...params(slug), searchParams: Promise.resolve({}) });

async function markup(data: CatalogSnapshot, page: typeof Home) {
  catalog.mockResolvedValue(data);
  return renderToStaticMarkup(
    jsx(DemoProvider, { books: data.books, children: await page() }),
  );
}

// Project only rendered anchors, leaving selection and ordering to the actual pages/cards.
function hrefs(html: string, prefix: string) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((href) => href.startsWith(prefix));
}

function recommendations(html: string) {
  const shelf = html.match(
    /<section class="related-section">([\s\S]*?)<\/section>/,
  )?.[1];
  expect(shelf).toBeDefined();
  return shelf!;
}

function recommendationLinks(shelf: string) {
  return hrefs(
    [...shelf.matchAll(/<h3>.*?<\/h3>/g)].map((match) => match[0]).join(""),
    "/products/",
  );
}

beforeEach(() => {
  catalog.mockReset();
});

describe("sparse storefront production page rendering", () => {
  it("uses secondary-only shared public membership without unrelated books", async () => {
    const current = book("current", { seriesId: "primary-current" });
    const peer = book("peer", { seriesId: "primary-peer" });
    const data = snapshot({
      books: [current, book("unrelated"), peer],
      series: [
        series("primary-current", [current.id]),
        series("primary-peer", [peer.id]),
        series("shared", [current.id, peer.id]),
      ],
    });
    const shelf = recommendations(
      await markup(data, () => product(current.slug)),
    );
    expect(shelf).toContain("Trong cùng bộ truyện");
    expect(recommendationLinks(shelf)).toEqual(["/products/peer"]);
  });

  it("defensively excludes current and duplicate IDs and slugs, preserving peer order", async () => {
    const current = book("current");
    const first = book("first");
    const last = book("last");
    const data = snapshot({
      books: [
        current,
        first,
        book("first", { slug: "first-alias" }),
        book("first-shadow", { slug: "first" }),
        book("current", { slug: "current-alias" }),
        book("current-shadow", { slug: "current" }),
        last,
      ],
      series: [
        series("shared", [
          "current",
          "first",
          "first-shadow",
          "current-shadow",
          "last",
        ]),
      ],
    });
    const shelf = recommendations(
      await markup(data, () => product(current.slug)),
    );
    expect(shelf).toContain("Trong cùng bộ truyện");
    expect(recommendationLinks(shelf)).toEqual([
      "/products/first",
      "/products/last",
    ]);
  });

  it("renders the sole product and its catalog navigation without an empty recommendation shelf", async () => {
    const data = snapshot({ books: [book("current")] });
    const html = await markup(data, () => product("current"));
    expect(html).toContain("<h1>Book current</h1>");
    expect(hrefs(html, "/catalog")).toEqual(["/catalog"]);
    expect(html).not.toContain("related-section");
    expect(html).not.toContain("Trong cùng bộ truyện");
    expect(html).not.toContain("Có thể bạn sẽ thích");
  });

  it.each([true, false])(
    "uses a truthful fallback heading (same genre: %s)",
    async (sameGenre) => {
      const data = snapshot({
        books: [
          book("current", { seriesId: "solo" }),
          book("alternative", { category: "other" }),
          ...(sameGenre ? [book("genre-peer")] : []),
        ],
        series: [series("solo", ["current"])],
      });
      const shelf = recommendations(
        await markup(data, () => product("current")),
      );
      expect(shelf).toContain("Có thể bạn sẽ thích");
      expect(shelf).not.toContain("Trong cùng bộ truyện");
      expect(recommendationLinks(shelf)).toEqual([
        sameGenre ? "/products/genre-peer" : "/products/alternative",
      ]);
    },
  );

  const releaseBooks = [
    "khu-vuon-sau-con-mua",
    "tiem-tra-cuoi-chan-troi",
    "nhung-la-thu-gui-mua-thu",
    "nguoi-giu-nhung-vi-sao",
    "nhung-mua-o-lung-may-hop-tuyen",
  ].map((id) => book(id));
  const populated = snapshot({
    books: releaseBooks,
    categories: [genre],
    series: [series("populated-series", [releaseBooks[0].id])],
  });

  function releaseLinks(html: string) {
    const shelf = html.match(
      /<div class="home-releases">([\s\S]*?)<\/div>/,
    )?.[1];
    expect(shelf).toBeDefined();
    return hrefs(shelf!, "/products/");
  }

  it("keeps populated discovery and the first three release previews", async () => {
    const html = await markup(populated, Home);
    expect(html).toContain("featured-section");
    expect(html).not.toContain("Chưa có sách trên kệ");
    expect(hrefs(html, "/catalog")).toContain("/catalog?category=test-genre");
    expect(hrefs(html, "/series")).toEqual([
      "/series",
      "/series/populated-series",
    ]);
    expect(releaseLinks(html)).toEqual([
      "/products/khu-vuon-sau-con-mua",
      "/products/tiem-tra-cuoi-chan-troi",
      "/products/nhung-la-thu-gui-mua-thu",
    ]);
  });

  it("omits the category shelf alone when categories are empty", async () => {
    const html = await markup({ ...populated, categories: [] }, Home);
    expect(html).not.toContain("category-grid");
    expect(html).not.toContain("Mỗi kệ sách, một lối nhỏ");
    expect(hrefs(html, "/catalog")).toContain("/catalog");
    expect(hrefs(html, "/series")).toContain("/series/populated-series");
  });

  it("omits the series shelf alone when public series are empty", async () => {
    const html = await markup({ ...populated, series: [] }, Home);
    expect(html).not.toContain("series-grid");
    expect(html).not.toContain("Ở lại cùng một bộ truyện");
    expect(hrefs(html, "/catalog")).toContain("/catalog?category=test-genre");
  });

  it("omits the release shelf when no preview references resolve", async () => {
    const html = await markup(
      { ...populated, books: [book("only-public-book")] },
      Home,
    );
    expect(html).not.toContain("release-section");
    expect(html).not.toContain("Sắp ghé lên kệ");
    expect(hrefs(html, "/products/")).not.toContain(
      "/products/khu-vuon-sau-con-mua",
    );
    expect(hrefs(html, "/products/")).toContain("/products/only-public-book");
  });

  it("skips unresolved previews before the limit and retains editorial order", async () => {
    const html = await markup(
      {
        ...populated,
        books: [
          releaseBooks[4],
          releaseBooks[3],
          releaseBooks[2],
          releaseBooks[1],
        ],
      },
      Home,
    );
    expect(releaseLinks(html)).toEqual([
      "/products/tiem-tra-cuoi-chan-troi",
      "/products/nhung-la-thu-gui-mua-thu",
      "/products/nguoi-giu-nhung-vi-sao",
    ]);
    expect(hrefs(html, "/products/")).not.toContain(
      "/products/khu-vuon-sau-con-mua",
    );
  });

  it("shows the empty-book recovery on a successful empty homepage without fallback books", async () => {
    const html = await markup(snapshot(), Home);
    expect(html).toContain("Chưa có sách trên kệ");
    expect(html).toMatch(/href="\/news">Đọc chuyện tiệm sách<\/a>/);
    expect(hrefs(html, "/catalog")).toContain("/catalog");
    expect(hrefs(html, "/products/")).toEqual([]);
    expect(html).not.toMatch(
      /category-grid|series-grid|release-section|hero-book/,
    );
  });

  it("renders known empty-series identity, metadata and a fixed recovery link", async () => {
    const data = snapshot({
      books: [book("unrelated")],
      series: [series("known", ["not-in-public-books"])],
    });
    const html = await markup(data, () => SeriesDetail(params("known")));
    expect(html).toContain("<h1>Series known</h1>");
    expect(html).toContain("Description known");
    expect(await generateMetadata(params("known"))).toEqual({
      title: "Series known",
    });
    expect(html).toContain("Chưa có sách công khai trong bộ truyện này");
    expect(html).toMatch(/href="\/series">Xem tất cả bộ truyện<\/a>/);
    expect(hrefs(html, "/products/")).toEqual([]);
  });

  it("signals the framework not-found boundary for an unknown series", async () => {
    catalog.mockResolvedValue(snapshot({ series: [series("known", [])] }));
    await expect(SeriesDetail(params("unknown"))).rejects.toThrow(
      "test: Next notFound boundary",
    );
  });

  it.each([
    ["homepage", () => Home()],
    ["series", () => SeriesDetail(params("known"))],
    ["product", () => product("current")],
  ])(
    "propagates a rejected catalog read on the %s page",
    async (_name, renderPage) => {
      const failure = new Error("in-memory catalog rejection");
      catalog.mockImplementation(async () => {
        throw failure;
      });
      const propagated = await renderPage().then(
        () => false,
        (error: unknown) => error === failure,
      );
      expect(propagated).toBe(true);
    },
  );
});
