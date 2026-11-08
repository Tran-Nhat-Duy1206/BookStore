import Link from "next/link";
import { notFound } from "next/navigation";
import { articles } from "@/modules/editorial/data";
import { books } from "@/modules/catalog/data";
import { BookGrid, SectionHeading } from "@/components/cards";
import { site } from "@/config/site";
export function generateStaticParams() {
  return articles.map((a) => ({ slug: a.slug }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = articles.find((a) => a.slug === slug);
  return {
    title: article?.title || "Không tìm thấy bài viết",
    description: article?.excerpt,
  };
}
export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = articles.find((a) => a.slug === slug);
  if (!article) notFound();
  return (
    <div className="container">
      <div className="page-heading">
        <div className="breadcrumb">
          <Link href="/">Trang chủ</Link>
          <span>/</span>
          <Link href="/news">Chuyện tiệm sách</Link>
          <span>/</span>
          <span>Bài viết minh họa</span>
        </div>
      </div>
      <div className="page-body">
        <article className="article-layout">
          <p className="eyebrow">{article.kind} · NỘI DUNG HƯ CẤU</p>
          <h1>{article.title}</h1>
          <p className="demo-caption">
            Ngày mẫu:{" "}
            <time dateTime={article.date}>
              {new Intl.DateTimeFormat(site.locale, {
                dateStyle: "long",
                timeZone: site.timeZone,
              }).format(new Date(`${article.date}T12:00:00Z`))}
            </time>{" "}
            · Ban biên tập minh họa
          </p>
          <div className="article-art" aria-hidden="true">
            Giấy, mực & những câu chuyện.
          </div>
          <p className="article-excerpt">{article.excerpt}</p>
          <div className="article-body">
            {article.body.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
          <p className="notice">
            Đây không phải thông báo kinh doanh, tin xuất bản thật hoặc đánh giá
            về tác phẩm đang lưu hành.
          </p>
          <Link className="text-link" href="/releases">
            Xem lịch phát hành minh họa →
          </Link>
        </article>
        <section className="related-section">
          <SectionHeading
            kicker="NHỮNG TRANG SÁCH TRONG BÀI"
            title="Ghé thăm câu chuyện"
          />
          <BookGrid
            items={books.filter((b) => article.bookIds.includes(b.id))}
          />
        </section>
      </div>
    </div>
  );
}
