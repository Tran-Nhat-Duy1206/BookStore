import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Flower2,
  Feather,
  BookOpen,
  Sparkles,
  Coffee,
  Orbit,
} from "lucide-react";
import { readCatalog } from "@/modules/catalog/read-catalog";
import { articles, releases } from "@/modules/editorial/data";
import { BookCover } from "@/components/book-cover";
import {
  BookGrid,
  SectionHeading,
  SeriesCard,
  NewsCard,
  ReleaseBadge,
} from "@/components/cards";
import { AmbientArt, BookTilt, Reveal } from "@/components/motion";
const categoryIcons = [Feather, Sparkles, Coffee, BookOpen, Orbit, Flower2];
export default async function Home() {
  const { books, categories, series } = await readCatalog();
  return (
    <>
      <section className="hero container">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="tiny-rule" />
            CHÀO BẠN, NGƯỜI YÊU SÁCH
          </p>
          <h1>
            Có một thế giới
            <br />
            đang chờ <em>bạn mở.</em>
          </h1>
          <p className="hero-description">
            Tạm gác những vội vàng. Ghé một góc nhỏ, tìm một cuốn sách — và để
            những câu chuyện dẫn lối.
          </p>
          <div className="hero-actions">
            <Link className="button" href="/catalog">
              Dạo quanh kệ sách
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <Link className="text-link" href="/news">
              Chuyện của tiệm
              <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
          </div>
          <div className="hero-footnote">
            <Flower2 size={22} strokeWidth={1.2} aria-hidden="true" />
            <span>
              Một không gian đang được vun trồng.
              <br />
              <strong>Thương hiệu tạm · Sách minh họa · Chưa mở bán</strong>
            </span>
          </div>
        </div>
        <AmbientArt>
          <div className="hero-arch" />
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <span className="hero-star star-one" aria-hidden="true">
            ✳
          </span>
          <span className="hero-star star-two" aria-hidden="true">
            ✧
          </span>
          <div className="hero-book hero-book-back">
            <BookTilt>{books[1] && <BookCover book={books[1]} />}</BookTilt>
          </div>
          <div className="hero-book hero-book-front">
            <BookTilt>{books[0] && <BookCover book={books[0]} />}</BookTilt>
          </div>
          <div className="hero-shelf" />
          <div className="hero-sticker">
            <span>mỗi trang sách</span>
            <em>một khởi đầu</em>
            <BookOpen size={23} strokeWidth={1.2} aria-hidden="true" />
          </div>
          <span className="hero-art-caption">
            BÌA MINH HỌA NGUYÊN BẢN — BỘ SƯU TẬP HƯ CẤU
          </span>
        </AmbientArt>
      </section>
      <div className="values-strip">
        <div className="container">
          <span>
            <BookOpen size={17} aria-hidden="true" /> Những câu chuyện được
            tuyển chọn
          </span>
          <span>
            <Feather size={17} aria-hidden="true" /> Không gian cho người đọc
            chậm
          </span>
          <span>
            <Flower2 size={17} aria-hidden="true" /> Một khởi đầu, từ tình yêu
            sách
          </span>
        </div>
      </div>
      <section className="section container">
        <SectionHeading
          kicker="BẠN MUỐN ĐI ĐÂU HÔM NAY?"
          title="Mỗi kệ sách, một lối nhỏ"
        />
        <div className="category-grid">
          {categories.map((category, index) => {
            const Icon = categoryIcons[index % categoryIcons.length];
            return (
              <Link
                href={`/catalog?category=${category.id}`}
                className="category-card"
                key={category.id}
              >
                <Icon size={27} strokeWidth={1.3} aria-hidden="true" />
                <span>{category.label}</span>
                <ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            );
          })}
        </div>
      </section>
      <section className="section container featured-section">
        <SectionHeading
          kicker="ĐẶT MỘT CHÚT BÌNH YÊN LÊN KỆ"
          title="Một cuốn sách dành cho bạn"
          href="/catalog"
          linkText="Xem cả kệ sách"
        />
        <BookGrid
          items={[books[0], books[1], books[7], books[4]].filter(Boolean)}
        />
      </section>
      <section className="reading-note">
        <Reveal className="container reading-note-inner">
          <span className="reading-note-number">01 / GÓC ĐỌC CHẬM</span>
          <div>
            <p className="eyebrow">KHÔNG CẦN ĐI XA ĐỂ TÌM MỘT THẾ GIỚI KHÁC</p>
            <h2>
              Đôi khi, một cuộc phiêu lưu
              <br />
              bắt đầu từ <em>chiếc ghế quen.</em>
            </h2>
            <Link
              className="text-link"
              href="/news/doc-cham-trong-mot-chieu-mua"
            >
              Tìm cảm hứng cho buổi đọc tới
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
          <Coffee
            className="reading-note-icon"
            size={110}
            strokeWidth={0.6}
            aria-hidden="true"
          />
        </Reveal>
      </section>
      <section className="section container">
        <SectionHeading
          kicker="NHỮNG CÂU CHUYỆN CÒN TIẾP"
          title="Ở lại cùng một bộ truyện"
          href="/catalog"
        />
        <div className="series-grid">
          {series.map((item) => (
            <SeriesCard item={item} books={books} key={item.id} />
          ))}
        </div>
      </section>
      <section className="section container release-section">
        <SectionHeading
          kicker="HẸN BẠN Ở MỘT TRANG SÁCH MỚI"
          title="Sắp ghé lên kệ"
          href="/releases"
          linkText="Xem lịch minh họa"
        />
        <p className="section-description">
          Lịch hư cấu năm 2027 để khám phá giao diện. Không phải thông báo phát
          hành hoặc nhận đặt trước.
        </p>
        <div className="home-releases">
          {releases.slice(0, 3).map((release) => {
            const book = books.find((b) => b.id === release.bookId);
            if (!book) return null;
            return (
              <Link
                href={`/products/${book.slug}`}
                className="release-preview"
                key={release.id}
              >
                <span className="release-preview-date">
                  {release.dateLabel}
                </span>
                <h3>{book.title}</h3>
                <ReleaseBadge status={release.status} />
                <ArrowUpRight size={18} aria-hidden="true" />
              </Link>
            );
          })}
        </div>
      </section>
      <section className="section container">
        <SectionHeading
          kicker="TỪ GÓC BÀN BIÊN TẬP"
          title="Chuyện sau những trang sách"
          href="/news"
          linkText="Đọc tất cả"
        />
        <div className="news-grid">
          {[...articles]
            .reverse()
            .slice(0, 3)
            .map((article, index) => (
              <NewsCard article={article} index={index} key={article.id} />
            ))}
        </div>
      </section>
      <section className="closing-note container">
        <Flower2 size={35} strokeWidth={1} aria-hidden="true" />
        <h2>
          Cuốn sách tiếp theo của bạn
          <br />
          có thể đang ở ngay đây.
        </h2>
        <Link href="/catalog?sort=recent" className="button button-secondary">
          Khám phá tuyển chọn mới
          <ArrowRight size={17} aria-hidden="true" />
        </Link>
      </section>
    </>
  );
}
