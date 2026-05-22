# AI Video Production Engine - Production Deployment & Setup Guide

Tài liệu này hướng dẫn chi tiết các bước chuẩn bị môi trường máy chủ (Infrastructure), cài đặt các công cụ bổ trợ hệ thống, chuẩn bị tài nguyên tĩnh và cấu hình đầy đủ các biến môi trường (`.env`) để vận hành ổn định hệ thống **AI Video Orchestrator & Auto Production Engine** trên môi trường Production (Go-live).

---

## 🛠️ 1. Chuẩn bị Hạ tầng Máy chủ (Infrastructure Setup)

Động cơ dựng phim tự động (`VideoCompositorService`) sử dụng Node.js để gọi các lệnh CLI trực tiếp của công cụ **FFmpeg** nhằm ghép nối hình ảnh, lồng tiếng và chèn nhạc nền. Vì vậy, máy chủ Production bắt buộc phải cài đặt binary FFmpeg.

### 1.1 Cài đặt FFmpeg trên máy chủ Linux (Ubuntu/Debian)
Đăng nhập vào máy chủ VPS thông qua SSH và thực hiện các lệnh sau:
```bash
sudo apt-get update
sudo apt-get install -y ffmpeg

# Kiểm tra xem FFmpeg đã được cài đặt thành công chưa
ffmpeg -version
```

### 1.2 Tích hợp FFmpeg vào Dockerfile (Nếu sử dụng Docker)
Dự án sử dụng Base Image dạng Alpine Linux (`node:22.21.1-alpine`). Để tích hợp FFmpeg, chúng ta cài đặt thông qua `apk` trực tiếp trong Stage Production:

```dockerfile
FROM node:22.21.1-alpine AS production

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV HUSKY=0

# Cài đặt FFmpeg trên môi trường Alpine Linux
RUN apk add --no-cache ffmpeg

RUN addgroup -S -g 10001 nodejs && adduser -S -D -H -u 10001 -G nodejs nestjs
# ... copy assets & start command
```

### 1.3 Cấp quyền ghi thư mục tạm thời (Workspace Temp Permissions)
Động cơ compositing cần một không gian đĩa cục bộ tạm thời để tải giọng đọc thuyết minh, hình ảnh slide, và xuất video đầu ra trước khi dọn dẹp.
* Hệ thống sẽ tự động tạo thư mục `/crm-temp/render` (hoặc cấu hình tuỳ chọn).
* Hãy đảm bảo user vận hành Node.js/Docker có quyền ghi chép (**Read/Write**) trên phân vùng đĩa này:
```bash
# Cấp quyền ghi cho thư mục tạm thời (Ví dụ trên Linux)
sudo mkdir -p /crm-temp/render
sudo chmod -R 777 /crm-temp
```

---

## 🎵 2. Chuẩn bị Tài nguyên Tĩnh Mặc định (Assets Setup)

Khi người dùng chọn tạo video Reels bằng kịch bản văn bản (`script_production`), động cơ dựng hình cần có một ảnh nền slideshow mặc định và một tệp nhạc nền (BGM) nhẹ nhàng để ghép nối.

1. **Nhạc nền mặc định (Looping BGM):**
   * Chuẩn bị 1 tệp tin âm thanh định dạng `.mp3` (khuyến nghị nhạc nhẹ, acoustic, không bản quyền).
   * Đặt tên tệp tin: `soft-acoustic.mp3`.
2. **Slide hình nền mặc định (Background Slide):**
   * Chuẩn bị 1 tệp tin hình ảnh định dạng `.jpg` hoặc `.png`.
   * Khuyến nghị độ phân giải đứng: **1080x1920** pixels (tương ứng với tỷ lệ đứng 9:16 của Reels/Tiktok).
   * Đặt tên tệp tin: `crm-slide.jpg`.

*Lưu trữ các tệp tin này cố định trong thư mục tài nguyên của Backend (ví dụ `/var/www/crm-api/assets/`) và cập nhật đường dẫn tuyệt đối trong file `.env`.*

---

## ⚙️ 3. Cấu hình Biến môi trường (`.env` Production)

Sao chép và điền đầy đủ các giá trị thực tế sau vào tệp tin `.env` của dự án Backend (`crm-api`) trên môi trường Production:

```env
# ==============================================================================
# 🤖 MULTI-TENANT & CORE DATABASE CONFIG
# ==============================================================================
PORT=3000
NODE_ENV=production
MONGO_URI=mongodb://username:strong_password@prod-mongo-db:27017/crm_database?authSource=admin
REDIS_HOST=prod-redis-server
REDIS_PORT=6379
REDIS_PASSWORD=strong_redis_password

# ==============================================================================
# 🧠 GENERATIVE AI ENGINE (Caption & Hashtags Generation)
# ==============================================================================
# OpenAI API Key dùng để sinh lời bình bài đăng và fallback lồng tiếng
OPENAI_API_KEY=sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Gemini API Key ưu tiên dùng cho AI sinh lời bình chất lượng cao
GEMINI_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# ==============================================================================
# 🗣️ AI VOICE SYNTHESIS ENGINE (ElevenLabs Speech API)
# ==============================================================================
# ElevenLabs API Key dùng để chuyển đổi kịch bản văn bản thành giọng nói tự nhiên
ELEVENLABS_API_KEY=el-key-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# ID của Giọng đọc mặc định từ thư viện ElevenLabs (Ví dụ giọng Rachel, Adam, etc.)
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM

# ==============================================================================
# 🎬 FFmpeg VIDEO COMPOSITOR ASSETS (Đường dẫn tuyệt đối trên máy chủ)
# ==============================================================================
# Đường dẫn tuyệt đối tới tệp nhạc nền mặc định
BGM_PATH=/var/www/crm-api/assets/bgm/soft-acoustic.mp3

# Đường dẫn tuyệt đối tới ảnh slide nền mặc định
BG_SLIDE_PATH=/var/www/crm-api/assets/images/crm-slide.jpg
```

---

## 🔑 4. Xác thực Meta App & Quyền Page Access Token

Để động cơ tự động xuất bản xuất bản (Auto Publish Reels) thành công lên các trang Fanpage mà không bị chặn, hãy đảm bảo:

1. **Meta App Mode:** Chuyển trạng thái ứng dụng Meta App của bạn từ **In Development** sang **Live** trong trang quản trị [Meta Developers](https://developers.facebook.com/).
2. **Quyền hạn cần thiết (Permissions):** Khi người dùng liên kết tài khoản Facebook Pages thông qua module Omni-channel Settings, Meta App của bạn phải yêu cầu đầy đủ các quyền:
   * `pages_manage_posts` (Đăng Reels/Video lên Trang).
   * `pages_read_engagement` (Đọc chỉ số tương tác).
   * `pages_show_list` (Liệt kê danh sách các Trang quản trị).
3. **Meta Business Verification:** Nếu xuất bản video thương mại, hãy chắc chắn Meta Business Account của bạn đã hoàn tất xác minh doanh nghiệp để tránh bị Meta khóa tài khoản đăng tải hàng loạt do nghi ngờ spam.

---

## 🚀 5. Hướng dẫn Kiểm thử Sau khi Deploy (Smoke Testing)

Sau khi khởi chạy Backend và Frontend trên Production, hãy thực hiện một bài test nhanh (smoke test) để kiểm chứng hệ thống đã chạy thông suốt:

1. **Đăng nhập** vào React Admin Dashboard (`crm-web`).
2. Đi tới phân hệ **AI Video** $\rightarrow$ Click nút **"Create AI Video Job"**.
3. Chọn Fanpage mục tiêu $\rightarrow$ Chọn Source Type là **"AI Voice Lồng tiếng"**.
4. Nhập kịch bản ngắn: 
   > *"Xin chào các bạn, đây là video Reels được sản xuất hoàn toàn tự động bởi động cơ AI Video Production Engine của hệ thống CRM. Chúc các bạn một ngày làm việc hiệu quả!"*
5. Bấm **Create Job** và theo dõi Drawer chi tiết của Job:
   * Trạng thái phải chuyển động tuần tự: `CREATED` $\rightarrow$ `INGESTING` (Sinh giọng nói AI ElevenLabs) $\rightarrow$ `INGESTED` $\rightarrow$ `NORMALIZING` (Render bằng FFmpeg) $\rightarrow$ `NORMALIZED` $\rightarrow$ `PROCESSING` (AI sinh caption nháp) $\rightarrow$ `PROCESSED` $\rightarrow$ `PENDING_REVIEW`.
   * Kiểm tra xem video preview hiển thị có tiếng lồng tiếng và nhạc nền loop êm ái không.
   * Bấm **Approve Job** để kiểm chứng luồng xếp lịch Đăng bài tự động.
