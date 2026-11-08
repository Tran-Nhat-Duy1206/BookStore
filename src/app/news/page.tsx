import Link from "next/link";
import { articles } from "@/modules/editorial/data";
import { NewsCard } from "@/components/cards";
export const metadata = { title: "Chuyện tiệm sách" };
export default async function NewsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { kind } = await searchParams;
  const items = kind ? articles.filter((a) => a.kind === kind) : articles;
  const kinds = [...new Set(articles.map((a) => a.kind))];
  return (
    <div className="container">
      <div className="page-heading">
        <div className="breadcrumb">
          <Link href="/">Trang chủ</Link>
          <span>/</span>
          <span>Chuyện tiệm sách</span>
        </div>
        <p className="eyebrow">TỪ GÓC BÀN BIÊN TẬP</p>
        <h1>Chuyện sau những trang sách</h1>
        <p>
          Những ghi chép, thông báo và gợi ý đọc trong thế giới hư cấu của tiệm.
          Toàn bộ nội dung bên dưới là minh họa.
        </p>
      </div>
      <div className="page-body">
        {!kind && (
          <aside className="featured-announcement">
            <p className="eyebrow">THÔNG BÁO NỔI BẬT · MINH HỌA</p>
            <h2>
              <Link href="/news/hen-voi-tiem-tra">
                Hẹn với Tiệm trà cuối chân trời
              </Link>
            </h2>
            <p>
              Mốc dự kiến tháng 5 năm 2027 trong lịch hư cấu. Chưa nhận đặt
              trước.
            </p>
            <Link className="text-link" href="/news/hen-voi-tiem-tra">
              Đọc thông báo →
            </Link>
          </aside>
        )}
        <div className="chip-row">
          <Link className="chip" href="/news" aria-current={!kind}>
            Tất cả bài viết
          </Link>
          {kinds.map((k) => (
            <Link
              className="chip"
              href={`/news?kind=${encodeURIComponent(k)}`}
              key={k}
              aria-current={kind === k}
            >
              {k}
            </Link>
          ))}
        </div>
        {items.length ? (
          <div className="news-grid">
            {items.map((article, index) => (
              <NewsCard key={article.id} article={article} index={index} />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <h2>Chưa có bài trong chuyên mục này</h2>
            <Link className="text-link" href="/news">
              Xem tất cả bài viết →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
