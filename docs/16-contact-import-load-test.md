# Kịch bản Load Test — Contact Import

Tài liệu vận hành chi tiết cho việc load test tính năng Import Contact (xem [15-contact-import.md](./15-contact-import.md)). Đi kèm bộ script tự động trong [`src/scripts/load-test/`](../src/scripts/load-test/).

> Mục tiêu: xác minh 3 KPI từ đặc tả — throughput, memory worker < 500MB, và index `IXSCAN` (không `COLLSCAN`) — trên môi trường staging tương đương production.

---

## 0. Bộ script

| File | Loại | Mục đích |
| ---- | ---- | -------- |
| `src/scripts/generate-import-test-data.ts` | CLI + lib | Sinh CSV test (preset/số dòng tùy ý, `--dup`, `--offset`) |
| `src/scripts/load-test/import-load-client.ts` | lib | Client HTTP dùng chung: upload → start → poll, đo timing |
| `src/scripts/load-test/scenario-a-clean-insert.ts` | Kịch bản A | 100k clean insert, KPI < 90s |
| `src/scripts/load-test/scenario-b-dedup-merge.ts` | Kịch bản B | 100k với ~50% trùng, merge, KPI < 180s |
| `src/scripts/load-test/scenario-c-concurrent.ts` | Kịch bản C | 5 import đồng thời × 20k, không OOM, không trùng |
| `src/scripts/load-test/verify-index.js` | mongosh | Xác minh dedup query dùng `IXSCAN` |
| `src/scripts/load-test/monitor-worker-memory.sh` | bash | Lấy mẫu RSS worker trong lúc test |

---

## 1. Chuẩn bị môi trường

### 1.1 Hạ tầng (theo đặc tả)
- Container worker giới hạn tương đương production: **1 CPU, 2GB RAM**.
- MongoDB **replica set** (giống production), đã có sẵn 2 index:
  `{ tenantId:1, emails:1 }` và `{ tenantId:1, phones:1 }` (`tenant_phone_lookup`).
- API + Worker chạy với Redis/BullMQ. Worker bật bằng:
  ```bash
  APP_RUNTIME=worker node dist/worker      # hoặc: npm run start:worker:prod
  ```
- Đảm bảo `ContactImportProcessor` đã được nạp (chỉ chạy trên runtime `worker`).

### 1.2 Biến môi trường cho load test

| Biến | Bắt buộc | Ví dụ / mặc định | Ghi chú |
| ---- | :------: | ---------------- | ------- |
| `CRM_BASE_URL` | ✅ | `https://acme.crmsaudi.dev/api/v1` | **Không** có dấu `/` cuối. Subdomain xác định tenant |
| `CRM_SID` | ✅* | `s%3Aabc123...` | Giá trị cookie `sid` của phiên đăng nhập |
| `CRM_COOKIE` | ✅* | `sid=s%3Aabc123...` | Thay cho `CRM_SID` nếu cần gửi nhiều cookie |
| `CRM_INSECURE_TLS` | – | `1` | Cho phép cert tự ký trên staging |
| `CRM_POLL_MS` | – | `2000` | Chu kỳ poll status |
| `CRM_TIMEOUT_MS` | – | `1800000` | Timeout chờ job (mặc định 30 phút) |

\* Cần **một trong hai** `CRM_SID` hoặc `CRM_COOKIE`.

### 1.3 Lấy cookie `sid`
API resolve tenant + user từ cookie phiên (`TenantInterceptor`). Cách lấy:
1. Đăng nhập CRM trên trình duyệt bằng tài khoản có quyền `create` trên `contacts`.
2. DevTools → Application → Cookies → chọn domain → copy giá trị cookie tên `sid`.
3. Export:
   ```bash
   export CRM_BASE_URL="https://acme.crmsaudi.dev/api/v1"
   export CRM_SID="<dán-giá-trị-sid>"
   # nếu staging dùng cert tự ký:
   export CRM_INSECURE_TLS=1
   ```

> Cookie phiên có hạn — nếu nhận `HTTP 401` giữa chừng, lấy lại `sid` mới.

---

## 2. Kịch bản A — Clean Insert (100k, không trùng)

**Mục tiêu:** đo throughput đường ghi thuần (stream → bulkWrite), không dedup.
**KPI:** hoàn thành **< 90 giây**, heap worker **< 500MB**.

```bash
# Tab 1 — giám sát memory worker (xem mục 5)
./src/scripts/load-test/monitor-worker-memory.sh

# Tab 2 — chạy kịch bản
npx ts-node src/scripts/load-test/scenario-a-clean-insert.ts
```

- Script tự sinh `files/tmp/loadtest/a-clean-100000.csv` rồi upload + import (không dedup).
- Smoke nhanh: `ROWS=10000 npx ts-node ...`.
- In ra: thời gian import, throughput (rows/s), summary, và PASS/FAIL theo KPI.

> ⚠️ Clean insert giả định tenant **chưa có** contact trùng. Chạy lại nhiều lần sẽ tạo bản ghi lặp — hãy clear collection (hoặc dùng tenant test riêng) giữa các lần để số liệu chuẩn.

---

## 3. Kịch bản B — Dedup nặng / Merge (100k, 50% trùng)

**Mục tiêu:** đo chi phí dedup (query `$in` theo batch) + đường update merge.
**KPI:** hoàn thành **< 180 giây**.

```bash
npx ts-node src/scripts/load-test/scenario-b-dedup-merge.ts
```

- Sinh `b-merge-100000-dup50.csv` (~50% dòng trùng email/phone của dòng trước).
- Import với `deduplication: { matchingFields: ['emails','phones'], policy: 'merge' }`.
- Tùy chỉnh: `ROWS=50000 DUP=30 KPI_MS=90000 npx ts-node ...`.
- Kết quả mong đợi: `inserted` ≈ số dòng duy nhất, `updated`/`skipped` phản ánh phần trùng.

---

## 4. Kịch bản C — Đồng thời cùng tenant (5 × 20k)

**Mục tiêu:** xác minh **`RedisLockService` per-tenant serialize** các job → dedup không bỏ sót bản ghi đang bay → **không tạo trùng**; BullMQ tiếp tục rút hàng đợi, worker **không OOM**.
**KPI:** tất cả job `completed`, `total inserted == JOBS × ROWS`, `errors == 0`.

```bash
# Tab 1 — giám sát memory
./src/scripts/load-test/monitor-worker-memory.sh
# Tab 2
npx ts-node src/scripts/load-test/scenario-c-concurrent.ts
```

- Sinh 5 file dữ liệu **khác nhau** (offset từng file) để mỗi job ghi contact riêng.
- Bắn 5 request `POST /import` đồng thời, poll cả 5 tới khi xong, in từng job + tổng hợp.
- Vì lock per-tenant, các job chạy **tuần tự** cho cùng một tenant → `wall-clock ≈ tổng thời gian import`. Đây là hành vi đúng (chống starvation), không phải lỗi.
- Tùy chỉnh: `JOBS=5 ROWS=20000 npx ts-node ...`.

> Muốn test trùng lặp khi đồng thời (đảm bảo không sinh duplicate dù dedup): cho các file **trùng** dải identity (bỏ offset) và kiểm tra `inserted` tổng vẫn = số identity duy nhất.

---

## 5. Giám sát Memory Worker (KPI < 500MB)

```bash
# Tự dò tiến trình "dist/worker"
./src/scripts/load-test/monitor-worker-memory.sh

# Chỉ định thủ công
PID=12345 ./src/scripts/load-test/monitor-worker-memory.sh
PATTERN="entryFile worker" INTERVAL=1 OUT=/tmp/mem.csv ./src/scripts/load-test/monitor-worker-memory.sh
```

- Ghi `timestamp,rss_mb,cpu_pct` ra CSV và in **peak RSS** khi dừng (Ctrl-C).
- **Đạt** khi peak RSS giữ dưới ~500MB suốt quá trình stream (kể cả file 1M dòng).
- Nếu RSS tăng tuyến tính theo số dòng → nghi rò rỉ (stream không destroy, hoặc tích lũy mảng lỗi trong RAM — đã phòng bằng NDJSON tạm trên đĩa).

---

## 6. Xác minh Index (IXSCAN, không COLLSCAN)

```bash
TENANT_ID=<24-hex-tenant-id> \
mongosh "mongodb://localhost:27017/<db>" --file src/scripts/load-test/verify-index.js

# Tùy chọn override giá trị mẫu khớp dữ liệu test:
SAMPLE_EMAIL=user1@example.com SAMPLE_PHONE=+84910000001 \
TENANT_ID=... mongosh "<uri>" --file src/scripts/load-test/verify-index.js
```

Script sẽ:
1. Liệt kê index trên `contacts`, xác nhận tồn tại `{ tenantId:1, emails:1 }` và `tenant_phone_lookup`.
2. Chạy `explain('executionStats')` đúng shape dedup query của processor:
   ```js
   { tenantId, deletedAt: { $exists:false }, $or: [{ emails:{$in:[...]} }, { phones:{$in:[...]} }] }
   ```
3. In `totalDocsExamined / totalKeysExamined / nReturned / executionTimeMs` và **PASS/FAIL** (PASS khi plan có `IXSCAN`, không `COLLSCAN`).

> `totalDocsExamined` nên xấp xỉ `nReturned` (không quét thừa). Nếu thấy `COLLSCAN` → kiểm tra index có bị xóa nhầm, hoặc dedup đang dùng custom field không có index (xem bottleneck #1 trong doc 15).

---

## 7. Quy trình chạy đầy đủ (gợi ý)

```bash
cd crm-api
export CRM_BASE_URL="https://acme.crmsaudi.dev/api/v1"
export CRM_SID="<sid>"
export CRM_INSECURE_TLS=1   # nếu cần

# 1) (1 lần) Xác minh index trước khi đo
TENANT_ID=<id> mongosh "<uri>" --file src/scripts/load-test/verify-index.js

# 2) A — clean insert (kèm monitor memory ở tab khác)
npx ts-node src/scripts/load-test/scenario-a-clean-insert.ts

# 3) B — dedup merge
npx ts-node src/scripts/load-test/scenario-b-dedup-merge.ts

# 4) C — concurrent
npx ts-node src/scripts/load-test/scenario-c-concurrent.ts
```

Mỗi script trả **exit code 0 = PASS, 1 = FAIL** → tiện cắm vào CI/script tổng.

---

## 8. Bảng KPI tổng hợp

| Kịch bản | Dữ liệu | Cấu hình | KPI thời gian | KPI khác |
| -------- | ------- | -------- | ------------- | -------- |
| A | 100k, 0% trùng | no dedup | < 90s | heap < 500MB |
| B | 100k, ~50% trùng | dedup emails+phones, merge | < 180s | heap < 500MB |
| C | 5 × 20k distinct | dedup merge, đồng thời | tất cả `completed` | inserted = 100k, errors = 0, không OOM |
| Index | — | dedup query | — | `IXSCAN`, không `COLLSCAN` |

---

## 9. Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách xử lý |
| ----------- | ------------------------ |
| `HTTP 401` | Cookie `sid` hết hạn / sai tenant subdomain → lấy lại `sid` |
| `HTTP 403` | Tài khoản thiếu quyền `create` trên `contacts` |
| `HTTP 429` | Vượt rate limit (`POST /import` giới hạn 3/60s) → đợi rồi chạy lại |
| `upload failed: HTTP 400` | Sai định dạng/quá 50MB, hoặc thiếu header trong file |
| Job kẹt `waiting` mãi | Worker chưa chạy (`APP_RUNTIME=worker`) hoặc đang bị lock tenant bởi job khác |
| `self signed certificate` | Đặt `CRM_INSECURE_TLS=1` |
| Memory tăng tuyến tính | Kiểm tra stream cleanup / report NDJSON; xem bottleneck #5, #6 trong doc 15 |
| Throughput thấp bất thường | Chạy mục 6 — có thể dedup đang `COLLSCAN`; hoặc `triggerAutomations` đang bật |

---

## 10. Dọn dẹp

- File test nằm ở `files/tmp/loadtest/` — xóa sau khi đo: `rm -rf files/tmp/loadtest`.
- File upload/report của import được dọn theo TTL (xem cơ chế cleanup chung). Nếu chạy nhiều, kiểm tra `files/imports/` và `files/tmp/`.
- Với kịch bản A (clean insert), nhớ xóa contact đã tạo hoặc dùng tenant test riêng để lần đo sau không bị lệch.
