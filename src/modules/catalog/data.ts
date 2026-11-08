/** Dữ liệu minh họa tự sáng tác; mọi tác phẩm và tác giả đều hư cấu. */
export type Category = {
  id: string;
  label: string;
  description: string;
};

export const categories: Category[] = [
  {
    id: "van-hoc",
    label: "Văn học",
    description: "Những câu chuyện hư cấu, chậm rãi và giàu rung cảm.",
  },
  {
    id: "light-novel",
    label: "Light novel",
    description:
      "Tiểu thuyết nhẹ hư cấu với những thế giới kỳ ảo và chuyến đi dịu dàng.",
  },
  {
    id: "tan-van",
    label: "Tản văn",
    description: "Nhặt nhạnh những khoảng lặng và vẻ đẹp của đời thường.",
  },
  {
    id: "manga",
    label: "Manga",
    description:
      "Truyện tranh hư cấu theo tinh thần manga, với nhân vật và hình ảnh nguyên bản.",
  },
  {
    id: "manhwa",
    label: "Manhwa",
    description:
      "Những câu chuyện hư cấu lấy cảm hứng từ nhịp kể truyện tranh Hàn Quốc.",
  },
  {
    id: "manhua",
    label: "Manhua",
    description:
      "Truyện tranh hư cấu lấy cảm hứng từ lối kể manhua, không phỏng theo tác phẩm có sẵn.",
  },
];

export type Book = {
  id: string;
  slug: string;
  title: string;
  author: string;
  category: string;
  seriesId?: string;
  volume: string;
  edition: string;
  language: string;
  description: string;
  year: number;
  color: "forest" | "clay" | "navy" | "gold" | "plum" | "sage";
  motif: "moon" | "mountain" | "botanical" | "stars" | "waves" | "sun";
  eyebrow: string;
};

export const books: Book[] = [
  {
    id: "khu-vuon-sau-con-mua",
    slug: "khu-vuon-sau-con-mua",
    title: "Khu vườn sau cơn mưa",
    author: "An Nhiên",
    category: "van-hoc",
    seriesId: "nhung-mua-o-lung-may",
    volume: "Tập 1",
    edition: "Bản minh họa hư cấu",
    language: "Tiếng Việt",
    description:
      "Trở về căn nhà cũ, Miên tìm thấy một khu vườn chỉ nở hoa sau những cơn mưa. Câu chuyện hư cấu về sự trở về và những điều ta học cách giữ gìn.",
    year: 2027,
    color: "forest",
    motif: "botanical",
    eyebrow: "Một mùa để trở về",
  },
  {
    id: "tiem-tra-cuoi-chan-troi",
    slug: "tiem-tra-cuoi-chan-troi",
    title: "Tiệm trà cuối chân trời",
    author: "Lam Khê",
    category: "light-novel",
    seriesId: "tram-dung-giua-nhung-vi-sao",
    volume: "Tập 1",
    edition: "Bản tiêu chuẩn minh họa",
    language: "Tiếng Việt",
    description:
      "Ở ga tàu cuối cùng trước hoàng hôn, một tiệm trà pha những ký ức chưa kịp gọi tên. Tác phẩm kỳ ảo hư cấu dành cho những người đang tìm một chỗ nghỉ chân.",
    year: 2027,
    color: "clay",
    motif: "sun",
    eyebrow: "Ghé lại một chút thôi",
  },
  {
    id: "nhung-la-thu-gui-mua-thu",
    slug: "nhung-la-thu-gui-mua-thu",
    title: "Những lá thư gửi mùa thu",
    author: "An Nhiên",
    category: "van-hoc",
    seriesId: "nhung-mua-o-lung-may",
    volume: "Tập 2",
    edition: "Bản tiêu chuẩn minh họa",
    language: "Tiếng Việt",
    description:
      "Một hòm thư bỏ quên nối những người hàng xóm ở Lũng Mây bằng các lá thư không đề tên. Tập tiếp theo hư cấu về lòng tử tế giữa những ngày chuyển mùa.",
    year: 2027,
    color: "gold",
    motif: "botanical",
    eyebrow: "Gửi một điều chưa nói",
  },
  {
    id: "nguoi-giu-nhung-vi-sao",
    slug: "nguoi-giu-nhung-vi-sao",
    title: "Người giữ những vì sao",
    author: "Lam Khê",
    category: "light-novel",
    seriesId: "tram-dung-giua-nhung-vi-sao",
    volume: "Tập 2",
    edition: "Bản tiêu chuẩn minh họa",
    language: "Tiếng Việt",
    description:
      "Cô thợ sửa đèn trẻ nhận việc thắp lại bầu trời của một thị trấn quên mất ban đêm. Một cuộc phiêu lưu hoàn toàn hư cấu về hy vọng và những cuộc gặp gỡ.",
    year: 2027,
    color: "navy",
    motif: "stars",
    eyebrow: "Thắp sáng một khoảng trời",
  },
  {
    id: "mot-ngay-di-that-cham",
    slug: "mot-ngay-di-that-cham",
    title: "Một ngày đi thật chậm",
    author: "Hạ Mộc",
    category: "tan-van",
    volume: "Sách độc lập",
    edition: "Bản tiêu chuẩn minh họa",
    language: "Tiếng Việt",
    description:
      "Những mẩu tản văn hư cấu đi từ bữa sáng bên cửa sổ đến chuyến xe chiều qua phố. Một lời mời đặt xuống vội vàng và để ý hơn đến đời sống quanh mình.",
    year: 2026,
    color: "sage",
    motif: "sun",
    eyebrow: "Dành cho một chiều thong thả",
  },
  {
    id: "ban-do-cua-gio",
    slug: "ban-do-cua-gio",
    title: "Bản đồ của gió",
    author: "Đỗ Mây",
    category: "manga",
    volume: "Sách độc lập",
    edition: "Bản minh họa hình học nguyên bản",
    language: "Tiếng Việt",
    description:
      "Bé Sóc cùng một cánh diều vá đi tìm nơi những cơn gió bắt đầu. Câu chuyện thiếu nhi hư cấu về tình bạn, sự tò mò và niềm vui được khám phá.",
    year: 2026,
    color: "clay",
    motif: "mountain",
    eyebrow: "Mang theo một chút tò mò",
  },
  {
    id: "bien-o-phia-trong",
    slug: "bien-o-phia-trong",
    title: "Biển ở phía trong",
    author: "Trúc Yên",
    category: "manhwa",
    volume: "Sách độc lập",
    edition: "Bản tiêu chuẩn minh họa",
    language: "Tiếng Việt",
    description:
      "Một người làm gốm trẻ đến ngôi làng ven biển để học cách bắt đầu lại. Truyện tranh hư cấu theo lối kể manhwa về ký ức, sự lắng nghe và những vết rạn có thể trở thành hoa văn.",
    year: 2026,
    color: "navy",
    motif: "waves",
    eyebrow: "Lắng nghe những con sóng nhỏ",
  },
  {
    id: "dem-trang-tren-mai-nha",
    slug: "dem-trang-tren-mai-nha",
    title: "Đêm trăng trên mái nhà",
    author: "Đỗ Mây",
    category: "manga",
    volume: "Sách độc lập",
    edition: "Bản minh họa hình học nguyên bản",
    language: "Tiếng Việt",
    description:
      "Một chú mèo tưởng tượng và hai chị em dựng đài quan sát trên mái nhà. Chuyến phiêu lưu hư cấu đưa những câu hỏi nhỏ đi qua một đêm trăng thật rộng.",
    year: 2027,
    color: "plum",
    motif: "moon",
    eyebrow: "Cả bầu trời đang chờ",
  },
  {
    id: "mua-di-qua-hien",
    slug: "mua-di-qua-hien",
    title: "Mùa đi qua hiên",
    author: "Hạ Mộc",
    category: "tan-van",
    volume: "Sách độc lập",
    edition: "Bản tiêu chuẩn minh họa",
    language: "Tiếng Việt",
    description:
      "Những trang viết hư cấu về hương lá mới, chiếc ghế mây và câu chuyện của người hàng xóm. Một tập tản văn nhỏ dành cho những ai yêu nhịp sống bình dị.",
    year: 2025,
    color: "forest",
    motif: "botanical",
    eyebrow: "Nhặt một mùa bình yên",
  },
  {
    id: "thanh-pho-ngu-trong-may",
    slug: "thanh-pho-ngu-trong-may",
    title: "Thành phố ngủ trong mây",
    author: "Vũ Nguyên",
    category: "light-novel",
    volume: "Sách độc lập",
    edition: "Bản tiêu chuẩn minh họa",
    language: "Tiếng Việt",
    description:
      "Người đưa thư học việc bước vào thành phố chỉ hiện ra khi sương xuống. Một thế giới hư cấu nơi mỗi lá thư được trao tận tay sẽ đánh thức một con phố.",
    year: 2026,
    color: "sage",
    motif: "mountain",
    eyebrow: "Đi lạc vào một giấc mơ",
  },
  {
    id: "nhung-mua-o-lung-may-hop-tuyen",
    slug: "nhung-mua-o-lung-may-hop-tuyen",
    title: "Những mùa ở Lũng Mây",
    author: "An Nhiên",
    category: "van-hoc",
    seriesId: "nhung-mua-o-lung-may",
    volume: "Trọn bộ 2 tập",
    edition: "Bản hợp tuyển minh họa · gộp tập 1 và 2",
    language: "Tiếng Việt",
    description:
      "Bản hợp tuyển hư cấu gộp Khu vườn sau cơn mưa và Những lá thư gửi mùa thu trong một quyển. Dữ liệu ấn bản chỉ phục vụ giao diện minh họa, không phải thông báo xuất bản thật.",
    year: 2027,
    color: "gold",
    motif: "sun",
    eyebrow: "Hai mùa, một cuộc trở về",
  },
  {
    id: "cho-nhau-mot-mua-hoa",
    slug: "cho-nhau-mot-mua-hoa",
    title: "Chờ nhau một mùa hoa",
    author: "Trúc Yên",
    category: "manhua",
    volume: "Sách độc lập",
    edition: "Bản tiêu chuẩn minh họa",
    language: "Tiếng Việt",
    description:
      "Hai người bạn cũ cùng chăm lại vườn hoa của nhà ga sắp đóng cửa. Một truyện tranh manhua hư cấu ấm áp về lời hẹn, sự đổi thay và những khởi đầu muộn màng.",
    year: 2025,
    color: "plum",
    motif: "botanical",
    eyebrow: "Có những lời hẹn vẫn xanh",
  },
];

export type Series = {
  id: string;
  slug: string;
  title: string;
  description: string;
  bookIds: string[];
};

export const series: Series[] = [
  {
    id: "nhung-mua-o-lung-may",
    slug: "nhung-mua-o-lung-may",
    title: "Những mùa ở Lũng Mây",
    description:
      "Bộ truyện hư cấu gồm hai tập về một thị trấn nhỏ, những khu vườn và các cuộc trở về; có thêm bản hợp tuyển minh họa.",
    bookIds: [
      "khu-vuon-sau-con-mua",
      "nhung-la-thu-gui-mua-thu",
      "nhung-mua-o-lung-may-hop-tuyen",
    ],
  },
  {
    id: "tram-dung-giua-nhung-vi-sao",
    slug: "tram-dung-giua-nhung-vi-sao",
    title: "Trạm dừng giữa những vì sao",
    description:
      "Hai chuyến phiêu lưu kỳ ảo hư cấu dành cho những người muốn tìm một ánh sáng nhỏ giữa hành trình dài.",
    bookIds: ["tiem-tra-cuoi-chan-troi", "nguoi-giu-nhung-vi-sao"],
  },
];
