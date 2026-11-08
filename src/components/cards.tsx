import Link from "next/link";
import { ArrowUpRight, ArrowRight } from "lucide-react";
import { books, type Book, type Series } from "@/modules/catalog/data";
import type { Article, Release } from "@/modules/editorial/data";
import { BookCover } from "./book-cover";
import { BookTilt, Reveal } from "./motion";
import { WishlistButton } from "./demo-state";

export function BookCard({ book, index = 0 }: { book: Book; index?: number }) {
  return (
    <Reveal delay={(index % 5) * 0.04} className="book-card">
      <div className="book-stage">
        <Link
          href={`/products/${book.slug}`}
          className="cover-link"
          aria-label={`Xem ${book.title}`}
        >
          <BookTilt>
            <BookCover book={book} />
          </BookTilt>
        </Link>
        <WishlistButton id={book.id} label={book.title} />
        <span className="book-card-label">{book.eyebrow}</span>
      </div>
      <div className="book-info">
        <p className="eyebrow">{book.edition}</p>
        <h3>
          <Link href={`/products/${book.slug}`}>{book.title}</Link>
        </h3>
        <p>{book.author}</p>
        <span className="demo-caption">Sách minh họa · Chưa mở bán</span>
      </div>
    </Reveal>
  );
}
export function BookGrid({ items }: { items: Book[] }) {
  return (
    <div className="book-grid">
      {items.map((book, index) => (
        <BookCard key={book.id} book={book} index={index} />
      ))}
    </div>
  );
}
export function SectionHeading({
  kicker,
  title,
  href,
  linkText = "Khám phá thêm",
}: {
  kicker: string;
  title: string;
  href?: string;
  linkText?: string;
}) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{kicker}</p>
        <h2>{title}</h2>
      </div>
      {href && (
        <Link className="text-link" href={href}>
          {linkText}
          <ArrowRight size={17} aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}
export function SeriesCard({ item }: { item: Series }) {
  const volumes = books.filter((b) => item.bookIds.includes(b.id));
  return (
    <Link className="series-card" href={`/series/${item.slug}`}>
      <div className="series-covers" aria-hidden="true">
        {volumes.slice(0, 3).map((b) => (
          <BookCover key={b.id} book={b} />
        ))}
      </div>
      <div>
        <p className="eyebrow">Bộ truyện minh họa · {volumes.length} ấn bản</p>
        <h3>{item.title}</h3>
        <p>{item.description}</p>
        <span className="text-link">
          Ghé thăm bộ truyện <ArrowUpRight size={17} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}
export function NewsCard({
  article,
  index = 0,
}: {
  article: Article;
  index?: number;
}) {
  return (
    <Reveal delay={index * 0.04}>
      <article className="news-card">
        <Link
          className={`news-visual news-visual-${index % 3}`}
          href={`/news/${article.slug}`}
          aria-label={`Đọc ${article.title}`}
        >
          <span className="news-ornament" aria-hidden="true">
            {index % 3 === 0 ? "Aa" : index % 3 === 1 ? "01—12" : "M&M"}
          </span>
          <span>{article.kind}</span>
          <ArrowUpRight aria-hidden="true" />
        </Link>
        <p className="eyebrow">{article.kind} · Bài minh họa</p>
        <h3>
          <Link href={`/news/${article.slug}`}>{article.title}</Link>
        </h3>
        <p>{article.excerpt}</p>
      </article>
    </Reveal>
  );
}
export const releaseLabels: Record<Release["status"], string> = {
  confirmed: "Ngày xác định · mẫu",
  tentative: "Dự kiến",
  postponed: "Đã hoãn",
  unknown: "Chưa rõ ngày",
};
export function ReleaseBadge({ status }: { status: Release["status"] }) {
  return (
    <span className={`release-badge status-${status}`}>
      {releaseLabels[status]}
    </span>
  );
}
