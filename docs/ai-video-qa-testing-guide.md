# AI Video Orchestrator & Production Engine - QA Testing Guide

Tài liệu này cung cấp hướng dẫn kiểm thử chi tiết (QA Test Cases) dành cho bộ phận Kiểm thử chất lượng (QA/QC) để xác thực hoạt động thông suốt của phân hệ **AI Video Orchestrator & Auto Production Engine** trên cả giao diện người dùng (`crm-web`) và hệ thống xử lý ngầm (`crm-api`).

---

## 📋 1. Chuẩn bị Trước khi Kiểm thử (Test Preparation)

Để QA có thể test nhanh và bao quát tất cả các trường hợp, hệ thống hỗ trợ 2 chế độ cấu hình môi trường:

### Chế độ A: Kiểm thử Thực tế (Cần API Keys)
* Cấu hình trong `.env` của Backend: Có đầy đủ `ELEVENLABS_API_KEY`, `GEMINI_API_KEY` (hoặc `OPENAI_API_KEY`).
* **Mục tiêu:** Xác thực chất lượng sinh giọng đọc AI thật, video dựng ghép khớp tiếng thật, và lời bình do AI sinh tự động.

### Chế độ B: Kiểm thử Tự phục hồi (Không cần API Keys & FFmpeg 🚀)
* Cấu hình trong `.env` của Backend: **Để trống** `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`.
* **Mục tiêu:** Xác thực cơ chế tự phục hồi (Resilience). Hệ thống phải tự động vượt qua lỗi thiếu API để chạy hết luồng nghiệp vụ mà không bị văng lỗi crash.

---

## 🧪 2. Các Kịch bản Kiểm thử Chi tiết (Test Cases)

### 🎯 Test Case 01: Tạo Video tự động bằng Kịch bản lồng tiếng AI (AI Script Production)
* **Mục tiêu:** Kiểm tra luồng sản xuất video đứng Reels tự động từ kịch bản văn bản (ElevenLabs TTS + FFmpeg Compositor).
* **Các bước thực hiện:**
  1. Đăng nhập vào Admin Dashboard $\rightarrow$ Đi tới mục **AI Video**.
  2. Bấm nút **Create AI Video Job**.
  3. Chọn **Target Page** (Fanpage Facebook liên kết).
  4. Tại phần **Source Type**, chọn tab **AI Voice Lồng tiếng** (Hệ thống phải ẩn trường nhập URL và hiển thị Textarea).
  5. Nhập nội dung kịch bản tại ô **Lồng tiếng Script Text** (Ví dụ: *"Chào bạn, đây là video được sản xuất tự động."*).
  6. Nhập Caption nháp ban đầu (hoặc để trống để AI tự sinh sau).
  7. Bấm **Create Job** để gửi yêu cầu.
* **Kết quả mong đợi (Expected Outcome):**
  * Hộp thoại đóng lại và hiển thị Toast thông báo thành công.
  * Hàng đầu tiên trong bảng danh sách Job xuất hiện với trạng thái ban đầu là `CREATED`.
  * Trạng thái Job tự động chuyển đổi tuần tự dưới nền: `CREATED` $\rightarrow$ `INGESTING` (Sinh giọng thuyết minh) $\rightarrow$ `INGESTED` $\rightarrow$ `NORMALIZING` (Render video đứng) $\rightarrow$ `NORMALIZED` $\rightarrow$ `PROCESSING` (AI phân tích kịch bản tự tạo Caption) $\rightarrow$ `PROCESSED` $\rightarrow$ `PENDING_REVIEW` (Chờ kiểm duyệt).
  * Click vào hàng của Job để mở **Drawer chi tiết**:
    * Trong Drawer hiển thị trình phát video Preview. Click nút Play phải nghe thấy giọng thuyết minh AI lồng nhạc nền êm ái (hoặc âm lặng mô phỏng nếu test Chế độ B).
    * Hiển thị nội dung kịch bản văn bản nguyên bản trong khung Monospace **AI Script Lồng tiếng**.
    * Trục thời gian **Timeline (Audit Trail)** ghi nhận đầy đủ vết hoạt động của hệ thống ở từng trạng thái.

---

### 🎯 Test Case 02: Trợ lý viết Caption lấp lánh (Sparkles AI Content Assistant)
* **Mục tiêu:** Kiểm tra tính năng AI sinh/sửa lời bình bài đăng trực tiếp trên giao diện.
* **Các bước thực hiện:**
  1. Click vào một Job trong bảng danh sách để mở **Drawer chi tiết**.
  2. Tại phần **Full Caption**, click vào nút **AI Content Assistant** lấp lánh (Sparkles).
  3. Form nhập prompt chỉ đạo phong cách viết bài sẽ trượt xuống.
  4. Nhập chỉ dẫn tuỳ ý (Ví dụ: *"Viết lại bằng tiếng Việt, giọng hài hước, chèn nhiều icon vui vẻ"*), hoặc để trống để AI viết tự do.
  5. Bấm nút **AI Generate**.
* **Kết quả mong đợi (Expected Outcome):**
  * Nút "AI Generate" chuyển sang trạng thái loading kèm hiệu ứng **Shimmer chuyển động gradient mịn màng**.
  * Sau 2-3 giây, Caption và danh sách Hashtags mới được sinh ra hiển thị đè lên Caption cũ.
  * Hiển thị Toast thông báo cập nhật thành công.

---

### 🎯 Test Case 03: Kiểm duyệt & Đăng ngay lập tức (Publish Now)
* **Mục tiêu:** Kiểm tra tính năng xuất bản video lập tức lên Fanpage Reels sử dụng cơ thức phân mảnh Meta Chunked Upload.
* **Các bước thực hiện:**
  1. Chọn một Job có trạng thái `PENDING_REVIEW` và mở Drawer chi tiết.
  2. Bấm nút **Approve** ở góc dưới. Trạng thái Job chuyển thành `APPROVED`.
  3. Bấm nút **Publish Now** (Đăng ngay).
* **Kết quả mong đợi (Expected Outcome):**
  * Trạng thái Job chuyển thành `PUBLISHING` (Hệ thống đang tải video phân mảnh 4MB lên Meta Graph API).
  * Sau khi đăng thành công, trạng thái chuyển sang màu xanh lá **`PUBLISHED`**.
  * Trong Drawer xuất hiện dòng chữ **Meta Platform Link** (Xem bài đăng trên Facebook). Click vào link phải mở ra trang Facebook Reels thật với video và caption tương ứng.

---

### 🎯 Test Case 04: Tự động Lên lịch Khung giờ vàng (Scheduler Golden Slots)
* **Mục tiêu:** Kiểm tra giải thuật tự động xếp lịch đăng bài, tránh đè trùng giờ đăng của cùng một Tenant.
* **Các bước thực hiện:**
  1. Chuyển sang Tab **Scheduler Settings** (Cấu hình lập lịch).
  2. Thiết lập một khung giờ vàng (Ví dụ: `09:00`, `15:00`). Bấm Save.
  3. Quay lại danh sách Job, duyệt cùng lúc 3 video khác nhau có trạng thái `PENDING_REVIEW` bằng cách bấm **Approve**.
* **Kết quả mong đợi (Expected Outcome):**
  * Cả 3 Job đều tự động chuyển sang trạng thái **`SCHEDULED`**.
  * Hệ thống tự động xếp lịch:
    * Job 1 đăng vào: `Ngày hôm nay 09:00`.
    * Job 2 đăng vào: `Ngày hôm nay 15:00`.
    * Job 3 đăng vào: `Ngày mai 09:00` (Tự động đẩy sang ngày hôm sau vì 2 slot ngày hôm nay đã có bài đăng đè, đảm bảo khoảng cách an toàn).
  * Kiểm tra cột **Scheduled Time** hiển thị chuẩn xác giờ đăng đã tính toán.

---

### 🎯 Test Case 05: Kiểm tra Từ chối Job (Reject Workflow)
* **Mục tiêu:** Kiểm tra luồng từ chối phê duyệt video chất lượng kém và ghi chép lý do.
* **Các bước thực hiện:**
  1. Chọn một Job có trạng thái `PENDING_REVIEW` và mở Drawer chi tiết.
  2. Bấm nút **Reject** (Từ chối).
  3. Hệ thống hiển thị hộp thoại yêu cầu nhập lý do từ chối.
  4. Nhập lý do: *"Video bị lỗi âm thanh, kịch bản chưa cuốn hút"* $\rightarrow$ Bấm Confirm.
* **Kết quả mong đợi (Expected Outcome):**
  * Trạng thái Job chuyển thành màu đỏ **`REJECTED`**.
  * Trong Drawer hiển thị dòng chữ **Lý do từ chối:** *"Video bị lỗi âm thanh, kịch bản chưa cuốn hút"*.
  * Audit Trail ghi nhận chi tiết hành động từ chối của User.

---

## 🔑 3. Phân quyền Hệ thống (RBAC Permissions) cho QA Test

Để tránh gặp lỗi `403 Forbidden`, QA cần đảm bảo tài khoản kiểm thử được cấp đầy đủ quyền trên tài nguyên độc lập **`ai_video`** (Thay vì `'settings'` như trước):

| Vai trò kiểm thử | Hành động kiểm thử | Quyền yêu cầu trên `ai_video` |
| :--- | :--- | :--- |
| **Nhân viên (Creator)** | Tạo video, nhập URL, sinh AI voice, xem hàng đợi | **`create`** và **`view`** |
| **Biên tập viên (Editor)** | Sử dụng Trợ lý AI Sparkles viết Caption/Hashtags | **`edit`** |
| **Quản trị viên (Admin)** | Phê duyệt (`APPROVED`), Từ chối (`REJECTED`), Đăng ngay (`PUBLISHED`) | **`manage_system`** |

> [!TIP]
> Tất cả các quyền trên đã được tích hợp mặc định vào **`CORE_PERMISSIONS`** của NestJS. Do đó, tài khoản **Super Admin/Owner** của các Tenant test sẽ tự động có đầy đủ các quyền này mà không cần gán thủ công trong database.

