"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="container section">
      <div className="empty-state" role="alert">
        <h1>Trang sách cần một chút thời gian</h1>
        <p>
          Không thể mở nội dung lúc này. Bạn có thể thử lại; không có đơn hàng
          hay thanh toán nào được tạo.
        </p>
        <button className="button" onClick={reset}>
          Thử mở lại
        </button>
      </div>
    </div>
  );
}
