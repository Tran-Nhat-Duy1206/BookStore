import Link from "next/link";
import { notFound } from "next/navigation";
import { books, categories, series } from "@/modules/catalog/data";
import { releases } from "@/modules/editorial/data";
import { BookCover } from "@/components/book-cover";
import { BookTilt } from "@/components/motion";
import { AddToCart, WishlistButton } from "@/components/demo-state";
import { BookGrid, SectionHeading, ReleaseBadge } from "@/components/cards";
export function generateStaticParams() {
  return books.map((b) => ({ slug: b.slug }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const b = books.find((b) => b.slug === slug);
  return { title: b?.title || "Không tìm thấy sách" };
}
export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const book = books.find((b) => b.slug === slug);
  if (!book) notFound();
  const collection = series.find((s) => s.id === book.seriesId);
  const release = releases.find((r) => r.bookId === book.id);
  const related = books.filter(
    (b) =>
      b.id !== book.id &&
      (collection
        ? collection.bookIds.includes(b.id)
        : b.category === book.category),
  );
  return (
    <div className="container">
      <div className="page-heading">
        <div className="breadcrumb">
          <Link href="/">Trang chủ</Link>
          <span>/</span>
          <Link href="/catalog">Kệ sách</Link>
          <span>/</span>
          <span>{book.title}</span>
        </div>
      </div>
      <div className="page-body">
        <div className="product-layout">
          <div className="product-cover-stage">
            <BookTilt>
              <BookCover book={book} />
            </BookTilt>
          </div>
          <div>
            <p className="eyebrow">
              {categories.find((c) => c.id === book.category)?.label} · TÁC PHẨM
              HƯ CẤU
            </p>
            <h1>{book.title}</h1>
            <p className="product-description">{book.description}</p>
            <dl className="metadata-grid">
              <div>
                <dt>Tác giả hư cấu</dt>
                <dd>{book.author}</dd>
              </div>
              <div>
                <dt>Tập / nội dung</dt>
                <dd>{book.volume}</dd>
              </div>
              <div>
                <dt>Ấn bản minh họa</dt>
                <dd>{book.edition}</dd>
              </div>
              <div>
                <dt>Ngôn ngữ</dt>
                <dd>{book.language}</dd>
              </div>
              <div>
                <dt>Năm trong dữ liệu mẫu</dt>
                <dd>{book.year}</dd>
              </div>
              <div>
                <dt>Thông tin thương mại</dt>
                <dd>Chưa mở bán · Không tồn kho thật</dd>
              </div>
            </dl>
            <p className="notice">
              Sách và bìa được sáng tác cho bản trình diễn. Không có giá bán,
              ISBN, nhà xuất bản hoặc khả năng cung ứng được xác nhận.
            </p>
            <div className="product-actions">
              <AddToCart id={book.id} />
              <WishlistButton id={book.id} label={book.title} full />
            </div>
            {collection && (
              <p>
                <Link className="text-link" href={`/series/${collection.slug}`}>
                  Xem các tập và ấn bản của {collection.title} →
                </Link>
              </p>
            )}
            {release && (
              <div>
                <ReleaseBadge status={release.status} />
                <p className="demo-caption">{release.dateLabel}</p>
                <Link className="text-link" href="/releases">
                  Đọc ghi chú lịch phát hành mẫu →
                </Link>
              </div>
            )}
          </div>
        </div>
        <section className="related-section">
          <SectionHeading
            kicker="ĐỌC TIẾP MỘT CHÚT NỮA"
            title={
              collection ? "Trong cùng bộ truyện" : "Một vài câu chuyện gần bên"
            }
            href="/catalog"
          />
          <BookGrid
            items={(related.length
              ? related
              : books.filter((b) => b.id !== book.id)
            ).slice(0, 4)}
          />
        </section>
      </div>
    </div>
  );
}
