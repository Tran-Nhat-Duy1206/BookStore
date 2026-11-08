/** Bài viết, nhân vật và lịch phát hành đều là nội dung hư cấu để trình diễn. */
export type Article = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body: string[];
  kind: string;
  date: string;
  bookIds: string[];
  featured?: boolean;
};

export const articles: Article[] = [
  {
    id: "mot-khu-vuon-de-tro-ve",
    slug: "mot-khu-vuon-de-tro-ve",
    title: "Ai cũng cần một khu vườn để trở về",
    excerpt:
      "Có những trang sách không đưa ta đi thật xa, mà nhẹ nhàng dẫn ta về gần chính mình.",
    body: [
      "Trong thế giới hư cấu của Khu vườn sau cơn mưa, Miên trở về căn nhà cũ với một chiếc va-li và rất nhiều điều chưa kịp nói. Khu vườn không trả lời thay cô; nó chỉ kiên nhẫn chờ mỗi buổi sáng.",
      "Chúng tôi hình dung cuốn sách như một khoảng hiên có nắng: đủ yên tĩnh để người đọc nghe thấy một hạt mầm đang lớn. Những chi tiết về đất, mưa và chiếc bình tưới cũ tạo nên nhịp điệu chậm rãi của câu chuyện.",
      "Đây là bài giới thiệu minh họa cho một tác phẩm và tác giả hoàn toàn hư cấu. Mọi thông tin xuất bản trong bản trình diễn đều không phải thông báo thương mại hay lịch phát hành thật.",
    ],
    kind: "Chuyện sau trang sách",
    date: "2027-01-12",
    bookIds: ["khu-vuon-sau-con-mua", "nhung-la-thu-gui-mua-thu"],
    featured: true,
  },
  {
    id: "doc-cham-trong-mot-chieu-mua",
    slug: "doc-cham-trong-mot-chieu-mua",
    title: "Đọc chậm trong một chiều mưa",
    excerpt:
      "Một tách trà ấm, một chỗ ngồi quen và ba gợi ý hư cấu cho buổi chiều không cần vội.",
    body: [
      "Không phải cuốn sách nào cũng cần được đọc hết trong một lần. Đôi khi, một đoạn ngắn đủ làm thay đổi cách ta nhìn giọt nước đọng trên bậu cửa.",
      "Một ngày đi thật chậm mở ra bằng những điều bé nhỏ, còn Mùa đi qua hiên lưu giữ cảm giác của những ngày không có sự kiện đặc biệt. Nếu muốn rời đời thường một chút, hãy tưởng tượng ghé Tiệm trà cuối chân trời.",
      "Các gợi ý trong bài đều là tác phẩm hư cấu được tạo riêng cho giao diện minh họa. Hãy xem đây như một góc đọc thử ý tưởng, không phải nhận xét về sách đang lưu hành.",
    ],
    kind: "Góc đọc chậm",
    date: "2027-02-05",
    bookIds: [
      "mot-ngay-di-that-cham",
      "mua-di-qua-hien",
      "tiem-tra-cuoi-chan-troi",
    ],
  },
  {
    id: "mot-bia-sach-tu-nhung-hinh-nho",
    slug: "mot-bia-sach-tu-nhung-hinh-nho",
    title: "Một bìa sách bắt đầu từ những hình nhỏ",
    excerpt:
      "Vầng trăng, nhành lá và những đường sóng: ngôn ngữ hình học cho một tủ sách tưởng tượng.",
    body: [
      "Bộ bìa minh họa của bản trình diễn được xây dựng từ hình học đơn giản: một vầng trăng, một dãy núi, vài nhành lá. Không sử dụng tranh bìa sách có sẵn hay hình ảnh của tác phẩm thương mại.",
      "Màu xanh rừng dành cho cảm giác trở về, màu đất gợi sự ấm áp, còn xanh đêm mở ra những chuyến đi tưởng tượng. Các mô-típ chỉ gợi không khí, để người đọc tự hoàn thiện thế giới còn lại.",
      "Đây là ghi chép biên tập hư cấu về hệ minh họa nguyên bản của giao diện, không phải thông tin sản xuất một ấn bản thật.",
    ],
    kind: "Xưởng giấy & mực",
    date: "2027-02-18",
    bookIds: ["dem-trang-tren-mai-nha", "ban-do-cua-gio", "bien-o-phia-trong"],
  },
  {
    id: "doc-mot-bo-truyen-theo-cach-rieng",
    slug: "doc-mot-bo-truyen-theo-cach-rieng",
    title: "Đi qua Lũng Mây, từng mùa một",
    excerpt:
      "Đọc từng tập hay ghé lại bằng một bản hợp tuyển? Một chỉ dẫn nhỏ cho bộ truyện hư cấu.",
    body: [
      "Những mùa ở Lũng Mây gồm hai câu chuyện nối tiếp: Khu vườn sau cơn mưa và Những lá thư gửi mùa thu. Mỗi tập có một điểm dừng riêng, nhưng những nhân vật quen sẽ còn gặp lại nhau.",
      "Bản hợp tuyển minh họa gộp nội dung hai tập trong một quyển. Đây chỉ là cách mô phỏng mối liên hệ giữa sách, bộ truyện và ấn bản; không có giao dịch hay cam kết xuất bản đi kèm.",
      "Toàn bộ tên sách, tác giả và thông tin ấn bản trong bài đều là hư cấu dành riêng cho bản trình diễn.",
    ],
    kind: "Dẫn lối đọc",
    date: "2027-03-02",
    bookIds: [
      "khu-vuon-sau-con-mua",
      "nhung-la-thu-gui-mua-thu",
      "nhung-mua-o-lung-may-hop-tuyen",
    ],
  },
  {
    id: "hen-voi-tiem-tra",
    slug: "hen-voi-tiem-tra",
    title: "Hẹn với Tiệm trà cuối chân trời",
    excerpt:
      "Thông báo sách sắp phát hành trong lịch hư cấu: dự kiến tháng 5 năm 2027, chưa nhận đặt trước.",
    body: [
      "Trong lịch trình diễn hư cấu, Tiệm trà cuối chân trời có mốc dự kiến tháng 5 năm 2027. Thông tin chỉ minh họa cách tiệm liên kết một thông báo với ấn bản và release calendar.",
      "Ngày phát hành chưa đồng nghĩa ngày có hàng. Không có nhà xuất bản, đơn đặt trước, thanh toán hoặc cam kết cung ứng thật.",
      "Xem lịch phát hành mẫu để phân biệt ngày xác định, dự kiến và tình trạng hoãn.",
    ],
    kind: "Thông báo phát hành",
    date: "2027-03-15",
    bookIds: ["tiem-tra-cuoi-chan-troi"],
    featured: true,
  },
  {
    id: "trang-moi-tren-ke-mau",
    slug: "trang-moi-tren-ke-mau",
    title: "Một vài trang mới trên kệ tưởng tượng",
    excerpt:
      "Thông báo hàng mới dạng minh họa: thêm Bản đồ của gió và Biển ở phía trong vào catalog hư cấu.",
    body: [
      "Catalog trình diễn vừa có thêm hai câu chuyện để bạn khám phá giao diện. Đây là new-arrival notice hư cấu, không phải biên nhận hàng vào kho.",
      "Các bìa hình học được thiết kế riêng cho dự án. Không có tồn kho hoặc giá bán thật; bạn chỉ có thể lưu yêu thích và dùng giỏ thử nghiệm.",
    ],
    kind: "Mới trên kệ · mẫu",
    date: "2027-03-18",
    bookIds: ["ban-do-cua-gio", "bien-o-phia-trong"],
  },
];

export type Release = {
  id: string;
  bookId: string;
  status: "confirmed" | "tentative" | "postponed" | "unknown";
  dateLabel: string;
  note: string;
};

export const releases: Release[] = [
  {
    id: "lich-khu-vuon",
    bookId: "khu-vuon-sau-con-mua",
    status: "confirmed",
    dateLabel: "15 tháng 4, 2027 · lịch minh họa",
    note: "Trạng thái đã xác nhận chỉ để trình diễn giao diện; không phải lịch phát hành thật hay cam kết cung ứng.",
  },
  {
    id: "lich-tiem-tra",
    bookId: "tiem-tra-cuoi-chan-troi",
    status: "tentative",
    dateLabel: "Tháng 5, 2027 · dự kiến minh họa",
    note: "Mốc thời gian hư cấu dùng để minh họa trạng thái dự kiến; chưa có hoạt động xuất bản thực tế.",
  },
  {
    id: "lich-la-thu",
    bookId: "nhung-la-thu-gui-mua-thu",
    status: "postponed",
    dateLabel: "Dời mốc tháng 6, 2027 · minh họa",
    note: "Tình huống hoãn hư cấu trong dữ liệu trình diễn; chưa đặt mốc thay thế và không liên quan lịch phát hành thật.",
  },
  {
    id: "lich-vi-sao",
    bookId: "nguoi-giu-nhung-vi-sao",
    status: "unknown",
    dateLabel: "Chưa có ngày trong năm 2027 · minh họa",
    note: "Dữ liệu hư cấu minh họa trường hợp chưa công bố ngày; không suy ra sách đã hoặc sắp phát hành.",
  },
  {
    id: "lich-hop-tuyen",
    bookId: "nhung-mua-o-lung-may-hop-tuyen",
    status: "tentative",
    dateLabel: "Quý IV, 2027 · dự kiến minh họa",
    note: "Bản hợp tuyển và thời gian đều là ý tưởng trình diễn, không phải thông báo xuất bản hoặc nhận đặt trước.",
  },
];
