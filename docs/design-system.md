# Hệ thiết kế Cozy Bookstore

Snapshot thiết kế đối chiếu mã nguồn frontend hiện tại, không phải chứng nhận accessibility hay kết quả kiểm thử. Phần đề xuất tương lai được đánh dấu riêng; báo cáo validation của agent điều phối là nguồn kết quả kiểm chứng.

## Token thực tế

Ba tầng: primitive → semantic → component. Các biến hiện có ở [globals.css](<../src/app/globals.css>):

| Primitive | Giá trị hiện tại | Semantic/ứng dụng |
|---|---|---|
| `cream-100` | `#F7F1E7` | `background` — nền trang |
| `cream-50` | `#FFFDF8` | `surface` — bề mặt/card |
| `sand-200` | `#EDE2D2` | `surface-muted` — vùng nền phụ |
| `brown-900` | `#30251F` | `foreground` — nội dung chính |
| `brown-700` | `#70462E` | `primary` — nút/liên kết chính |
| `brown-800` | `#573422` | `primary-hover` |
| `brown-600` | `#6B594B` | `muted` — nội dung phụ |
| `amber-500` | `#C58B3C` | `accent` — điểm nhấn amber |
| `sand-300` | `#D8C7B3` | `border` |
| Focus riêng | `#326B72` | `focus` — viền focus-visible |

`button-bg → primary`, `button-fg → surface`, `card-bg → surface`. Shadow card hiện tại: `0 12px 24px #30251f14`. Focus-visible dùng outline 3px, offset 4px; border trang trí không thay focus ring.

### Palette bìa minh họa

Bìa CSS là hình minh họa nội dung hư cấu, không phải ảnh sách thật: forest `#244D40`, clay `#9E4F39`, navy `#293F52`, **gold `#835321`**, plum `#65465B`, sage `#56664B`, ink `#FAE6B8`. Gold đã được làm đậm trong thay đổi sửa contrast; không dùng lại màu gold cũ hoặc coi tên “gold” là màu accent amber. Việc ghi nhận màu đã sửa không chứng minh toàn bộ cặp màu đạt chuẩn.

## Typography thực tế

- **Lora** cho heading/editorial; fallback Georgia/serif.
- **Be Vietnam Pro** cho body, controls và metadata; fallback sans-serif. Fontsource phiên bản hiện tại được ghi ở [Dependencies](<./dependencies.md>).
- Body nền tảng **14px**, line-height **1.7**; mô tả product 14px/1.9. Article body **16px desktop, 15px mobile**, line-height 1.95; article excerpt 21px/19px.
- Metadata, labels và nội dung phụ thường **8–12px**, có ngoại lệ nhỏ hơn ở wordmark, caption và bìa thu nhỏ. Không tuyên bố toàn trang có minimum 16px.
- Phân biệt **đoạn nội dung cốt lõi** để đọc và **chữ trang trí trong artwork bìa**; chữ bìa thu nhỏ có thể 4–8px, không nên là nguồn duy nhất để nhận biết tên/tác giả. Heading và metadata bên ngoài bìa phải cung cấp thông tin tương ứng.
- H1 gốc `clamp(34px, 4.4vw, 61px)`, H2 `clamp(25px, 2.6vw, 36px)`, H3 20px; route/component có override theo bố cục.

Kích thước nhỏ vẫn cần review khả năng đọc/zoom; đây là mô tả mã hiện tại, không phải miễn trừ accessibility.

## Bố cục và trạng thái

Container desktop tối đa 1240px, gutter giảm theo viewport; breakpoint chính 1100px và 767px. Book grid 4 cột chuyển 2 cột mobile; news và series chuyển 1 cột. Bìa sách aspect-ratio 2/3; radius phổ biến 4–8px, không áp đặt scale 8/12/20px chưa có trong mã.

Button có min-height 46px; icon button mặc định 44×44px, một số wishlist mobile 36×36px và chip cao 40px. Mục tiêu touch target 44px vẫn là hướng review, không tuyên bố mọi control hiện có đạt kích thước đó.

Default/hover/focus-visible/active/disabled hiện được styling; disabled giảm opacity và cursor not-allowed. Dialog menu/cart dùng Radix; các tình huống keyboard, focus return, nội dung dài và xóa item cần được kiểm chứng thực tế. Badge demo/lịch dự kiến không được biến thành thành công giao dịch thật.

## Motion thực tế

CSS tokens: fast **150ms**, normal **220ms**, overlay **300ms**, editorial **400ms**, easing `cubic-bezier(0.22, 1, 0.36, 1)`. MotionProvider có default riêng **240ms**; cart drawer **220ms**, menu panel **280ms**. Không suy ra mọi overlay dùng đúng token 300ms.

Card lift 2–4px, book tilt ±4°, stagger 40ms; reveal y=10px→0 nhưng **opacity luôn 1**, không giấu nội dung ban đầu. Hero ambient y=0–12px theo scroll và x=±8px theo pointer; CSS vô hiệu transform hero trên mobile ≤767px và reduced motion. Chi tiết, điều kiện và giới hạn ở [Motion](<./motion.md>).

## Accessibility: mục tiêu và yêu cầu review

- Mục tiêu WCAG 2.2 AA: text thường 4.5:1, chữ lớn 3:1, non-text interactive/focus phù hợp 3:1; cần đo từng trạng thái trên nền thật.
- Keyboard, focus-visible, skip link, heading/landmarks, dialog focus và nhãn control cần kiểm tra cả thủ công.
- Không dùng màu hoặc hover làm cách duy nhất truyền thông tin; icon-only cần accessible name.
- Reduced motion phải giữ nội dung đọc được, không bắt tương tác pointer; zoom/reflow và tiếng Việt dài cần review thực tế.
- Automation không thay screen reader/manual review; tài liệu này không tuyên bố “đã đạt AA” hoặc “tests passed”.

## Chưa triển khai / chỉ xem xét tương lai

Page-turn, magnetic button và kệ sách cá nhân tương tác chưa được triển khai. Không quảng bá các hiệu ứng này như có sẵn. Component/state mở rộng, semantic tokens mới hoặc tăng kích thước chữ cần task thiết kế/triển khai riêng và kiểm chứng lại.
