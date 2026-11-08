import Link from "next/link";
export default function NotFound() {
  return (
    <div className="container section">
      <div className="empty-state">
        <p className="eyebrow">404 · MỘT TRANG CHƯA ĐƯỢC VIẾT</p>
        <h1>Có lẽ bạn vừa rẽ sang một lối nhỏ</h1>
        <p>
          Không tìm thấy sách hoặc bài viết này. Hãy trở về kệ sách để tiếp tục
          khám phá.
        </p>
        <Link href="/catalog" className="button">
          Trở lại kệ sách
        </Link>
      </div>
    </div>
  );
}
