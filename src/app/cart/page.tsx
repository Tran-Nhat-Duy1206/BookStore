import { DemoCollection } from "@/components/demo-state";
export const metadata = { title: "Giỏ thử nghiệm" };
export default function CartPage() {
  return (
    <div className="container">
      <div className="page-heading">
        <p className="eyebrow">CHỈ ĐỂ KHÁM PHÁ TRẢI NGHIỆM</p>
        <h1>Giỏ sách thử nghiệm</h1>
        <p>Không có checkout, giá bán, thanh toán hoặc xác nhận đơn hàng.</p>
      </div>
      <div className="page-body">
        <DemoCollection mode="cart" />
      </div>
    </div>
  );
}
