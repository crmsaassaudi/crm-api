# 📡 Hướng Dẫn Cấu Hình Module Phân Bổ Hội Thoại (Omni-Channel Routing)

> **Phiên bản:** 2.0 | **Cập nhật:** Tháng 4/2026

---

## Mục lục

1. [Tổng quan](#1-tổng-quan)
2. [Cấu hình Toàn cục](#2-cấu-hình-toàn-cục)
3. [Quy tắc Phân bổ](#3-quy-tắc-phân-bổ)
4. [Năng lực Agent](#4-năng-lực-agent)
5. [Tự động Điều phối lại](#5-tự-động-điều-phối-lại)
6. [Ví dụ thực tế](#6-ví-dụ-thực-tế)
7. [Câu hỏi thường gặp](#7-câu-hỏi-thường-gặp)

---

## 1. Tổng quan

Module **Phân bổ Hội thoại** giúp hệ thống tự động phân công tin nhắn đến từ khách hàng (qua Facebook, Zalo, WhatsApp, ...) tới đúng agent phù hợp theo các tiêu chí bạn định sẵn.

### Luồng xử lý

```
Tin nhắn đến
     │
     ▼
[Khớp Quy tắc Phân bổ?]
     │ Có          │ Không
     ▼             ▼
Áp dụng Team   Dùng cấu hình
& Chiến lược   mặc định
     │             │
     └──────┬───────┘
            ▼
   [Chọn Agent theo chiến lược]
            │
            ▼
     Giao hội thoại
```

### Điều hướng đến module

1. Đăng nhập CRM → **Cài đặt** (⚙️)
2. Chọn mục **Omni-Channel** trong menu trái
3. Chọn tab **Phân bổ & Định tuyến**

---

## 2. Cấu hình Toàn cục

> **Vị trí:** Khu vực **Cấu hình Phân bổ Tổng quan** (phần trên cùng của trang)

Đây là thiết lập mặc định áp dụng cho toàn bộ hội thoại khi không có quy tắc nào khớp.

### 2.1 Chiến lược Phân bổ Mặc định

| Chiến lược | Mô tả | Phù hợp khi |
|---|---|---|
| **Round Robin** | Phân bổ lần lượt theo vòng tròn | Team có năng lực đều nhau |
| **Least Busy** | Ưu tiên agent có ít hội thoại nhất | Muốn cân bằng tải tự nhiên |
| **Capacity-Based** | Như Least Busy nhưng có giới hạn tối đa | Cần kiểm soát chặt số lượng chat |
| **Sticky** | Ưu tiên agent đã từng hỗ trợ khách này | Muốn tăng trải nghiệm khách hàng |
| **Manual** | Không tự động phân bổ, đưa vào hàng chờ | Cần trưởng nhóm phân công thủ công |

**Cách cấu hình:**
1. Trong **Chiến lược Mặc định**, chọn chiến lược phù hợp từ dropdown
2. Nhấn **Lưu cấu hình**

---

### 2.2 Giới hạn Hội thoại Tối đa

Số lượng hội thoại tối đa mỗi agent có thể xử lý đồng thời.

- **Mặc định:** 10 hội thoại/agent
- **Phạm vi:** 1–50

> 💡 **Lưu ý:** Mỗi agent có thể tự cấu hình giới hạn riêng trong hồ sơ cá nhân. Giới hạn cá nhân sẽ được ưu tiên hơn giá trị toàn cục này.

---

### 2.3 Phân bổ Theo Kỹ năng (Skill-Based Routing)

Khi bật tính năng này, hệ thống chỉ phân bổ hội thoại tới agent có đủ kỹ năng phù hợp (ví dụ: `tiếng-anh`, `billing`, `kỹ-thuật`).

**Cách cài kỹ năng cho agent:**
1. Vào **Cài đặt → Người dùng**
2. Chọn agent cần cấu hình → **Chỉnh sửa**
3. Thêm các kỹ năng vào mục **Kỹ năng Omni-Channel**

---

### 2.4 Sticky Routing (Định tuyến Dính)

Khi bật, hệ thống ưu tiên giao hội thoại cho **agent đã từng hỗ trợ khách hàng này** trong quá khứ.

| Tùy chọn | Mô tả |
|---|---|
| **Bật/Tắt Sticky** | Bật/tắt toàn bộ tính năng |
| **Thời gian hết hạn (giờ)** | Sau bao nhiêu giờ thì không còn ưu tiên agent cũ (mặc định: 72h) |
| **Thời gian chờ (phút)** | Nếu agent cũ đang bận, chờ tối đa bao nhiêu phút trước khi phân bổ sang agent khác (mặc định: 3 phút) |
| **Chiến lược dự phòng** | Nếu sticky thất bại, dùng chiến lược nào (mặc định: Least Busy) |

**Ví dụ:** Nếu khách hàng A từng chat với agent Lan (3 ngày trước), khi A nhắn tin lại:
- Hệ thống tìm Lan → Lan đang online và có slot → **Giao cho Lan** ✅
- Lan bận → chờ 3 phút → Lan vẫn bận → **Phân bổ cho agent khác** theo Least Busy

---

## 3. Quy tắc Phân bổ

> **Vị trí:** Khu vực **Quy tắc Phân bổ** (phần giữa trang)

Quy tắc cho phép bạn định tuyến khác nhau cho từng kênh, loại khách hàng, hoặc nội dung tin nhắn.

> ⚠️ **Quan trọng:** Quy tắc được đánh giá **theo thứ tự ưu tiên** (số nhỏ = ưu tiên cao hơn). Quy tắc đầu tiên khớp sẽ được áp dụng, các quy tắc còn lại bị bỏ qua.

### 3.1 Tạo Quy tắc Mới

1. Nhấn **+ Thêm Quy tắc**
2. Điền tên quy tắc (ví dụ: `Facebook VIP`)
3. Cấu hình **Điều kiện** (Conditions)
4. Cấu hình **Hành động** (Actions)
5. Nhấn **Lưu**

---

### 3.2 Điều kiện (Conditions)

Bạn có thể thêm một hoặc nhiều điều kiện cho mỗi quy tắc.

**Chế độ khớp:**
- **Tất cả (AND):** Tất cả điều kiện phải đúng
- **Bất kỳ (OR):** Chỉ cần một điều kiện đúng

**Các trường điều kiện:**

| Trường | Ý nghĩa | Ví dụ giá trị |
|---|---|---|
| `channel` | Kênh nhắn tin | `facebook`, `zalo`, `whatsapp` |
| `tag` | Thẻ của hội thoại | `VIP`, `urgent`, `billing` |
| `customer_name` | Tên khách hàng | `VIP Customer` |
| `content` | Nội dung tin nhắn đầu tiên | `khiếu nại`, `hoàn tiền` |
| `segment` | Phân khúc khách hàng | `VIP`, `Normal` |
| `time` | Giờ gửi tin (định dạng HH:mm) | `08:00`, `22:00` |

**Toán tử:**

| Toán tử | Ý nghĩa | Ví dụ |
|---|---|---|
| `Bằng (eq)` | Khớp chính xác (không phân biệt hoa/thường) | channel = `facebook` |
| `Chứa (contains)` | Chứa chuỗi con | content chứa `hoàn tiền` |
| `Thuộc danh sách (in)` | Nằm trong danh sách (cách nhau bằng dấu phẩy) | channel thuộc `facebook, zalo` |
| `Bắt đầu bằng (starts_with)` | Bắt đầu với chuỗi | customer_name bắt đầu `VIP` |

---

### 3.3 Hành động (Actions)

Khi quy tắc khớp, hệ thống sẽ:

| Hành động | Mô tả |
|---|---|
| **Team (Nhóm)** | Phân bổ cho agent thuộc nhóm/team được chọn |
| **Chiến lược** | Dùng chiến lược này thay cho mặc định |
| **Kỹ năng yêu cầu** | Chỉ chọn agent có kỹ năng phù hợp |

---

### 3.4 Quản lý Thứ tự

- Kéo-thả (drag & drop) các quy tắc để thay đổi thứ tự ưu tiên
- Nhấn biểu tượng **≡** để kéo

### 3.5 Bật / Tắt Quy tắc

Mỗi quy tắc có toggle bật/tắt. Quy tắc bị tắt sẽ bị bỏ qua hoàn toàn.

---

## 4. Năng lực Agent

> **Vị trí:** Khu vực **Năng lực Agent** (cuối phần giữa trang)

Bảng này hiển thị danh sách tất cả agent và giới hạn hội thoại của từng người.

| Cột | Ý nghĩa |
|---|---|
| **Agent** | Tên và email của agent |
| **Giới hạn hiện tại** | Số hội thoại tối đa agent đang thiết lập |
| **Chỉnh sửa** | Click để thay đổi giới hạn cho agent đó |

> 💡 Agent có giới hạn = 0 sẽ **không nhận** hội thoại tự động (hữu ích khi agent đang bận họp hoặc nghỉ phép).

---

## 5. Tự động Điều phối lại

> **Vị trí:** Khu vực **Tự động Điều phối lại** (cuối trang)

Tính năng này tự động chuyển hội thoại của agent offline sang agent khác, đảm bảo khách hàng không bị bỏ lỡ.

### 5.1 Bật/Tắt

Toggle **Bật tự động điều phối lại** để kích hoạt/vô hiệu hóa.

> ⚠️ Khi tắt, nếu agent đột ngột offline, hội thoại của họ sẽ **không** được chuyển tự động.

### 5.2 Thời gian chờ (Timeout)

Số phút chờ sau khi agent offline trước khi bắt đầu điều phối lại.

- **Mặc định:** 3 phút
- **Khuyến nghị:** 2–5 phút (đủ để agent reconnect nếu chỉ mất mạng tạm thời)

### 5.3 Chiến lược Điều phối lại

| Chiến lược | Hành động | Phù hợp khi |
|---|---|---|
| **Đưa về hàng chờ** | Bỏ gán agent, hội thoại trở thành "chờ phân bổ" | Muốn trưởng nhóm xem xét trước |
| **Agent tiếp theo** | Tự động phân bổ cho agent online phù hợp (round-robin) | Muốn liên tục, không gián đoạn |
| **Supervisor** | Chuyển vào hàng chờ thủ công của supervisor | Hội thoại quan trọng, cần giám sát |

### 5.4 Thông báo cho Agent

Khi bật, agent gốc sẽ nhận thông báo khi hội thoại của họ được chuyển sang người khác.

### 5.5 Lưu cấu hình

Nhấn **Lưu cấu hình** (góc phải của section) sau khi hoàn tất thay đổi.

---

## 6. Ví dụ thực tế

### Tình huống 1: Công ty có 2 team — Sales và Support

**Mục tiêu:**
- Khách hỏi qua Facebook → Nhóm Sales
- Khách gửi từ khóa "sự cố"/"lỗi" → Nhóm Support
- Còn lại → Round-Robin toàn bộ

**Cấu hình Quy tắc:**

| Ưu tiên | Tên | Điều kiện | Hành động |
|---|---|---|---|
| 1 | Facebook Sales | channel = `facebook` | Team: Sales, Chiến lược: Round-Robin |
| 2 | Support Urgent | content chứa `sự cố` HOẶC `lỗi` | Team: Support, Chiến lược: Least-Busy |

**Cấu hình Toàn cục:**
- Chiến lược mặc định: Round-Robin

---

### Tình huống 2: Doanh nghiệp phục vụ khách VIP

**Mục tiêu:**
- Khách có tên bắt đầu "VIP" → Team chuyên biệt, Sticky Routing
- Các khách khác → Capacity-Based

**Cấu hình Quy tắc:**

| Ưu tiên | Tên | Điều kiện | Hành động |
|---|---|---|---|
| 1 | VIP Customers | customer_name bắt đầu `VIP` | Team: VIP Team, Chiến lược: Sticky |

**Cấu hình Toàn cục:**
- Chiến lược mặc định: Capacity-Based
- Sticky Wait Time: 5 phút

---

### Tình huống 3: Hỗ trợ đa ngôn ngữ

**Mục tiêu:**
- Khách nhắn tiếng Anh → Agent có kỹ năng `english`
- Khách nhắn tiếng Nhật → Agent có kỹ năng `japanese`

**Cấu hình Quy tắc:**

| Ưu tiên | Tên | Điều kiện | Hành động |
|---|---|---|---|
| 1 | English Support | content chứa `hello` HOẶC `hi` | Kỹ năng yêu cầu: `english` |
| 2 | Japanese Support | content chứa `こんにちは` | Kỹ năng yêu cầu: `japanese` |

> 💡 Kết hợp bật **Phân bổ Theo Kỹ năng** trong Cấu hình Toàn cục.

---

## 7. Câu hỏi thường gặp

**Q: Quy tắc của tôi không có tác dụng, là sao?**
> Kiểm tra: (1) Toggle của quy tắc đã bật chưa? (2) Thứ tự ưu tiên — có quy tắc nào khác ưu tiên cao hơn và đã khớp trước không? (3) Điều kiện đã đúng chính tả chưa (ví dụ: `facebook` viết thường)?

**Q: Tại sao hội thoại vào hàng chờ thay vì được phân bổ?**
> Nguyên nhân thường gặp: (1) Tất cả agent đang offline, (2) Tất cả agent đã đạt giới hạn hội thoại tối đa, (3) Chiến lược đang đặt là Manual.

**Q: Sticky Routing có hoạt động khi khách nhắn từ kênh khác không?**
> Có — hệ thống nhận diện khách qua dữ liệu Contact, không phụ thuộc kênh. Nếu cùng một Contact, Sticky sẽ ưu tiên agent cũ dù kênh khác nhau.

**Q: Agent của tôi có thể từ chối hội thoại được phân bổ tự động không?**
> Có. Agent có thể chuyển hội thoại sang agent khác hoặc đưa về hàng chờ từ giao diện làm việc.

**Q: Tự động điều phối lại có ảnh hưởng đến lịch sử hội thoại không?**
> Không — toàn bộ lịch sử hội thoại được giữ nguyên. Agent mới tiếp nhận vẫn thấy đầy đủ ngữ cảnh.

**Q: Có thể tắt tự động điều phối lại cho riêng một team không?**
> Hiện tại cấu hình áp dụng cho toàn tenant. Tính năng cấu hình theo phòng ban đang được phát triển.

---

## Hỗ trợ

Nếu bạn cần hỗ trợ thêm, vui lòng liên hệ:
- 📧 **Email:** support@crmplatform.com
- 💬 **Live Chat:** Nhấn biểu tượng chat ở góc phải màn hình
- 📖 **Knowledge Base:** docs.crmplatform.com

---

*Tài liệu này được cập nhật theo phiên bản hệ thống. Vui lòng kiểm tra phiên bản mới nhất tại cổng tài liệu.*
