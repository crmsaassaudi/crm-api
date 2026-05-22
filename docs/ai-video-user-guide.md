# TÀI LIỆU HƯỚNG DẪN SỬ DỤNG & VẬN HÀNH PHÂN HỆ AI VIDEO
*(Dành cho Người vận hành và Bộ phận Kiểm thử QA)*

Tài liệu này mô tả chi tiết giao diện người dùng, giải nghĩa rõ ràng các thuật ngữ kỹ thuật, giải thích tính năng của từng tab và hướng dẫn từng bước thiết lập trên giao diện Admin Dashboard của phân hệ **AI Video**.

---

## 🏛️ 1. Giải Nghĩa Các Khái Niệm Kỹ Thuật (Bằng Từ Ngữ Dễ Hiểu)

Để người sử dụng không bị bối rối bởi các thuật ngữ công nghệ, dưới đây là định nghĩa rõ ràng về các cơ chế tự động chạy ngầm:

### 1.1 "Chuẩn hóa Video" (Video Normalization) là làm cái gì?
Khi anh tải lên một video có sẵn (từ URL hoặc file trong máy), video đó có thể có kích thước ngang, dung lượng quá lớn, hoặc mã hóa âm thanh không tương thích với Facebook. **Chuẩn hóa Video** là quá trình máy chủ sử dụng công cụ **FFmpeg** tự động thực hiện 3 việc:
1. **Tự động đưa về dạng Dọc chuẩn Reels (aspect ratio 9:16):** Nếu video của anh là video ngang (tỷ lệ 16:9 giống Youtube), hệ thống sẽ tự động căn giữa và cắt (crop) hai bên để đưa về khung hình dọc **1080x1920 pixels**, giúp video hiển thị toàn màn hình và bắt mắt nhất trên điện thoại di động.
2. **Chuyển đổi mã hóa tương thích 100% (Codec H.264 & AAC):** Meta (Facebook) có quy định cực kỳ nghiêm ngặt về định dạng mã hóa video. Hệ thống sẽ tự động chuyển đổi định dạng nén hình ảnh về **H.264** và nén âm thanh về **AAC** (chuẩn công nghiệp). Việc này giúp video đăng lên Reels không bao giờ bị lỗi mất tiếng hoặc màn hình đen.
3. **Tối ưu hóa dung lượng (Compression):** Hệ thống tự động nén file video xuống dung lượng nhỏ nhất nhưng vẫn giữ nguyên độ sắc nét Full HD. Giúp quá trình tải lên Facebook cực kỳ nhanh và không bị nghẽn mạng.

### 1.2 "AI Voice Lồng tiếng & Ghép hình tự động" (Compositing) là gì?
Đây là tính năng độc quyền của **Giai đoạn 2** dành cho người dùng **không biết làm video**:
* Anh chỉ cần gõ kịch bản bằng chữ.
* Trí tuệ nhân tạo (**ElevenLabs/OpenAI**) sẽ đọc kịch bản đó bằng giọng nói truyền cảm tự nhiên giống hệt người thật.
* Hệ thống sẽ tự động lấy một ảnh slide giới thiệu sản phẩm mặc định của doanh nghiệp, tự động chèn thêm nhạc nền (BGM) loop nhẹ nhàng ở dưới (tự giảm âm lượng nhạc nền xuống còn 15% để tôn giọng đọc AI), và xuất ra file video Reels dọc hoàn chỉnh.

---

## 🖥️ 2. Mô Tả Chi Tiết Các Trường Nhập Liệu (Fields) & Các Tab Giao Diện

Khi anh bấm vào nút **"Create AI Video Job"** (Tạo tiến trình video), một hộp thoại (Modal) sẽ hiện lên with các thông tin chi tiết sau:

### 2.1 Tab "Nguồn video" (Source Type Selection) - Lựa chọn 3 con đường nạp video

Đây là nơi anh lựa chọn cách thức đưa video vào hệ thống. Có 3 Tab tương ứng với 3 tính năng chuyên biệt:

| Tên Tab trên Giao diện | Tính năng & Mục đích sử dụng | Hành động của Hệ thống |
| :--- | :--- | :--- |
| **Nhập qua URL** *(Mặc định)* | Dùng khi anh **đã có sẵn file video** được lưu trữ trên một link mạng công khai (như Google Drive, Dropbox, AWS S3, Google Storage, hoặc link CDN của đối tác). | Hệ thống xuất hiện ô nhập **Đường dẫn video gốc (URL)**. Sau khi tạo, server sẽ tự tải file về và chuẩn hóa dọc 9:16. |
| **Tải lên tệp từ máy** | Dùng khi file video **nằm trực tiếp trong máy tính/điện thoại** của anh (video tự quay hoặc tải từ máy). | Hệ thống xuất hiện khung **Kéo & Thả file**. Anh kéo file video vào hoặc click để chọn file từ ổ cứng tải lên. |
| **AI Voice Lồng tiếng** | Dùng khi anh **chưa có file video**, chỉ có kịch bản chữ và muốn AI tự sản xuất video Reels từ A-Z. | Hệ thống ẩn ô nhập link/file, xuất hiện ô **Lồng tiếng Script Text**. AI tự sinh giọng nói thuyết minh, tự ghép nhạc nền và slide ảnh thành video thành phẩm. |

---

### 2.2 Giải thích từng Trường nhập liệu (Input Fields) trong Form

1. **Trang Facebook đích (Target Page) `[Bắt buộc]`:**
   * *Giải nghĩa:* Lựa chọn Fanpage Facebook mà anh muốn đăng video Reels lên đó.
   * *Cách dùng:* Click vào menu thả xuống (Dropdown) để chọn một trong các Fanpage đã được liên kết với tài khoản của anh.
2. **Đường dẫn video gốc (URL) `[Chỉ hiện khi chọn Tab 1 - Nhập qua URL]`:**
   * *Giải nghĩa:* Địa chỉ link mạng trực tiếp trỏ đến tệp video có đuôi `.mp4`.
   * *Cách dùng:* Copy link video và dán vào ô nhập.
3. **Kéo thả hoặc Click để tải lên `[Chỉ hiện khi chọn Tab 2 - Tải lên tệp từ máy]`:**
   * *Giải nghĩa:* Vùng tải tệp trực tiếp từ máy cá nhân lên server.
   * *Cách dùng:* Kéo tệp video thả vào vùng này, hoặc click vào vùng này để mở cửa sổ chọn file trên máy tính.
4. **Lồng tiếng Script Text (Kịch bản chữ) `[Chỉ hiện khi chọn Tab 3 - AI Voice Lồng tiếng]`:**
   * *Giải nghĩa:* Kịch bản nội dung bằng chữ để AI đọc lồng tiếng và làm video.
   * *Cách dùng:* Nhập nội dung kịch bản thuyết minh (Khuyên dùng từ 50 - 300 từ để video Reels có thời lượng tối ưu từ 15 giây đến 1 phút).
5. **Nội dung bài đăng (Caption) `[Tùy chọn]`:**
   * *Giải nghĩa:* Lời mô tả bài viết sẽ hiển thị phía trên/dưới video khi đăng lên Facebook Reels.
   * *Cách dùng:* Nhập lời dẫn cuốn hút cho người xem. *Đặc biệt, bên cạnh ô này có nút **AI Content Assistant** lấp lánh (Sparkles). Anh có thể click vào đó, gõ ý tưởng ngắn và bấm "AI Generate" để trợ lý AI tự viết Caption hoàn chỉnh kèm icon vô cùng hấp dẫn.*
6. **Hashtags phụ `[Tùy chọn]`:**
   * *Giải nghĩa:* Các từ khóa dạng thẻ phân loại bài đăng để tăng tương tác Reels (Ví dụ: `#marketing`, `#viral`).
   * *Cách dùng:* Nhập các từ khóa phân cách nhau bằng dấu phẩy `,` (Ví dụ: `marketing, sales, viral`). Hệ thống sẽ tự động chuẩn hóa bằng cách thêm ký tự `#` ở phía trước mỗi từ cho anh.

---

## 🚀 3. Hướng Dẫn Từng Bước Thiết Lập Trên Giao Diện (Step-by-Step)

### 3.1 Quy trình Tạo Video Tự Động bằng Kịch bản chữ (AI Voice Tab)
* **Bước 1:** Bấm nút **Create AI Video Job** ở góc trên bên phải màn hình.
* **Bước 2:** Chọn Fanpage mục tiêu tại ô **Trang Facebook đích**.
* **Bước 3:** Click chọn Tab **AI Voice Lồng tiếng**.
* **Bước 4:** Gõ kịch bản chữ vào ô **Lồng tiếng Script Text**.
* **Bước 5:** Bấm nút **AI Content Assistant** (Sparkles) để AI tự động viết Caption và Hashtags dựa trên kịch bản vừa gõ.
* **Bước 6:** Bấm nút màu tím **Tạo & Nạp Job**. 
* **Kết quả:** Hệ thống tự chạy ngầm sinh giọng nói $\rightarrow$ ghép nhạc nền $\rightarrow$ chuẩn hóa video $\rightarrow$ sinh caption nháp $\rightarrow$ đưa về trạng thái `PENDING_REVIEW` (Chờ duyệt).

### 3.2 Quy trình Kiểm duyệt & Xuất bản Video
Sau khi video được sản xuất ngầm xong và nằm ở trạng thái `PENDING_REVIEW` (Chờ duyệt):
* **Bước 1:** Click vào hàng của Job trong bảng để mở **Drawer chi tiết** ở bên phải màn hình.
* **Bước 2:** Nhấn nút Play để **xem thử (Preview)** video thành phẩm và nghe giọng đọc AI.
* **Bước 3:** Kiểm tra kịch bản và Caption được hiển thị rõ ràng.
* **Bước 4 (Phê duyệt):** 
  * Nếu video đạt yêu cầu: Bấm nút màu xanh **Approve**. Trạng thái sẽ chuyển thành `APPROVED` và tự động xếp vào **Khung giờ vàng** (scheduled).
  * Nếu muốn đăng ngay không cần đợi giờ vàng: Bấm tiếp **Publish Now** để xuất bản lập tức lên Facebook Reels.
* **Bước 5 (Từ chối):**
  * Nếu video không đạt yêu cầu: Bấm nút màu đỏ **Reject**. Nhập lý do (Ví dụ: *"Kịch bản nói lắp, cần sửa lại"*). Hệ thống sẽ chuyển trạng thái sang `REJECTED` và ghi nhận nhật ký lỗi.

### 3.3 Quy trình Thiết lập Khung giờ vàng (Scheduler settings)
* **Bước 1:** Click vào tab **Scheduler Settings** (nằm bên cạnh tab Job Queue trên giao diện chính).
* **Bước 2:** Tại phần **Golden Slots**, nhập khung giờ vàng anh mong muốn đăng bài (Ví dụ: `09:00`, `20:00`) và bấm **Add Slot**.
* **Bước 3:** Thiết lập chính sách tự động dọn dẹp video cũ tại mục **Retention Policy** để tiết kiệm dung lượng máy chủ.
* **Bước 4:** Bấm **Save Settings** để lưu lại.
* **Kết quả:** Kể từ bây giờ, mọi video khi được duyệt (`APPROVED`) sẽ tự động được xếp lịch đăng rải đều vào các khung giờ vàng này hoàn toàn tự động, không lo bị đè trùng giờ đăng!

---

## 🔑 4. Cấu hình Phân quyền Hệ thống (RBAC Permissions)

Để đảm bảo tính bảo mật và phân quyền mạch lạc của hệ thống CRM, phân hệ AI Video không sử dụng chung tài nguyên `'settings'` (cấu hình hệ thống chung) mà sử dụng một tài nguyên độc lập chuyên biệt là **`ai_video`**.

### Danh sách phân quyền chi tiết của Phân hệ AI Video:

| Hành động | Vai trò nghiệp vụ | Quyền yêu cầu trong Hệ thống |
| :--- | :--- | :--- |
| **Tạo Job mới** | Cho phép nhân viên tạo tiến trình video (Tab URL, Upload, AI Voice) | **`create`** trên tài nguyên **`ai_video`** |
| **Xem danh sách/chi tiết** | Cho phép xem danh sách hàng đợi, lịch sử audit và Drawer video | **`view`** trên tài nguyên **`ai_video`** |
| **Trợ lý AI Sparkles** | Cho phép sử dụng AI sinh Caption và Hashtags trực tiếp | **`edit`** trên tài nguyên **`ai_video`** |
| **Phê duyệt & Đăng Reels** | Cho phép duyệt, từ chối hoặc đăng Reels lập tức lên Fanpage | **`manage_system`** trên tài nguyên **`ai_video`** |

> [!NOTE]
> Mặc định, các quyền trên tài nguyên `ai_video` đã được gán sẵn vào nhóm quyền cốt lõi (**`CORE_PERMISSIONS`**). Tất cả tài khoản Owner/Admin của các Tenant sẽ tự động có quyền này mà không cần cấu hình thủ công. Đối với nhân viên thông thường, vui lòng cấp quyền `ai_video` tương ứng trong trang Quản lý Vai trò (Roles).

