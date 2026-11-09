import Link from "next/link";
import { readCatalog } from "@/modules/catalog/read-catalog";
import { releases } from "@/modules/editorial/data";
import { ReleaseBadge, releaseLabels } from "@/components/cards";
import { BookCover } from "@/components/book-cover";
export const metadata = { title: "Lịch phát hành minh họa" };
export default async function ReleasesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { books } = await readCatalog();
  const { status } = await searchParams;
  const items = releases.filter(
    (r) =>
      (!status || r.status === status) &&
      books.some((book) => book.id === r.bookId),
  );
  return (
    <div className="container">
      <div className="page-heading">
        <div className="breadcrumb">
          <Link href="/">Trang chủ</Link>
          <span>/</span>
          <span>Lịch phát hành</span>
        </div>
        <p className="eyebrow">NHỮNG CUỘC HẸN VỚI TRANG SÁCH</p>
        <h1>Lịch những câu chuyện mới</h1>
        <p>
          Agenda minh họa năm 2027. Giữ nguyên độ chính xác của ngày, tháng hoặc
          quý; không tự suy ra đã phát hành hay có hàng.
        </p>
      </div>
      <div className="page-body">
        <p className="notice">
          Mọi mốc thời gian và trạng thái dưới đây đều hư cấu. “Ngày xác định”
          chỉ là trạng thái demo, không phải xác nhận phát hành hoặc nhận đặt
          trước.
        </p>
        <div className="chip-row">
          <Link className="chip" href="/releases" aria-current={!status}>
            Tất cả
          </Link>
          {Object.entries(releaseLabels).map(([value, label]) => (
            <Link
              className="chip"
              href={`/releases?status=${value}`}
              aria-current={status === value}
              key={value}
            >
              {label}
            </Link>
          ))}
        </div>
        <div className="release-list">
          {items.map((release) => {
            const book = books.find((b) => b.id === release.bookId)!;
            return (
              <article className="release-row" key={release.id}>
                <Link
                  href={`/products/${book.slug}`}
                  aria-label={`Xem ${book.title}`}
                >
                  <BookCover book={book} />
                </Link>
                <div>
                  <ReleaseBadge status={release.status} />
                  <h2>
                    <Link href={`/products/${book.slug}`}>{book.title}</Link>
                  </h2>
                  <p>{release.note}</p>
                </div>
                <div className="release-date">{release.dateLabel}</div>
              </article>
            );
          })}
        </div>
        {!items.length && (
          <div className="empty-state">
            <h2>Không có lịch trong nhóm này</h2>
            <Link className="text-link" href="/releases">
              Xem tất cả lịch mẫu →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
