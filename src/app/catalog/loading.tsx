export default function Loading() {
  return (
    <div
      className="container section"
      role="status"
      aria-label="Đang mở trang sách"
    >
      <p className="eyebrow">Đang mở một trang mới…</p>
      <div className="skeleton skeleton-title" />
      <div className="book-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div className="skeleton skeleton-card" key={i} />
        ))}
      </div>
    </div>
  );
}
