# Motion: hiện trạng và hiệu ứng chưa triển khai

Đặc tả dưới đây được đối chiếu với [motion.tsx](<../src/components/motion.tsx>), [globals.css](<../src/app/globals.css>), [cart drawer](<../src/components/cart-drawer.tsx>) và [shell](<../src/components/shell.tsx>). Đây là hành vi định nghĩa trong mã nguồn, không phải kết luận đã kiểm thử mọi thiết bị/trình duyệt. Validation của agent điều phối là nguồn kết quả chạy thực tế.

## Mục tiêu

Chuyển động nhỏ, mềm, hỗ trợ cảm giác khám phá sách; không che nội dung, không ép đọc theo animation, không giả giao dịch. Chỉ dùng transform/opacity và trạng thái thị giác phù hợp; không hứa mọi hiệu ứng đều GPU-only vì CSS còn có shadow/filter.

## Thời gian và easing

| Cấu hình hiện có | Giá trị | Phạm vi |
|---|---|---|
| CSS `duration-fast` | 150ms | Color/background, button feedback |
| CSS `duration-normal` | 220ms | Link transform/shadow, nav underline, card |
| CSS `duration-overlay` | 300ms | Chuyển động ornament news hiện dùng token này |
| CSS `duration-editorial` | 400ms | Token editorial; Reveal khai báo trực tiếp 0.4s tương ứng |
| CSS `ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | Token easing |
| MotionProvider default | 240ms; `[0.22, 1, 0.36, 1]` | Transition mặc định của Motion |
| Cart overlay/panel | 220ms | Override cụ thể; reduced motion 0ms |
| Menu panel | 280ms | Override cụ thể; reduced motion 0ms |

Token CSS không tự liên kết với mọi Motion transition. Menu overlay không khai báo duration riêng, kế thừa cấu hình Motion; không ghi nhầm mọi drawer là 300ms hoặc mọi transition là 220ms.

## Reveal và stagger hiện có

- `Reveal` khởi tạo **opacity=1**, y=10px; vào viewport chuyển về opacity=1, y=0 trong 400ms. **Không có opacity=0 hoặc initial invisible**.
- `viewport`: `once=true`, `amount=0.1`; animation chạy một lần khi ngưỡng khoảng 10% của vùng quan sát thỏa mãn.
- Delay mặc định 0. Book card dùng `(index % 5) × 40ms`, giới hạn delay nhóm 0–160ms; news card dùng `index × 40ms` theo danh sách hiện tại, không khẳng định có cap chung cho mọi danh sách.
- Reduced motion: y=0, duration=0, delay=0. Nội dung không phụ thuộc việc animation kết thúc để đọc được.

## Book tilt hiện có

- `BookTilt` dùng rotateX/rotateY theo vị trí pointer quanh tâm; phạm vi thông thường **±4° mỗi trục** trong bounding box, perspective 900px.
- Spring: stiffness 210, damping 25; pointer leave đưa cả hai trục về 0.
- Chỉ nhận chuyển động khi pointer là mouse, media query `(hover: hover) and (pointer: fine)` đúng và người dùng không bật reduced motion. Không dùng tilt như tương tác bắt buộc trên màn hình cảm ứng.
- Hover cover bổ sung drop-shadow; desktop book card từ min-width 1024px có lift -3px. Outer `article.book-card` sở hữu hover transform; `Reveal` bên trong sở hữu scroll transform, tránh Motion inline style ghi đè CSS elevation. Đây là trang trí, không thay liên kết/tên sách có thể focus.

## Micro-interactions CSS hiện có

| Tương tác | Hành vi |
|---|---|
| Button hover | TranslateY -2px, thay background/foreground |
| Button active | Scale 0.97; `.button:hover:active` giữ press feedback ngay cả khi đang hover |
| Category card hover | TranslateY -4px, shadow và border |
| Series card hover | TranslateY -3px, shadow |
| Desktop book card hover | TranslateY -3px |
| Desktop nav | Underline scaleX 0→1 từ trái khi hover/current |
| News ornament hover | TranslateY -5px, rotate -3°, 300ms |
| Skeleton | Pulse opacity xuống 0.5, chu kỳ 1.5s |

CSS reduced-motion tắt animation và duration transition, bỏ các transform hover/active kể trên. Shadow/color có thể đổi tức thì; không mô tả reduced-motion là mọi state đều biến mất.

## Hero ambient hiện có

- Scroll toàn trang từ y=0 đến 600px được map/clamp vào translateY **0–12px**.
- Pointer ngang trong hero map thành translateX **-8 đến +8px**, qua spring stiffness 55/damping 20. Pointer leave trở về tâm.
- Mouse pointer điều khiển x khi không reduced motion; không có tính năng drag, page-turn hay physics kệ sách.
- CSS tại viewport **≤767px**, `(hover: none)` hoặc `(pointer: coarse)` đặt `.hero-art` transform none; vì vậy touch landscape cũng không parallax. Reduced motion cũng đặt transform none. Hook có thể vẫn tồn tại nhưng hiệu ứng transform bị vô hiệu trong các trường hợp này.
- Reduced-motion branch của Motion đặt cả x/y về 0; hình minh họa tĩnh và nội dung vẫn có mặt.

## Menu và cart drawers hiện có

- Radix Dialog kiểm soát cấu trúc dialog, portal và trigger; AnimatePresence giữ lifecycle mở/đóng cho animation.
- **Cart:** overlay opacity 0→1→0; panel x=100%→0→100% và opacity 0→1→0, thời gian 220ms. Reduced motion dùng x=0, initial opacity=1 và duration=0, exit opacity thay tức thì.
- **Menu:** overlay fade theo transition mặc định; panel x=100%→0, exit x=100%/opacity=0 trong 280ms. Reduced motion đặt x=0 và panel duration=0. Overlay vẫn khai báo opacity fade và không có duration=0 riêng, nên không khẳng định overlay menu luôn tức thì ở reduced mode.
- Đóng qua nút, điều hướng và các hành vi dialog cần keyboard/focus review. Cart có logic requestAnimationFrame đưa focus tới nút xóa còn lại hoặc link thích hợp sau khi xóa item; đây là logic accessibility, không phải hiệu ứng trình diễn.
- Cart chỉ là chọn sách demo trên thiết bị; không giữ hàng, tính tiền, thanh toán hoặc tạo đơn.

## Reduced motion và khả năng đọc

MotionProvider đặt `reducedMotion="user"`; component dùng useReducedMotion và CSS có media query riêng. CSS tắt smooth scrolling, animations, transition duration và các transform trang trí liên quan. Không nói mọi opacity Motion tự động bị tắt: MotionConfig và từng override có semantics riêng, nhất là overlay menu.

Cần review keyboard/focus, không content shift bất ngờ, zoom, fine/coarse pointer, mobile viewport, reduced motion, hiệu năng và nội dung vẫn đọc được khi animation bị tắt. Không suy ra đạt các tiêu chí này chỉ từ sự tồn tại của media query.

## Chỉ nằm trong ý tưởng tương lai — chưa triển khai

- **Page-turn:** chưa có animation lật trang hoặc trình đọc sách.
- **Magnetic button:** chưa có nút hút theo con trỏ; translateY hover không phải magnetic interaction.
- **Interactive personal bookshelf:** chưa có kệ sách cá nhân kéo/thả, sắp xếp 3D hay đồng bộ tài khoản. Wishlist demo không tương đương module readers/bookshelf Phase 5.

Các ý tưởng trên cần phê duyệt, thiết kế accessibility/performance và kiểm chứng riêng trước khi phát triển. Không thêm source/dependency để “làm khớp” tài liệu này.
