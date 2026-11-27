import Link from "next/link";
import { notFound } from "next/navigation";
import { readCatalog } from "@/modules/catalog/read-catalog";
import { BookGrid } from "@/components/cards";
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { series } = await readCatalog();
  const { slug } = await params;
  return {
    title:
      series.find((s) => s.slug === slug)?.title || "Không tìm thấy bộ truyện",
  };
}
export default async function SeriesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { books, series } = await readCatalog();
  const { slug } = await params;
  const item = series.find((s) => s.slug === slug);
  if (!item) notFound();
  const items = [...new Set(item.bookIds)]
    .map((id) => books.find((book) => book.id === id))
    .filter((book) => book !== undefined);
  return (
    <div className="container">
      <div className="page-heading">
        <div className="breadcrumb">
          <Link href="/">Trang chủ</Link>
          <span>/</span>
          <Link href="/catalog">Kệ sách</Link>
          <span>/</span>
          <span>Bộ truyện</span>
        </div>
        <p className="eyebrow">Ở LẠI CÙNG NHỮNG NHÂN VẬT QUEN</p>
        <h1>{item.title}</h1>
        <p>{item.description}</p>
      </div>
      <div className="page-body">
        <p className="notice">
          Bộ truyện, tập và ấn bản là minh họa hư cấu. Bản hợp tuyển có thể gộp
          nhiều tập; không phải một tập mới trong thứ tự đọc.
        </p>
        {items.length > 0 ? (
          <BookGrid items={items} />
        ) : (
          <div className="empty-state">
            <h2>Chưa có sách công khai trong bộ truyện này</h2>
            <p>Bạn vẫn có thể khám phá những bộ truyện khác.</p>
            <Link href="/series" className="button">
              Xem tất cả bộ truyện
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
