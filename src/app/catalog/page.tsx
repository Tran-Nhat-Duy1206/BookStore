import Link from "next/link";
import { Search, ArrowRight } from "lucide-react";
import { readCatalog } from "@/modules/catalog/read-catalog";
import {
  catalogFilterSuffix,
  readCatalogFilters,
  type FilterParams,
} from "@/modules/catalog/filter-url";
import { discoverBooks, discoverSeries } from "@/modules/catalog/search";
import { BookGrid, SeriesCard } from "@/components/cards";
export const metadata = { title: "Kệ sách minh họa" };
export default async function Catalog({
  searchParams,
}: {
  searchParams: Promise<FilterParams>;
}) {
  const { books, categories, series } = await readCatalog();
  const filters = readCatalogFilters(await searchParams, categories);
  const { q, category, sort } = filters;
  const items = discoverBooks(books, { query: q, category, sort });
  const matchingSeries = discoverSeries(series, q);

  // Category links use the submitted URL state, not unsaved form edits.
  function categoryHref(nextCategory: string) {
    return `/catalog${catalogFilterSuffix({ ...filters, category: nextCategory })}`;
  }

  return (
    <div className="container">
      <div className="page-heading">
        <nav className="breadcrumb" aria-label="Đường dẫn">
          <Link href="/">Trang chủ</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Kệ sách</span>
        </nav>
        <p className="eyebrow">MỖI CÂU CHUYỆN LÀ MỘT CÁNH CỬA</p>
        <h1>Dạo quanh kệ sách</h1>
        <p>
          Tìm một cuốn sách hợp với tâm trạng hôm nay. Toàn bộ tác phẩm, tác giả
          và thông tin ấn bản bên dưới là hư cấu.
        </p>
      </div>
      <div className="page-body">
        <form
          key={`${q}|${category}|${sort}`}
          className="filter-bar"
          action="/catalog"
        >
          <div className="field field-search">
            <label htmlFor="catalog-query">
              Tên sách, tác giả hoặc nội dung
            </label>
            <input
              id="catalog-query"
              name="q"
              type="search"
              aria-describedby="catalog-query-hint"
              defaultValue={q}
              placeholder="Thử tìm ‘khu vuon’…"
            />
          </div>
          <small className="filter-query-hint" id="catalog-query-hint">
            Bạn cũng có thể tìm tên bộ truyện.
          </small>
          <div className="field">
            <label htmlFor="category">Thể loại</label>
            <select id="category" name="category" defaultValue={category}>
              <option value="all">Tất cả thể loại</option>
              {categories.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sort">Sắp xếp</label>
            <select id="sort" name="sort" defaultValue={sort}>
              <option value="default">Tuyển chọn của tiệm</option>
              <option value="title">Tên sách A–Z</option>
              <option value="recent">Năm ấn bản mới nhất</option>
            </select>
          </div>
          <button type="submit" className="button">
            <Search size={16} aria-hidden="true" />
            Tìm & lọc
          </button>
        </form>
        <div className="chip-row">
          {/* Native links reset unsaved controls even when the URL is already current. */}
          <a
            className="chip"
            href={categoryHref("all")}
            aria-current={category === "all"}
          >
            Tất cả
          </a>
          {categories.map((c) => (
            <a
              className="chip"
              href={categoryHref(c.id)}
              aria-current={category === c.id}
              key={c.id}
            >
              {c.label}
            </a>
          ))}
        </div>
        <div className="result-line">
          <span>
            {items.length} sách minh họa{q && ` cho “${q}”`}
          </span>
          <a className="text-link" href="/catalog">
            Xóa bộ lọc
          </a>
        </div>
        {items.length > 0 && (
          <div className="catalog-grid">
            <BookGrid items={items} catalogFilters={filters} />
          </div>
        )}
        {matchingSeries.length > 0 && (
          <section
            className="related-section catalog-series-results"
            aria-labelledby="series-results"
          >
            <h2 id="series-results">Bộ truyện phù hợp</h2>
            <p>
              Tìm theo tên bộ truyện, không áp dụng thể loại hoặc sắp xếp sách.
            </p>
            <div className="series-grid">
              {matchingSeries.map((item) => (
                <SeriesCard key={item.id} item={item} books={books} />
              ))}
            </div>
          </section>
        )}
        {items.length === 0 && (
          <div className="empty-state">
            <Search size={35} aria-hidden="true" />
            <h2>
              {matchingSeries.length > 0
                ? "Không có sách phù hợp"
                : "Chưa tìm thấy câu chuyện này"}
            </h2>
            <p>
              Thử một từ khóa ngắn hơn hoặc bỏ bớt bộ lọc. Bạn có thể tìm tên
              tiếng Việt không dấu.
            </p>
            <Link className="button" href="/catalog">
              Trở lại tất cả sách
              <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
