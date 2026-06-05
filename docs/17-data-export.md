# Kiến trúc Export Dữ liệu (toàn module, quy mô 1M+ records) — Đặc tả Production

Tài liệu này thiết kế kế hoạch triển khai tính năng **export toàn bộ dữ liệu của một module** cho một tenant (Contacts, Accounts, Deals, Tickets…), chịu được tập dữ liệu **1 triệu+ records**, **không gây nghẽn API / MongoDB** và **không ảnh hưởng đến các tenant khác**.

Kế hoạch được xây dựng để **đối xứng (symmetric) với hạ tầng Import** đã triển khai trước đó tại `src/common/import` (xem [15-contact-import.md](15-contact-import.md)). Mục tiêu kiến trúc: tổng quát hoá export thành một module dùng chung `src/common/export` theo đúng Template-Method pattern mà import đang dùng, thay vì giữ export riêng lẻ ở mức từng module như hiện tại.

> **Phiên bản:** v2 — đã hợp nhất review/phản biện. Hai thay đổi trọng yếu so với v1: (1) **Masking-in-worker được nâng từ "mục checklist" lên hạng mục kiến trúc Phase 1** (xem §6.1) vì interceptor mask hiện gắn chặt HTTP và worker không có context; (2) **Ở chế độ S3, stream thẳng lên S3 qua `lib-storage`, KHÔNG ghi file tạm ra disk** (xem §4.2).

---

## 0. TL;DR — Trả lời 3 câu hỏi cốt lõi

| Câu hỏi | Trả lời ngắn |
| --- | --- |
| **Một tenant export toàn bộ 1 module thế nào?** | Gọi `POST /v1/<module>/export` (không truyền `ids`, chỉ truyền filter rỗng) → API đẩy 1 job vào BullMQ → worker stream cursor từ Mongo, ghi từng dòng theo backpressure, upload S3/local, publish completion qua Redis Pub/Sub → client nhận link tải qua WebSocket. Trả `202 + jobId` ngay, không block request. |
| **1M records thì giải pháp là gì?** | **Streaming end-to-end**: Mongo cursor (`.lean()` + projection + `batchSize`) → mask theo từng dòng → CSV → gzip → **stream thẳng lên S3 (`lib-storage` multipart)**; chế độ local mới ghi file tạm. KHÔNG buffer toàn bộ vào RAM. Bộ nhớ phẳng (~vài chục MB) bất kể 1k hay 10M dòng. Có throttle giữa các batch + đọc từ **secondary** (có giới hạn staleness). |
| **Có gây nghẽn hệ thống / DB / tenant khác không?** | Không, nếu áp đủ các van an toàn: (1) export chạy ở **worker process** riêng; (2) **đọc từ secondary có `maxStalenessSeconds`** → giảm tải primary OLTP; (3) **throttle + batchSize** nhường CPU cho Mongo; (4) **per-tenant lock + concurrency cap + quota** → 1 tenant không chiếm hết worker; (5) **streaming** → không OOM worker. |

> ⚠️ **Hai rủi ro số 1 mà thiết kế này khắc phục:**
> 1. **OOM khi ghi (đã verify):** `ContactExportProcessor` hiện stream cursor nhưng lại **tích luỹ toàn bộ output vào mảng `lines: string[]` rồi `lines.join('\n')`** → vẫn giữ toàn bộ CSV trong RAM ([contact-export.processor.ts:61-88](../src/contacts/contact-export.processor.ts#L61-L88)). Với 1M dòng đây là nguy cơ OOM. Comment "stream to avoid OOM" chỉ đúng cho *đầu đọc*, không đúng cho *đầu ghi*.
> 2. **Rò rỉ PII do bỏ masking (đã verify):** `DataMaskingInterceptor` là **HTTP interceptor** (`context.switchToHttp().getRequest()` — [data-masking.interceptor.ts:49](../src/common/interceptors/data-masking.interceptor.ts#L49)) và đọc `userGroupId` từ CLS ([dòng 34](../src/common/interceptors/data-masking.interceptor.ts#L34)). Worker BullMQ **không có HTTP context** và `BaseTenantConsumer` **không set `userGroupId` vào CLS** ([base-tenant.consumer.ts:65-70](../src/queue/base-tenant.consumer.ts#L65-L70)) → export hiện **bypass masking hoàn toàn**. Đây là việc kiến trúc, không phải checklist (xem §6.1).

---

## 1. Phân chia công việc API & Web

### 🖥️ API (Backend — `crm-api`)

| Hạng mục | Mô tả |
| --- | --- |
| `POST /v1/<module>/export` | Nhận filter/ids + format (`csv`/`xlsx`) + columns, đẩy job vào BullMQ, trả `202 + jobId` |
| `GET /v1/<module>/export-status/:jobId` | Trạng thái job, % tiến độ (hoặc số đã xử lý), `recordCount`, `downloadUrl`, `expiresAt` |
| `GET /v1/<module>/export-jobs` | Lịch sử export của tenant (đọc từ collection `export_jobs`) |
| `POST /v1/<module>/export-jobs/:jobId/cancel` | Huỷ job đang chạy (xem §6.3) |
| `GET /v1/<module>/export-download/:token` | Tải file (chỉ dùng cho local-disk mode; S3 mode trả presigned URL trực tiếp) |
| `BaseExportProcessor` (mới) | Worker dùng chung: cursor stream → mask → transform → ghi/stream → upload → publish |
| `ExportFormatWriter` (mới) | Streaming writer cho CSV (Phase 1) và XLSX (Phase 2), backpressure-aware |
| `ExportMaskingService` (mới) | Pure service tách từ interceptor — mask field theo `userGroupId` snapshot |
| `export_jobs` collection (mới) | Lịch sử + tiến độ persistent, có TTL 90 ngày |
| Cron dọn dẹp (mới) | Reap job kẹt + temp file (xem §6.4) |
| Redis Pub/Sub | Publish `socket:<module>:export:completed` khi xong |
| WebSocket Gateway | Subscribe Redis channel, đẩy realtime tới client |

### 🌐 Web (Frontend — CRM Dashboard)

| Bước | Component | Mô tả |
| --- | --- | --- |
| 1 | **Chọn phạm vi** | "Export tất cả" / "Export theo filter hiện tại" / "Export các bản ghi đã chọn" |
| 2 | **Chọn cột & format** | Tick các cột muốn xuất, chọn CSV/XLSX; cảnh báo client nếu > 50k dòng nên dùng CSV |
| 3 | **Xác nhận & ước lượng** | Hiển thị số record ước tính (`countForExport`, có timeout) trước khi chạy |
| 4 | **Progress** | Thanh tiến độ realtime qua WebSocket (`processed/total`, hoặc chỉ `processed` nếu count timeout) |
| 5 | **Tải / Huỷ** | Khi xong: nút tải (`downloadUrl`, hạn `expiresAt`); khi đang chạy: nút huỷ |
| 6 | **Lịch sử export** | Bảng các lần export trước, tải lại nếu link còn hạn |

---

## 2. Hiện trạng & khoảng cách so với Import

### 2.1. Cross-reference codebase (đã xác minh)

| Hạng mục | File tham chiếu | Trạng thái |
| --- | --- | --- |
| Export hiện tại dùng `BaseTenantConsumer` | [contact-export.processor.ts:22](../src/contacts/contact-export.processor.ts#L22) | ✅ có, nhưng contact-only |
| Cursor stream từ Mongo | [contact-export.processor.ts:59](../src/contacts/contact-export.processor.ts#L59) | ✅ có (`streamForExport` → `.cursor()`) |
| **Output buffer toàn bộ trong RAM** | [contact-export.processor.ts:61-88](../src/contacts/contact-export.processor.ts#L61-L88) | ❌ **lỗi OOM tiềm ẩn** |
| **Masking gắn HTTP, worker không có context** | [data-masking.interceptor.ts:34,49](../src/common/interceptors/data-masking.interceptor.ts#L34) | ❌ **export bypass masking** |
| `userGroupId` KHÔNG được set trong CLS của worker | [base-tenant.consumer.ts:65-70](../src/queue/base-tenant.consumer.ts#L65-L70) | ❌ thiếu context để mask |
| Filter dùng magic key `__restrictToOwner`/`__currentUserId` | [contacts.service.ts:605-609](../src/contacts/contacts.service.ts#L605-L609) | ⚠️ cần thành contract có type |
| `buildExportFilter` áp tenant filter + index | [contact.repository.ts:360-403](../src/contacts/infrastructure/persistence/document/repositories/contact.repository.ts#L360-L403) | ✅ có |
| Dual-mode storage (S3/local) | [contact-export-storage.service.ts:72-136](../src/contacts/contact-export-storage.service.ts#L72-L136) | ✅ có `storeCsvStream` |
| `@aws-sdk/lib-storage` (multipart streaming) | `package.json` ^3.1019 | ✅ có sẵn → stream thẳng S3 |
| `exceljs` (streaming XLSX) | `package.json` ^4.4 | ✅ có sẵn (Phase 2) |
| `@nestjs/schedule` + pattern cron + lock | [orphan-cleanup.cron.ts](../src/tenants/cron/orphan-cleanup.cron.ts) | ✅ khuôn để copy cho cleanup |
| Redis Pub/Sub completion | [contact-export.processor.ts:103-112](../src/contacts/contact-export.processor.ts#L103-L112) | ✅ có |
| Worker gating qua `isWorkerRuntime()` | [contacts.module.ts:36](../src/contacts/contacts.module.ts#L36) | ✅ có |
| `EXPORT_MAX_RECORDS = 5000` | [contacts.constants.ts:12](../src/contacts/contacts.constants.ts#L12) | ⚠️ cap thấp, thay bằng hard cap theo format |
| **Generalized `BaseImportProcessor`** | [base-import.processor.ts:55](../src/common/import/base-import.processor.ts#L55) | ✅ mẫu để đối xứng cho export |
| **`ImportModuleConfig`** | [import-module-config.ts:34](../src/common/import/types/import-module-config.ts#L34) | ✅ mẫu cho `ExportModuleConfig` |
| **`ImportStorageFactory`** | [import-storage.service.ts:317](../src/common/import/import-storage.service.ts#L317) | ✅ mẫu cho `ExportStorageFactory` |
| **Ghi disk có backpressure (chống OOM)** | [import-report.service.ts:62-72](../src/common/import/import-report.service.ts#L62-L72) | ✅ mẫu kỹ thuật stream |
| **`import_jobs` schema + TTL** | [import-job.schema.ts:14-160](../src/common/import/import-job.schema.ts#L14-L160) | ✅ mẫu cho `export_jobs` |
| **Per-tenant Redis lock + heartbeat** | [base-import.processor.ts:34,182-188](../src/common/import/base-import.processor.ts#L182-L188) | ✅ mẫu cho lock export |
| **Throttle giữa batch** | [base-import.processor.ts:35,260](../src/common/import/base-import.processor.ts#L35) | ✅ mẫu cho throttle export |

### 2.2. Bảng khoảng cách (Gap Analysis)

| Năng lực | Import (đã có) | Export (hiện tại) | Cần làm cho Export |
| --- | --- | --- | --- |
| Tổng quát hoá đa module | ✅ `common/import` | ❌ chỉ Contacts | Tạo `common/export` |
| Streaming output | ✅ NDJSON writer | ❌ buffer RAM | `ExportFormatWriter` + stream thẳng S3 |
| **Masking output theo quyền** | — (import không cần) | ❌ bypass | `ExportMaskingService` + snapshot `userGroupId` |
| Lịch sử job persistent | ✅ `import_jobs` | ❌ chỉ BullMQ state | Tạo `export_jobs` + TTL |
| Per-tenant lock | ✅ `RedisLockService` | ❌ không | Lock `export:<module>:<tenant>` |
| Quota chống spam tuần tự | — | ❌ không | Queued cap + rate user/giờ |
| Huỷ job | — | ❌ không | Cancel flag + check per-batch |
| Reap job kẹt / temp rác | — | ❌ không | Cron cleanup |
| Throttle nhường CPU | ✅ 60ms/batch | ❌ không | Throttle ~50ms/batch |
| Đọc từ secondary | — | ❌ đọc primary | `secondaryPreferred` + `maxStalenessSeconds` |
| Projection + `.lean()` | — | ❌ hydrate full doc | Projection chỉ field cần xuất |
| XLSX | ✅ parser import | ❌ chỉ CSV | Streaming XLSX writer (Phase 2) |
| Concurrency cap rõ ràng | ✅ `{ concurrency: 3 }` | ❌ default | Concurrency + per-tenant cap |

---

## 3. Kiến trúc đề xuất — module dùng chung `src/common/export`

Tái lập đúng cấu trúc của `src/common/import`:

```
src/common/export/
  export.module.ts                 # @Global, cung cấp ExportStorageFactory + ExportJob model
  base-export.processor.ts         # Template-Method: pipeline stream → mask → write → upload → publish
  export-storage.service.ts        # Dual-mode S3/local + ExportStorageFactory (tổng quát hoá)
  export-progress.service.ts       # ExportProgressTracker (BullMQ progress + Mongo doc + cancel flag)
  export-masking.service.ts        # Pure masking tách từ interceptor (dùng được ngoài HTTP)
  export-job.schema.ts             # collection 'export_jobs' + index + TTL 90d
  export-cleanup.cron.ts           # reap job kẹt + temp file
  format/
    export-format.interface.ts     # interface ExportFormatWriter
    csv-export.writer.ts           # streaming CSV (RFC 4180 escape)  ← Phase 1
    xlsx-export.writer.ts          # streaming XLSX (exceljs WorkbookWriter) ← Phase 2
    export-format.factory.ts       # createWriter(format)
  types/
    export-module-config.ts        # ExportModuleConfig
    export-context.ts              # BaseExportJobData, ExportColumn, ExportFilter (typed)
    export-result.ts               # ExportResult, ExportSummary
```

Mỗi module (contacts/accounts/deals/tickets) chỉ cần:
1. Khai báo **một** `ExportModuleConfig` tĩnh (cột, formatter, queue name, channel).
2. Viết processor con extends `BaseExportProcessor`, implement vài abstract method.
3. Đăng ký queue + processor (gated bằng `isWorkerRuntime()`).

### 3.1. `ExportModuleConfig` (đối xứng `ImportModuleConfig`)

```ts
export interface ExportColumn {
  /** Tên cột trong file xuất (header). */
  header: string;
  /** Đường dẫn field trên document (hỗ trợ nested: 'owner.name'). */
  path: string;
  /** Tên field dùng để tra cấu hình masking (nếu khác path). */
  maskKey?: string;
  /** Formatter tuỳ chọn: Date→ISO, array→'a; b', ObjectId→string… */
  format?: (value: unknown, doc: unknown) => string;
}

export interface ExportModuleConfig {
  module: string;                       // 'contact' | 'account' | 'deal' | 'ticket'
  displayName: string;
  /** Tên resource để tra masking layout (vd 'Contact'). */
  maskingResource: string;
  /** Các cột mặc định; user có thể chọn tập con. */
  columns: readonly ExportColumn[];
  /** Field whitelist để chống injection khi user tự chọn cột. */
  selectableColumns: ReadonlySet<string>;
  /** Số dòng đọc mỗi lần từ cursor. Default 1000. */
  batchSize: number;
  /** Trần dòng CỨNG theo format (server reject nếu vượt). */
  hardCap: { csv: number; xlsx: number };   // vd { csv: 1_000_000, xlsx: 200_000 }
  /** ms nghỉ giữa các batch để nhường CPU cho Mongo. Default 50. */
  throttleMs: number;
  /** Bật gzip — CHỈ áp cho CSV (XLSX đã là zip, gzip lại vô ích). */
  gzipCsv: boolean;
  completionChannel: string;            // 'socket:contact:export:completed'
  queueName: string;                    // 'contact-export'
}
```

> **Thay đổi so với v1:** bỏ `maxRows` đơn lẻ + bỏ "soft limit" (warn là việc client-side); chỉ giữ **`hardCap` theo format** ở server. `gzip` → `gzipCsv` (XLSX không gzip).

### 3.2. `BaseExportProcessor` — pipeline (đối xứng `BaseImportProcessor`)

```
handle(job)
  └─ lockService.acquire(`lock:export:<module>:<tenantId>`, TTL_10m_heartbeat, runExport)

runExport(job):
  1. export_jobs.status = 'active'
  2. masker = maskingService.forGroup(job.data.userGroupId, cfg.maskingResource)  // snapshot tại enqueue
  3. estimatedTotal = countForExport(filter, { maxTimeMS: 3000 }) | null          // §4.3
  4. sink = openSink(format, cfg):                                                // §4.2
       - S3 mode  : PassThrough → (gzip nếu csv) → lib-storage Upload (multipart)
       - local mode: WriteStream(tempPath) → (gzip nếu csv)
     writer = formatFactory.createWriter(format, sink)
  5. cursor = getExportCursor(filter)            // .lean() + projection
            .read('secondaryPreferred', { maxStalenessSeconds })
            .batchSize(cfg.batchSize)
  6. await writer.writeHeader(selectedColumns)
  7. for await (const doc of cursor):
        if (processed % cfg.batchSize === 0 && await progress.isCancelled(jobId))  // §6.3
            throw new ExportCancelledError()
        masked = masker.maskDoc(doc)                                               // §6.1
        row = selectedColumns.map(c => c.format(masked[c.path], masked))
        if (!writer.writeRow(row)) await once(sink, 'drain')                       // BACKPRESSURE
        processed++
        if (processed > cfg.hardCap[format]) throw new ExportLimitExceeded()
        if (processed % cfg.batchSize === 0):
            await progress.report(job, processed, estimatedTotal)
            await delay(cfg.throttleMs)                                            // THROTTLE
  8. await writer.finalize()                     // flush + đóng sink; S3 Upload.done()
  9. upload đã hoàn tất (S3) | upload tempFile (local) → downloadUrl + expiresAt
  10. audit.log({ userId, tenantId, module, filterSnapshot, columns, recordCount, format })  // §6.2
  11. redis.publish(completionChannel, { tenantId, userId, downloadUrl, recordCount, expiresAt })
  12. export_jobs.status='completed', recordCount, downloadUrl, expiresAt
finally:
  - cursor?.close(); sink?.destroy(); xoá tempFile (local) nếu còn
```

**Abstract method mà module con phải implement** (mỏng — pipeline ở base):
- `getExportCursor(filter): Cursor` — cursor đã `.lean()`, projection, read preference.
- `getModuleConfig(): ExportModuleConfig`
- `buildFilter(jobData): ExportFilter` — chuyển `ids`/`filters`/`restrictToOwner` thành `FilterQuery` đã áp tenant filter (typed, **không magic key**).
- getter inject: `getStorage / getExportJobModel / getLockService / getRedis / getMaskingService / getAuditService`.

### 3.3. `export_jobs` schema (đối xứng `import_jobs`)

Trường chính: `tenantId, userId, userGroupId, entityType, format, status (queued|active|completed|failed|cancelled), bullJobId (unique), filterSnapshot, selectedColumns, recordCount, downloadUrl, fileExpiresAt, failedReason, cancelledAt, progress {processed,total,pct}, startedAt, completedAt`.

Index: `{ tenantId, entityType, createdAt:-1 }`, `{ bullJobId } unique`, **TTL `createdAt` 90 ngày**. Áp `tenantFilterPlugin`.

> Lưu ý: `userGroupId` được snapshot vào job để worker mask được (xem §6.1). `fileExpiresAt` (hạn file) **khác** TTL của document (90 ngày) — xem §6.5.

---

## 4. Giải pháp cho 1M+ records (chi tiết kỹ thuật)

### 4.1. Streaming end-to-end — bộ nhớ phẳng

| Tầng | Kỹ thuật | Vì sao chống OOM |
| --- | --- | --- |
| **Đọc** | Mongoose `.cursor()` + `.batchSize(1000)` + `.lean()` | Chỉ giữ ~1000 plain object trong RAM, không hydrate Document (nặng gấp 5–10×) |
| **Projection** | `.select(selectedColumns)` | Chỉ kéo field cần xuất qua network |
| **Mask** | mask từng doc tại chỗ | O(1) bộ nhớ/dòng |
| **Ghi** | writer + tôn trọng backpressure (`once(sink,'drain')`) | **Không bao giờ giữ toàn bộ output trong RAM** |
| **Nén** | gzip stream — **chỉ CSV** | Giảm 80–90% kích thước; XLSX bỏ qua vì đã là zip |
| **Upload** | xem §4.2 | Không đọc cả file vào buffer |

> Kỹ thuật ghi-có-backpressure đã chứng minh trong import tại [import-report.service.ts:62-72](../src/common/import/import-report.service.ts#L62-L72). Export tái dùng cho `ExportFormatWriter`.

**Kết quả:** export 1M dòng tiêu thụ RAM ≈ `batchSize × kích thước doc + buffer stream` ≈ **vài chục MB**, không phụ thuộc tổng số dòng.

### 4.2. Sink: stream thẳng S3, chỉ local mới ghi temp (sửa từ v1)

`@aws-sdk/lib-storage` đã có sẵn → ở chế độ S3 (production) **không cần ghi file tạm ra disk**:

```
S3 mode:    cursor → writer → [gzip nếu csv] → PassThrough → new Upload({ Body: passThrough }).done()
local mode: cursor → writer → [gzip nếu csv] → WriteStream(tempPath) → upload tempPath → xoá temp
```

Lợi ích: bỏ I/O disk thừa ở production, giảm bề mặt cleanup (temp chỉ tồn tại ở local mode), và `lib-storage` tự lo multipart cho file lớn (> 100MB).

> ⏱️ **Đính chính từ v1:** KHÔNG đặt `noCursorTimeout`. Với throttle ~50ms/batch, khoảng cách giữa các `getMore` luôn dưới timeout cursor 10 phút của Mongo nên cursor không hết hạn; đặt `noCursorTimeout` lại gây **rò cursor** nếu worker chết.

### 4.3. Tiến độ & count có timeout

- `countDocuments(filter, { maxTimeMS: 3000 })`. Nếu timeout → `estimatedTotal = null`.
- Có total: `pct = min(99, floor(processed/total*100))`.
- Không total: UI hiển thị **"Đã xử lý N bản ghi"** thay vì %. (Thay công thức sai hiện tại `recordCount/(recordCount+100)`.)

### 4.4. Chia file cho tập rất lớn (Phase 3)

Với > ~1M dòng hoặc Excel (trần 1.048.576 dòng/sheet): CSV chunk `part-001.csv…` → zip streaming; hoặc XLSX multi-sheet. Client tải 1 zip.

---

## 5. Có gây nghẽn hệ thống / DB / tenant khác không?

### 5.1. Cô lập khỏi API process
Export chạy hoàn toàn trong **worker runtime** (gated `isWorkerRuntime()` — [contacts.module.ts:36](../src/contacts/contacts.module.ts#L36)). API process chỉ enqueue và trả `202` → **request người dùng không bao giờ bị block bởi export**, kể cả 10M dòng.

### 5.2. Giảm tải MongoDB primary

| Van an toàn | Cơ chế | Tác dụng |
| --- | --- | --- |
| **Secondary read** | `read('secondaryPreferred', { maxStalenessSeconds })` | Scan đọc rơi vào replica đọc → giảm tải primary OLTP. ⚠️ `secondaryPreferred` **luôn fallback về primary** khi không có secondary (nó không fail) → xem cảnh báo bên dưới |
| **Index-backed filter** | `buildExportFilter` luôn áp `{ tenantId }` đứng đầu + compound index | Không full scan; chỉ quét dữ liệu của tenant đang export |
| **`batchSize` + throttle** | đọc 1000 dòng → nghỉ `throttleMs` | Cursor không "hút" Mongo liên tục |
| **`.lean()` + projection** | giảm payload & CPU serialize | Giảm tải Mongo + network |

> ⚠️ **Cảnh báo topology (đính chính từ v1):** vì `secondaryPreferred` không bao giờ fail, deploy single-node sẽ tạo **ảo giác cô lập** — mọi truy vấn vẫn đập vào primary. Vì vậy thêm config rõ ràng:
> ```
> EXPORT_READ_PREFERENCE=secondaryPreferred
> EXPORT_MAX_STALENESS_SECONDS=90
> EXPORT_REQUIRE_SECONDARY=false   # nếu true mà topology không có secondary → fail job sớm với message rõ
> ```
> Không tự viết monitor lag — dùng `maxStalenessSeconds` sẵn có của driver. Với export, staleness vài chục giây chấp nhận được (export vốn là snapshot một thời điểm).

### 5.3. Công bằng giữa các tenant

| Van an toàn | Cơ chế |
| --- | --- |
| **Per-tenant lock** | `lock:export:<module>:<tenantId>` (TTL 10', heartbeat) → tối đa **1 export đồng thời/module**; chống 1 user chiếm worker |
| **Concurrency cap processor** | `@Processor(queue, { concurrency: 2 })` → tối đa 2 export song song toàn hệ thống/module |
| **Quota chống spam tuần tự** | `EXPORT_MAX_QUEUED_PER_TENANT=3`, `EXPORT_MAX_PER_USER_PER_HOUR=5` (lock đã lo "active") |
| **Throttle endpoint** | `@Throttle` trên `POST /export` (giống import — [contacts.controller.ts:150-152](../src/contacts/contacts.controller.ts#L150-L152)) |
| **`hardCap` theo format** | reject export vượt trần → chống job "vô hạn" |
| **Priority thấp / worker pool riêng** | export là job nền → có thể tách pool để không cạnh tranh job nghiệp vụ (Phase 3) |

> **Đã gọn so với v1:** bỏ bớt các knob quota chưa cần (size/ngày…) — chỉ giữ queued cap + rate user/giờ cho Phase 1; bổ sung thêm khi có số liệu thật.

### 5.4. Cô lập bộ nhớ & disk worker
Streaming (§4.1, §4.2) → RAM phẳng → 1 export lớn không làm chết worker đang phục vụ tenant khác. File tạm (chỉ local mode) dọn trong `finally` + cron reap (§6.4); file kết quả có hạn ngắn (§6.5) → không phình disk.

> **Kết luận:** với đủ các van trên, export 1M+ records **không gây nghẽn** API, **giảm tải** MongoDB primary, và **không ảnh hưởng** các tenant khác. Rủi ro còn lại chủ yếu là độ trễ hoàn thành job (vài phút) — chấp nhận được vì là tác vụ nền.

---

## 6. Các hạng mục được nâng cấp sau review

### 6.1. 🔴 Masking-in-worker (hạng mục kiến trúc Phase 1, không phải checklist)
**Đã verify:** interceptor mask gắn HTTP + đọc `userGroupId` từ CLS; worker không có cả hai. Hệ quả triển khai:
1. **Tách logic mask thành `ExportMaskingService` pure** — di chuyển `getMaskedFields/applyMask/maskItem` ([data-masking.interceptor.ts:94-158](../src/common/interceptors/data-masking.interceptor.ts#L94-L158)) ra service gọi được ngoài HTTP. Interceptor cũ tái dùng service này (tránh trùng logic).
2. **Snapshot `userGroupId` (+ quyền unmask) vào `export_jobs`/job data** lúc enqueue, vì worker không tái dựng được context này.
3. **Mask tại lúc generate** từng dòng (không có tầng response để mask sau).
4. `ExportColumn.maskKey` + `ExportModuleConfig.maskingResource` để map cột → cấu hình masking đúng.

### 6.2. Audit log (bắt buộc)
Export = rò rỉ dữ liệu hàng loạt → phải audit (khác ghi chú "system action, not logged" hiện tại). Ghi: `userId, tenantId, module, filterSnapshot, selectedColumns, recordCount, format, ip/userAgent (nếu có), status, createdAt`.

### 6.3. Cancel job
Endpoint `POST /export-jobs/:jobId/cancel` → set cancel flag (Redis key theo `jobId`). Processor check `progress.isCancelled(jobId)` **mỗi batch** → `throw ExportCancelledError` → `finally` đóng cursor/sink, xoá temp, set `status='cancelled'`.

### 6.4. Cron dọn dẹp (reap job kẹt + temp rác)
Worker crash giữa chừng → `finally` không chạy → orphan. Copy khuôn [orphan-cleanup.cron.ts](../src/tenants/cron/orphan-cleanup.cron.ts) (cron + `RedisLockService` singleton):
- Xoá temp file (local mode) > 24h.
- Mark job `active` quá N giờ (vượt TTL lock) → `failed` (stale).
- Xoá file local hết hạn.

### 6.5. Ba tầng TTL (tách bạch, ưu tiên ngắn cho PII)
| Loại | Mặc định | Ghi chú |
| --- | --- | --- |
| **Presigned download URL** | 30–60 phút | Đủ cho mạng chậm/file lớn |
| **File retention** (S3 lifecycle / local) | **24h** (config tăng được) | Ngắn vì chứa PII; mâu thuẫn với giữ 1–7 ngày |
| **Job history** (`export_jobs` TTL) | 90 ngày | Chỉ metadata, không chứa dữ liệu |

### 6.6. Bảo mật khác
- `@RequirePermission('export', '<module>')` mọi endpoint ([contacts.controller.ts:108](../src/contacts/contacts.controller.ts#L108)).
- **Ownership guard** trên status/download: chỉ chủ job + đúng tenant ([contacts.service.ts:628-633](../src/contacts/contacts.service.ts#L628-L633), [contact-export-storage.service.ts:158-161](../src/contacts/contact-export-storage.service.ts#L158-L161)).
- **Permission snapshot staleness (quyết định có chủ đích):** snapshot quyền lúc enqueue; nếu user bị thu hồi quyền trong lúc job chạy, job vẫn dùng quyền cũ. Chấp nhận, ghi rõ trong tài liệu.
- Safe path/key validation cho download token (mẫu `SAFE_KEY_PATTERN` đã có).

---

## 7. Kế hoạch triển khai theo giai đoạn

### Giai đoạn 1 — CSV streaming production-ready (ưu tiên cao nhất)
1. Tạo `src/common/export` (module, types, `ExportModuleConfig`, `ExportProgressTracker`, `ExportFilter` typed).
2. Tổng quát hoá `ExportStorageService` + `ExportStorageFactory` (tách khỏi `ContactExportStorageService`).
3. `BaseExportProcessor` streaming-to-sink (sửa OOM); **S3 stream thẳng qua `lib-storage`**, local ghi temp.
4. `csv-export.writer.ts` streaming + backpressure (+ gzip CSV).
5. `export_jobs` schema + TTL.
6. **`ExportMaskingService` pure + snapshot `userGroupId`** (§6.1) — interceptor cũ tái dùng.
7. Secondary read (`maxStalenessSeconds` + `EXPORT_REQUIRE_SECONDARY`) + `.lean()` + projection + throttle + per-tenant lock.
8. Count có `maxTimeMS` + progress fallback.
9. Quota (queued cap + rate user/giờ) + cancel + cleanup cron.
10. Audit log.
11. **Refactor Contacts** sang `BaseExportProcessor` (giữ API path cũ, backward-compatible).

### Giai đoạn 2 — Mở rộng module & format ✅ (hoàn thành 2026-06-05)
12. ✅ `xlsx-export.writer.ts` (exceljs `WorkbookWriter`) + factory hỗ trợ csv+xlsx.
13. ✅ Export cho **Accounts, Deals, Tickets** (mỗi module = repo `streamForExport`/`countForExport` + 1 processor mỏng + queue + 5 endpoint).
14. ✅ `GET /export-jobs` + cancel + download cho cả 3 module, dùng chung `ExportRequestService` (enqueue+quota+audit+status+cancel+list+download).

> Ghi chú GĐ2: Contacts giữ path riêng (có restrictToOwner); 3 module mới dùng `ExportRequestService`. Hợp đồng writer đổi: format writer tự `end()` stream trong `finalize()`, sink chờ promise hoàn tất đã đăng ký sẵn (cần cho việc đóng zip của exceljs).

### Giai đoạn 3 — Quy mô cực lớn & vận hành ✅ (phần lớn hoàn thành 2026-06-05)
15. ✅ **XLSX multi-sheet rollover** — `XlsxExportWriter` tự sang sheet mới ("Export 1/2/…") khi chạm trần `EXPORT_XLSX_ROWS_PER_SHEET` (mặc định 1.000.000, dưới trần Excel 1.048.576), re-emit header mỗi sheet → 1 file .xlsx chứa số dòng tuỳ ý. ⏸️ CSV chunk → **.zip** hoãn lại (cần thêm dependency zip; CSV không có trần dòng nên stream 1 file là đủ, có thể gzip).
16. ✅ **Pool/scaling**: `EXPORT_WORKER_OPTIONS` (env `EXPORT_WORKER_CONCURRENCY`) áp cho cả 4 processor; chạy thêm replica `APP_RUNTIME=worker` (đã có script `start:worker`) để tách pool — không cần code mới.
17. ✅ **BullMQ rate limiter**: `limiter { max: EXPORT_RATE_MAX, duration: EXPORT_RATE_DURATION_MS }` trên worker export. Bull Board đã wire sẵn theo từng queue export.
18. ✅ **Load test**: `src/scripts/load-test/export-load-test.ts` (Node built-ins, dùng `sid` cookie) — trigger export, poll tiến độ, báo throughput rows/s, tuỳ chọn tải file. ⏸️ Chạy benchmark 1M/5M thực tế là việc vận hành (cần dữ liệu thật).

> **Env GĐ3:** `EXPORT_WORKER_CONCURRENCY` (2), `EXPORT_RATE_MAX` (10), `EXPORT_RATE_DURATION_MS` (60000), `EXPORT_HARD_CAP_CSV` (5M), `EXPORT_HARD_CAP_XLSX` (5M), `EXPORT_XLSX_ROWS_PER_SHEET` (1M). Trần dòng nay lấy từ `DEFAULT_EXPORT_HARD_CAP` (chung 4 module), nâng từ 1M/200k → 5M/5M vì streaming giữ RAM phẳng và XLSX đã multi-sheet.

---

## 8. Checklist nghiệm thu (Definition of Done)

- [ ] Export 1M dòng: RSS worker ổn định < 300MB suốt job (load test).
- [ ] S3 mode: **không** sinh file tạm trên disk (xác nhận stream thẳng qua `lib-storage`).
- [ ] Trong lúc export 1M dòng của tenant A: p95 latency API của tenant B **không tăng** đáng kể.
- [ ] MongoDB: xác nhận đọc rơi vào secondary (hoặc fail sớm nếu `EXPORT_REQUIRE_SECONDARY=true` mà không có).
- [ ] **Cột nhạy cảm bị mask đúng theo `userGroupId` của người export** (không bypass).
- [ ] Tenant A không thể chạy 2 export đồng thời cùng module (lock hoạt động).
- [ ] Cancel job: dừng trong ≤ 1 batch, đóng cursor/sink, xoá temp.
- [ ] Worker bị kill giữa chừng: cron reap job kẹt → `failed` và dọn temp.
- [ ] Download URL hết hạn đúng; token tenant khác bị từ chối (403); file bị xoá sau retention.
- [ ] Mỗi lần export được ghi audit log.
- [ ] 4 module dùng chung `BaseExportProcessor`, không lặp code pipeline.

---

## 9. Phụ lục — Đối chiếu Import ↔ Export

| Thành phần Import | Thành phần Export tương ứng | Ghi chú |
| --- | --- | --- |
| `BaseImportProcessor` | `BaseExportProcessor` | Template-Method, pipeline ở base |
| `ImportModuleConfig` | `ExportModuleConfig` | 1 config tĩnh/module |
| `ImportStorageFactory` | `ExportStorageFactory` | namespace `exports/<module>` |
| `ImportProgressTracker` | `ExportProgressTracker` | + cancel flag |
| `ImportReportWriter` (NDJSON→disk) | `ExportFormatWriter` (rows→sink) | cùng kỹ thuật backpressure |
| `import_jobs` + TTL | `export_jobs` + TTL | lịch sử persistent |
| Per-tenant import lock | Per-tenant export lock | chống đồng thời/spam |
| Throttle 60ms/batch | Throttle ~50ms/batch | nhường CPU Mongo |
| `openImportStream` (đọc file lên) | `getExportCursor` (đọc DB ra) | hướng dữ liệu ngược nhau |
| `bulkWrite` (ghi DB) | `writeRow` (ghi file/stream) | hướng dữ liệu ngược nhau |
| (không cần masking) | `ExportMaskingService` | **export-only** — rò rỉ PII hàng loạt |
| Redis `import:completed` | Redis `export:completed` | cùng cơ chế Pub/Sub→WS |

> Export là **ảnh phản chiếu** của Import: import = *file → DB* (ghi nặng, cần dedup/validate), export = *DB → file* (đọc nặng, cần streaming/throttle/**masking**). Dùng chung tối đa hạ tầng (storage, lock, progress, job schema, Pub/Sub, worker gating) để giảm chi phí bảo trì và đảm bảo hành vi nhất quán hai chiều.
