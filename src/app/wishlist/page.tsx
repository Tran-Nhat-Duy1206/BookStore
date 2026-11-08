import { DemoCollection } from "@/components/demo-state";
export const metadata = { title: "Sách yêu thích" };
export default function WishlistPage() {
  return (
    <div className="container">
      <div className="page-heading">
        <p className="eyebrow">GÓC NHỎ CỦA RIÊNG BẠN</p>
        <h1>Những cuốn sách muốn giữ lại</h1>
        <p>Danh sách yêu thích minh họa, không cần tài khoản.</p>
      </div>
      <div className="page-body">
        <DemoCollection mode="wishlist" />
      </div>
    </div>
  );
}
