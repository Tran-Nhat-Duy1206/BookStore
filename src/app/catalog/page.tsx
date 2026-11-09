import Link from "next/link";
import { Search, ArrowRight } from "lucide-react";
import { readCatalog } from "@/modules/catalog/read-catalog";
import { discoverBooks } from "@/modules/catalog/search";
import { BookGrid } from "@/components/cards";
export const metadata = { title: "Kệ sách minh họa" };
type Params = Record<string, string | string[] | undefined>;
export default async function Catalog({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const { books, categories } = await readCatalog();
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const requestedCategory =
    typeof params.category === "string" ? params.category.trim() : "all";
  const category = categories.some((item) => item.id === requestedCategory)
    ? requestedCategory
    : "all";
  const requestedSort =
    typeof params.sort === "string" ? params.sort.trim() : "default";
  const sort = ["default", "title", "recent"].includes(requestedSort)
    ? requestedSort
    : "default";
  const items = discoverBooks(books, { query: q, category, sort });
  return (
    <div className="container">
      <div className="page-heading">
        <div className="breadcrumb">
          <Link href="/">Trang chủ</Link>
          <span>/</span>
          <span>Kệ sách</span>
        </div>
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
              defaultValue={q}
              placeholder="Thử tìm ‘khu vuon’…"
            />
          </div>
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
          <Link
            className="chip"
            href="/catalog"
            aria-current={category === "all"}
          >
            Tất cả
          </Link>
          {categories.map((c) => (
            <Link
              className="chip"
              href={`/catalog?category=${c.id}`}
              aria-current={category === c.id}
              key={c.id}
            >
              {c.label}
            </Link>
          ))}
        </div>
        <div className="result-line">
          <span>
            {items.length} sách minh họa{q && ` cho “${q}”`}
          </span>
          <Link className="text-link" href="/catalog">
            Xóa bộ lọc
          </Link>
        </div>
        {items.length ? (
          <div className="catalog-grid">
            <BookGrid items={items} />
          </div>
        ) : (
          <div className="empty-state">
            <Search size={35} aria-hidden="true" />
            <h2>Chưa tìm thấy câu chuyện này</h2>
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
