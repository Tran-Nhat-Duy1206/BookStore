import Link from "next/link";
import { notFound } from "next/navigation";
import { books, series } from "@/modules/catalog/data";
import { BookGrid } from "@/components/cards";
export function generateStaticParams() {
  return series.map((s) => ({ slug: s.slug }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
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
  const { slug } = await params;
  const item = series.find((s) => s.slug === slug);
  if (!item) notFound();
  const items = item.bookIds
    .map((id) => books.find((b) => b.id === id)!)
    .filter(Boolean);
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
        <BookGrid items={items} />
      </div>
    </div>
  );
}
