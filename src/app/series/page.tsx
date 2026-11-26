import Link from "next/link";
import { SeriesCard } from "@/components/cards";
import { readCatalog } from "@/modules/catalog/read-catalog";

export const metadata = { title: "Bộ truyện minh họa" };

export default async function SeriesIndex() {
  const { books, series } = await readCatalog();

  return (
    <div className="container">
      <div className="page-heading">
        <nav className="breadcrumb" aria-label="Đường dẫn">
          <Link href="/">Trang chủ</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Bộ truyện</span>
        </nav>
        <h1>Tất cả bộ truyện</h1>
        <p>Khám phá các tập và ấn bản trong từng bộ truyện minh họa.</p>
      </div>
      <div className="page-body">
        {series.length > 0 ? (
          <section aria-labelledby="series-list">
            <h2 id="series-list">Bộ truyện trên kệ</h2>
            <div className="series-grid">
              {series.map((item) => (
                <SeriesCard key={item.id} item={item} books={books} />
              ))}
            </div>
          </section>
        ) : (
          <div className="empty-state">
            <h2>Chưa có bộ truyện</h2>
            <p>Bạn vẫn có thể khám phá các tác phẩm minh họa trên kệ sách.</p>
            <Link className="button" href="/catalog">
              Xem kệ sách
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
