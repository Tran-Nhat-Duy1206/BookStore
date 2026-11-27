import Link from "next/link";
import { notFound } from "next/navigation";
import { readCatalog } from "@/modules/catalog/read-catalog";
import {
  catalogFilterSuffix,
  readCatalogFilters,
  type FilterParams,
} from "@/modules/catalog/filter-url";
import { releases } from "@/modules/editorial/data";
import { BookCover } from "@/components/book-cover";
import { BookTilt } from "@/components/motion";
import { AddToCart, WishlistButton } from "@/components/demo-state";
import { BookGrid, SectionHeading, ReleaseBadge } from "@/components/cards";
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { books } = await readCatalog();
  const { slug } = await params;
  const b = books.find((b) => b.slug === slug);
  return { title: b?.title || "Không tìm thấy sách" };
}
export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<FilterParams>;
}) {
  const { books, categories, series } = await readCatalog();
  const { slug } = await params;
  const book = books.find((b) => b.slug === slug);
  if (!book) notFound();
  const catalogSuffix = catalogFilterSuffix(
    readCatalogFilters(await searchParams, categories),
  );
  const genre = categories.find(({ id }) => id === book.category);
  const collection = series.find((s) => s.id === book.seriesId);
  // Match /compare's path-segment rules as well as public series membership.
  const canCompareSlug = (value: string) =>
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[/?#\\\s\u0000-\u001f\u007f]/u.test(value);
  const publicSeries = series.filter((item) => item.bookIds.includes(book.id));
  const comparisonBooks = canCompareSlug(book.slug)
    ? books.filter(
        (candidate) =>
          candidate.id !== book.id &&
          candidate.slug !== book.slug &&
          canCompareSlug(candidate.slug) &&
          publicSeries.some((item) => item.bookIds.includes(candidate.id)),
      )
    : [];
  const release = releases.find((r) => r.bookId === book.id);
  const seenIds = new Set([book.id]);
  const seenSlugs = new Set([book.slug]);
  const alternatives = books.filter((candidate) => {
    if (
      !canCompareSlug(candidate.slug) ||
      seenIds.has(candidate.id) ||
      seenSlugs.has(candidate.slug)
    )
      return false;
    seenIds.add(candidate.id);
    seenSlugs.add(candidate.slug);
    return true;
  });
  const sameSeries = alternatives.filter((candidate) =>
    publicSeries.some((item) => item.bookIds.includes(candidate.id)),
  );
  const sameGenre = alternatives.filter(
    (candidate) => candidate.category === book.category,
  );
  const related = (
    sameSeries.length ? sameSeries : sameGenre.length ? sameGenre : alternatives
  ).slice(0, 4);
  return (
    <div className="container">
      <div className="page-heading">
        <nav className="breadcrumb" aria-label="Đường dẫn">
          <Link href="/">Trang chủ</Link>
          <span aria-hidden="true">/</span>
          {catalogSuffix ? (
            <Link href={`/catalog${catalogSuffix}`}>Trở lại kết quả</Link>
          ) : (
            <Link href="/catalog">Kệ sách</Link>
          )}
          <span aria-hidden="true">/</span>
          <span aria-current="page">{book.title}</span>
        </nav>
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
              {genre && `${genre.label} · `}TÁC PHẨM HƯ CẤU
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
            {genre && genre.id !== "all" && (
              <p>
                <Link
                  className="text-link"
                  href={`/catalog${catalogFilterSuffix({ q: "", category: genre.id, sort: "default" })}`}
                >
                  Xem thêm sách thuộc thể loại {genre.label}{" "}
                  <span aria-hidden="true">→</span>
                </Link>
              </p>
            )}
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
            {comparisonBooks.length > 0 && (
              <form action="/compare" method="get" className="notice">
                <input type="hidden" name="book" value={book.slug} />
                <div className="field">
                  <label htmlFor="compare-with">
                    Chọn sách cùng bộ để so sánh
                  </label>
                  <select
                    id="compare-with"
                    name="with"
                    defaultValue=""
                    required
                  >
                    <option value="" disabled>
                      Chọn một cuốn sách
                    </option>
                    {comparisonBooks.map((candidate) => (
                      <option key={candidate.id} value={candidate.slug}>
                        {candidate.title}
                      </option>
                    ))}
                  </select>
                </div>
                <p>
                  <button className="button button-secondary" type="submit">
                    So sánh sách
                  </button>
                </p>
              </form>
            )}
          </div>
        </div>
        {related.length > 0 && (
          <section className="related-section">
            <SectionHeading
              kicker="ĐỌC TIẾP MỘT CHÚT NỮA"
              title={
                sameSeries.length
                  ? "Trong cùng bộ truyện"
                  : "Có thể bạn sẽ thích"
              }
              href="/catalog"
            />
            <BookGrid items={related} />
          </section>
        )}
      </div>
    </div>
  );
}
