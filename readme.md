# Universal Floating Viewer

Ứng dụng web thuần HTML/CSS/JavaScript (không framework, không backend) cho phép nhập **bất kỳ URL website nào**, xem trước ngay trong trang, và bật nó lên thành một **cửa sổ nổi (Picture-in-Picture)** độc lập — giống tính năng đồng hồ nổi của LiveSplit One — để vừa xem vừa làm việc khác.

## Tính năng

- **Nhập & tải URL**: tự thêm `https://` nếu bạn gõ thiếu scheme, kiểm tra URL hợp lệ trước khi tải, hỗ trợ dán URL có query string/fragment.
- **Xem trước trong trang**: hiển thị website qua `<iframe>` với 3 trạng thái rõ ràng — đang tải / đã tải / có thể bị chặn nhúng.
- **Cửa sổ nổi (Document Picture-in-Picture)**: dùng `documentPictureInPicture.requestWindow()` của trình duyệt, mặc định 420×650px, có thể đổi kích thước, tự đồng bộ giao diện (theme, màu nền, bo góc...) với cài đặt chính, đổi URL ngay trong lúc cửa sổ đang mở mà không cần tạo lại cửa sổ.
- **Dự phòng khi không hỗ trợ PiP**: nếu trình duyệt không có Document PiP hoặc yêu cầu bị từ chối, tự động mở một **popup thường** thay vì báo lỗi im lặng.
- **Bảng cài đặt** chia 3 nhóm:
  - *Window*: kích thước, màu nền, bo góc, padding, bật/tắt thanh mini-header trong cửa sổ nổi.
  - *Appearance*: sáng/tối, màu nhấn (accent), font chữ, cỡ chữ, độ mờ khung xem trước, CSS tùy chỉnh (áp dụng trực tiếp cho giao diện app).
  - *Behavior*: tự mở lại URL gần nhất, tự nhớ cài đặt, giữ nguyên URL khi mở lại cửa sổ nổi, tự cập nhật cửa sổ nổi khi đổi URL.
- **Lịch sử URL**: lưu tối đa 15 URL gần nhất, bấm để tải lại, xoá từng mục, hoặc "Clear history" toàn bộ (có hộp thoại xác nhận).
- **Lưu trữ bằng LocalStorage**: tự lưu mọi thay đổi, không cần nút Save; dữ liệu hỏng/thiếu sẽ tự quay về mặc định thay vì làm crash app.
- Giao diện tối giản, dark mode mặc định, responsive xuống tới mobile, có trạng thái focus rõ ràng và tôn trọng `prefers-reduced-motion`.

## Cấu trúc dự án

```
├── index.html   # Cấu trúc trang: thanh URL, khung xem trước, sidebar cài đặt, lịch sử
├── style.css    # Toàn bộ giao diện (dark theme, responsive, không dùng framework)
├── script.js    # Toàn bộ logic: URL, iframe, PiP, cài đặt, localStorage, lịch sử
└── README.md    # File này
```

## Cách chạy

Document Picture-in-Picture **yêu cầu secure context** (HTTPS hoặc `localhost`), nên **không mở trực tiếp bằng `file://`** — hãy chạy qua một local server đơn giản, ví dụ:

```bash
# Cách 1: dùng Node.js (không cần cài gì thêm)
npx serve .

# Cách 2: dùng Python
python3 -m http.server 8080

# Cách 3: VS Code — extension "Live Server"
```

Sau đó mở `http://localhost:<port>` bằng trình duyệt.

## Trình duyệt hỗ trợ

- Tính năng cửa sổ nổi (Document Picture-in-Picture) hiện chỉ có trên **Chrome/Edge bản mới** (Chromium ≥ 116).
- Trên các trình duyệt không hỗ trợ, app sẽ tự động dùng **popup window thường** thay thế — vẫn tải được website, chỉ là không "nổi" theo kiểu PiP thật.

## Giới hạn & lưu ý quan trọng

- **Không phải website nào cũng cho nhúng iframe.** Những site bật `X-Frame-Options` hoặc CSP `frame-ancestors` (ví dụ nhiều trang ngân hàng, một số mạng xã hội) sẽ không hiển thị được trong khung xem trước hay trong iframe của cửa sổ nổi. App sẽ báo "có thể bị chặn" dựa trên timeout tải trang (vì JS không thể đọc nội dung iframe khác domain để kiểm tra chắc chắn) — khi gặp trường hợp này, dùng nút **"New tab"** để mở trực tiếp.
- App không và sẽ không tìm cách lách qua CSP/X-Frame-Options/CORS — đây là giới hạn bảo mật của trình duyệt, không phải lỗi của app.
- Do giới hạn same-origin, app không thể đọc được nội dung bên trong iframe của site khác domain; mọi đồng bộ (theme, kích thước...) chỉ áp dụng cho khung bao bên ngoài iframe, không can thiệp vào trang web được nhúng.

## Công nghệ

Vanilla HTML5 + CSS3 + JavaScript (ES6+). Không framework, không build step, không cần API key, không cần cài dependency.
