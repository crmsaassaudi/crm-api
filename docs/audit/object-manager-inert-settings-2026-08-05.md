# Object Manager — 15 khoá cấu hình không có người đọc

**Ngày lập:** 2026-08-05 · **Trạng thái:** cần audit + quyết định phạm vi · **Người lập:** đợt remediation Object Manager 2026-08-04

## Vấn đề

Object Manager có các tab "Advanced" cho từng object. Màn hình lưu được, tải lại
đúng, hiện toast thành công — và **không có mã nào ở server đọc giá trị đã lưu**.
Người vận hành tắt một switch, hệ thống báo đã lưu, hành vi không đổi.

Đây không phải một bug để vá. Mỗi khoá là một quyết định riêng: cấp cho nó một
người đọc, hay xoá nó khỏi giao diện. Tài liệu này chốt hiện trạng đã kiểm bằng
mã, để lần audit sau không phải dò lại từ đầu.

Đợt remediation 2026-08-04 **cố ý không sửa nhóm này** — nó sửa phần cấu hình có
người đọc nhưng đọc sai (field registry, FLS, picklist store). Ranh giới đó vẫn giữ.

## Cách tái kiểm

Danh mục khoá nằm ở `DEFAULTS_MAP` — [tenant-settings-seeding.service.ts:1578](../../src/crm-settings/tenant-settings-seeding.service.ts).
Ghi được khoá nào thì `assertKnownSettingKey` quyết định — [settings-keys.ts:36](../../src/crm-settings/settings-keys.ts).

Đếm người đọc thật của một khoá (loại trừ chính file seeding):

```powershell
cd crm-api\src
$all = Get-ChildItem -Recurse -Include *.ts |
       Where-Object { $_.FullName -notmatch 'tenant-settings-seeding' }
Select-String -Path $all -Pattern "'task_advanced'" -SimpleMatch
```

Kết quả rỗng = khoá trơ. Toàn bộ bảng dưới đây dựng từ lệnh này (2026-08-05),
đối chiếu với schema Mongoose thật và với các hàm gọi ở `crm-web`.

## Bảng hiện trạng

`W` = có màn hình ghi giá trị · `R` = có mã server đọc giá trị · `Cap` = năng lực
nền (schema/collection/module) đã tồn tại chưa.

| # | Khoá | W | R | Cap | Phân loại |
|---|------|:-:|:-:|:---:|-----------|
| 1 | `contact_relationship` | ✅ | ❌ | ✅ | nối dây |
| 2 | `contact_communication` | ✅ | ❌ | ✅ | nối dây |
| 3 | `contact_roles` | ❌ | ❌ | ◐ | nối dây |
| 4 | `contact_assignment` | ✅ | ❌ | ✅ | **cấu hình tranh chấp** |
| 5 | `contact_conversion` | ❌ | ❌ | ❌ | tính năng thiếu |
| 6 | `deal_forecasting` | ✅ | ❌ | ◐ | tính năng thiếu |
| 7 | `deal_sales_goals` | ✅ | ❌ | ❌ | tính năng thiếu |
| 8 | `account_structure` | ✅ | ❌ | ❌ | tính năng thiếu |
| 9 | `account_classification` | ✅ | ❌ | ◐ | **split-brain** |
| 10 | `account_territory` | ✅ | ❌ | ❌ | tính năng thiếu |
| 11 | `account_financial` | ✅ | ❌ | ◐ | tính năng thiếu |
| 12 | `task_advanced` | ✅ | ❌ | ◐ | **split-brain (lỗi sống)** |
| 13 | `ticket_category` | ✅ | ❌ | ✅ | thiếu kiểm tra |
| 14 | `ticket_resolution` | ❌ | ❌ | ✅ | mã chết |
| 15 | `ticket_type` | ❌ | ❌ | ✅ | mã chết |

Đợt trước ghi nhận **14** khoá. Con số đúng là **15**: `ticket_type` cùng hình
dạng với `ticket_resolution` và lúc đó chưa được kiểm riêng.

## Ba lớp, ba cách xử lý khác nhau

**Split-brain (#9, #12) — làm trước.** Blob ghi vào một kho, runtime kiểm ở kho
khác. Đây là đúng lỗi mà đợt 2026-08-04 đã đóng cho status/source, nhưng migration
chỉ bao `*_lifecycle` và `*_source`; categories và accountTypes lọt ra ngoài. Có
hậu quả nhìn thấy được, không chỉ là bất động.

**Mã chết (#14, #15) — xoá, không cần quyết định sản phẩm.** Blob không ai ghi,
không ai đọc, collection mới là thẩm quyền.

**Còn lại — cần anh chốt phạm vi.** "Nối dây" là 1–2 giờ mỗi khoá. "Tính năng
thiếu" là sprint, vì năng lực nền chưa có.

---

## Chi tiết từng khoá

### 1. `contact_relationship` — nối dây

`{ relationshipModel: 'one_to_one'|'one_to_many', contactHierarchyEnabled }` —
[seeding:184](../../src/crm-settings/tenant-settings-seeding.service.ts).
Ghi bởi `AdvancedContactSettingsPage.tsx:162,176`.

Năng lực **đã có đủ**: `contact_relations` với `CONTACT_RELATION_TYPES` và bảng
nghịch đảo — [contact-relation.schema.ts:15](../../src/contacts/relations/contact-relation.schema.ts);
`account_contact_relations` cho quan hệ người↔công ty.

- `relationshipModel: 'one_to_one'` phải chặn contact thứ hai gắn cùng account —
  hiện `account-contact-relation` không kiểm gì.
- `contactHierarchyEnabled: false` phải ẩn/khoá tab quan hệ và chặn API tạo quan hệ.

**Cần chốt:** `one_to_one` áp dụng cho dữ liệu đã có nhiều quan hệ thì xử lý sao —
chặn tạo mới thôi, hay báo lỗi dữ liệu cũ?

### 2. `contact_communication` — nối dây

`{ emailOptInTracking, smsOptInTracking, doNotCallFlag, gdprConsentTracking }` —
[seeding:189](../../src/crm-settings/tenant-settings-seeding.service.ts).

Trường tương ứng **đã có trên contact**: `emailOptIn:76`, `smsOptIn:79`,
`doNotCall:82` — [contact.schema.ts](../../src/contacts/infrastructure/persistence/document/entities/contact.schema.ts).
Vậy 3 cờ này chỉ quyết định *hiện trường hay không*, và đó là việc `layout_settings`
đã làm được rồi (`accessLevel: hidden`).

**Cần chốt:** nhập hẳn 3 cờ này vào `layout_settings` rồi xoá khỏi blob — hay giữ
riêng? Giữ riêng nghĩa là hai chỗ cùng điều khiển một trường.

`gdprConsentTracking` khác hẳn: **không có trường consent nào** trên contact. Bật
lên thì phải sinh audit trail đồng ý/rút lại. Đó là tính năng, không phải cờ.

Lưu ý: màn hình chỉ render 2 trong 4 công tắc (`emailOptInTracking`,
`gdprConsentTracking` — `AdvancedContactSettingsPage.tsx:195,205`). Hai cờ còn lại
tồn tại trong dữ liệu mà không có cách đổi.

### 3. `contact_roles` — nối dây

`{ roles: [{id, name}] }` — [seeding:196](../../src/crm-settings/tenant-settings-seeding.service.ts).

**Không có màn hình nào ghi.** `AdvancedContactSettingsPage.tsx:222-231` render danh
sách với nút "Remove" và "Add new role" **không có handler** — bấm không làm gì.
`saveRolesSettings` ([omniSettingsService.ts:457](../../../crm-web/src/features/settings/services/omniSettingsService.ts))
và `saveContactRoles` ([contactSettingsApi.ts:66](../../../crm-web/src/features/settings/api/contactSettingsApi.ts))
đều không có ai gọi.

Đích đến rõ: `account_contact_relations.role` hiện là string tự do —
[account-contact-relation.schema.ts:53](../../src/contacts/relations/account-contact-relation.schema.ts).
Biến nó thành picklist là đúng cơ chế vừa dựng: thêm descriptor vào
`object-registry.ts`, thêm nhánh vào `PicklistProvider.contactPicklists()`, và
`RecordWriteValidator` tự kiểm tư cách thành viên.

### 4. `contact_assignment` — cấu hình tranh chấp ⚠️

`{ autoAssignmentEnabled, strategy, maxContactsPerAgent, fallbackRule, reassignmentRule }` —
[seeding:206](../../src/crm-settings/tenant-settings-seeding.service.ts). Ghi bởi
`AdvancedContactSettingsPage.tsx:250,257,270`.

Đây là khoá đáng lo nhất trong 15, **không phải vì trơ mà vì có bản thật song song**.
`src/assignment/` là core phân bổ đã hợp nhất (đợt 2026-07-26), có capacity nguyên
tử, round-robin Lua, config cache, audit. Màn hình này cho người vận hành một bộ
điều khiển thứ hai cho cùng khái niệm — `strategy`, `maxContactsPerAgent`,
`fallbackRule` đều có bản đối ứng thật trong core — và bộ thứ hai không nối vào đâu.

Người vận hành đặt `maxContactsPerAgent: 50` ở đây rất có thể tin là đã đặt hạn mức.

**Cần chốt trước khi làm gì khác với khoá này:** Object Manager có được phép cấu
hình phân bổ hay không? Nếu có thì nó phải ghi thẳng vào config của
`src/assignment/`, không phải vào blob riêng. Nếu không thì xoá cả tab.

### 5. `contact_conversion` — tính năng thiếu

`{ allowConversion, convertToAccount, convertToDeal, autoMergeOnConvert }` —
[seeding:214](../../src/crm-settings/tenant-settings-seeding.service.ts).

**Không có gì cả**: không tab nào render nó (`fetchContactSettings` tải về rồi bỏ đó —
[contactSettingsApi.ts:27](../../../crm-web/src/features/settings/api/contactSettingsApi.ts)),
không hàm save nào được gọi, và **không có endpoint convert nào trong toàn bộ
crm-api** (grep `convertTo(Account|Deal)|/convert` chỉ khớp đúng dòng seeding).

Cờ cấu hình cho một tính năng chưa tồn tại. Xoá khoá, hoặc mở ticket "Contact
conversion" riêng và để cờ này lại cho ticket đó.

### 6. `deal_forecasting` — tính năng thiếu

`{ weightedForecast, currency, fiscalYearStart, forecastCategories[{name, minProbability, maxProbability}] }` —
[seeding:545](../../src/crm-settings/tenant-settings-seeding.service.ts). Ghi bởi
`AdvancedDealSettingsPage.tsx:94,104,119`.

Nền có một nửa: `deal.probability:43` và `deal.currency:49` tồn tại —
[deal.schema.ts](../../src/deals/infrastructure/persistence/document/entities/deal.schema.ts).
Thiếu hẳn phía tiêu thụ: grep `forecast` toàn `src/` chỉ ra file seeding, một
comment trong `create-deal.dto.ts`, `field-sensitivity.registry.ts` và một script
migrate. **Không có service, report hay endpoint forecast nào.**

Menu đã có item `revenue_forecast` ([seeding:1571](../../src/crm-settings/tenant-settings-seeding.service.ts))
— nên nhớ kiểm luôn màn hình đó trỏ vào đâu.

### 7. `deal_sales_goals` — tính năng thiếu

`{ teamGoalsEnabled, individualGoalsEnabled, goalPeriod }` — [seeding:557](../../src/crm-settings/tenant-settings-seeding.service.ts).
Ghi bởi `AdvancedDealSettingsPage.tsx:158,166,173`. Không có module goal/quota nào
trong `src/` (grep tên file `forecast|sales-goal|quota|territor` → 0 kết quả).

### 8. `account_structure` — tính năng thiếu

`{ enableParentChildHierarchy: true, maxHierarchyDepth: 5 }` — [seeding:563](../../src/crm-settings/tenant-settings-seeding.service.ts).
Ghi bởi `AdvancedAccountSettingsPage.tsx:77,85`.

**`account.schema.ts` không có trường parent nào** — đã liệt kê toàn bộ field:
`name, website, industry, typeId, emails, phones, taxId, annualRevenue,
numberOfEmployees, billingAddress, shippingAddress, ownerId, orgUnitId, statusId,
isArchived, nameKey, websiteDomain, taxIdKey, customFields, tags` + audit fields.

Mặc định là `true`, nên giao diện đang khẳng định phân cấp công ty **đang bật**
trong khi không thể tạo được quan hệ cha–con. `maxHierarchyDepth` càng vô nghĩa hơn.

Việc thật: thêm `parentAccountId`, chống chu trình, chống vượt độ sâu, cascade khi
xoá, và quyết định phân cấp có ảnh hưởng tầm nhìn dữ liệu hay không (nó sẽ giao với
`data_visibility`, cần cân nhắc riêng).

### 9. `account_classification` — split-brain

`{ accountTypes: [{id, name}], industries: [string] }` — [seeding:568](../../src/crm-settings/tenant-settings-seeding.service.ts).

Hai vấn đề khác nhau trong một khoá:

- **`accountTypes` trùng collection thật.** `account.typeId` tham chiếu
  `AccountTypeSchemaClass` ([account-type.schema.ts](../../src/account-settings/entities/account-type.schema.ts)),
  và `PicklistProvider.accountPicklists()` đọc `accountSettings.findAllTypes()` —
  [picklist.provider.ts:114](../../src/object-manager/picklists/picklist.provider.ts).
  Nửa blob là bản sao chết. **Đúng hình dạng split-brain mà migration
  `2026-08-04-object-manager-unification` đã đóng cho status/source, nhưng
  `account_classification` không nằm trong danh sách bao.**
- **`industries` chưa bao giờ được kiểm.** `account.industry` là string tự do
  ([account.schema.ts:32](../../src/accounts/infrastructure/persistence/document/entities/account.schema.ts)).
  Đưa vào registry + `PicklistProvider` là xong — nhưng phải xử lý giá trị cũ ngoài
  danh sách (chọn: kiểm tra chỉ khi tạo mới, hay chuẩn hoá dữ liệu cũ trước).

Ngoài ra nút "Remove" (`:106`), "Add new type" (`:110`), `×` trên industry (`:121`)
và "Add" (`:124`) đều **không có handler**.

### 10. `account_territory` — tính năng thiếu

`{ autoOwnerAssignment: true }` — [seeding:577](../../src/crm-settings/tenant-settings-seeding.service.ts).
Ghi bởi `AdvancedAccountSettingsPage.tsx:147`. Nút "Configure territories" (`:150`)
không có handler. Không có module territory nào.

Chồng lấn với `src/assignment/` giống mục #4 — nếu làm thì phải là một chiến lược
trong core phân bổ, không phải nhánh riêng.

### 11. `account_financial` — tính năng thiếu

`{ multiCurrency: true }` — [seeding:581](../../src/crm-settings/tenant-settings-seeding.service.ts).
Ghi bởi `AdvancedAccountSettingsPage.tsx:171`.

`account.annualRevenue` là số trơn, không có trường currency. `deal.currency` có
nhưng là string tự do, không kiểm. Bật đa tiền tệ nghĩa là: danh mục tiền tệ, tỷ
giá có mốc thời gian, quy tắc quy đổi khi tổng hợp báo cáo, và một quyết định về
tiền tệ hiển thị. Mặc định `true` hiện nay là một tuyên bố sai.

### 12. `task_advanced` — split-brain, có lỗi sống 🔴

`{ categories[], defaultReminderMinutes: 15, enableAutoCompletionRules: true }` —
[seeding:585](../../src/crm-settings/tenant-settings-seeding.service.ts).

**`categories` — lỗi tái hiện được.** `AdvancedTaskSettingsPage.tsx:48-58` thêm
category với id `Math.random().toString(36).substring(2,9)` vào blob. Nhưng
`TaskReferenceValidator` kiểm `categoryId` với collection `task_categories` —
[task-reference.validator.ts:73](../../src/tasks/task-reference.validator.ts) — và
`PicklistProvider.taskPicklists()` cũng đọc `taskSettings.findAllCategories()`
([picklist.provider.ts:151](../../src/object-manager/picklists/picklist.provider.ts)).
Nên category tạo ở Object Manager **không hiện trong form task, và nếu gán được thì
bị từ chối**. Giống y status/source trước đợt 2026-08-04; migration không bao khoá này.

**`defaultReminderMinutes` — nối dây, rẻ.** `task.reminderAt` và dispatcher đã có
đủ, kèm index `task_reminder_due` —
[task.schema.ts:78,244](../../src/tasks/infrastructure/persistence/document/entities/task.schema.ts).
Chỉ thiếu: khi tạo task có `dueDate` mà không có `reminderAt` thì đặt
`dueDate - defaultReminderMinutes`.

**`enableAutoCompletionRules` — tính năng thiếu.** Không có logic tự hoàn thành nào.
Cần chốt "auto completion" nghĩa là gì trước khi ước lượng.

### 13. `ticket_category` — thiếu kiểm tra

Cây phân cấp `{ categories: [{id, name, apiName, children[]}] }` —
[seeding:886](../../src/crm-settings/tenant-settings-seeding.service.ts). Ghi bởi
`AdvancedTicketSettingsPage.tsx:111,115`.

Khác 5 khoá picklist còn lại: **không có collection `ticket_categories`** (grep
`ticket_categories|TicketCategory` → 0). Nên blob **chính là thẩm quyền** — hợp lệ,
giống `contact_lifecycle`. Nhưng `ticket.categoryPath?: string[]`
([ticket.schema.ts:116](../../src/tickets/infrastructure/persistence/document/entities/ticket.schema.ts))
**không được kiểm với cây đó**, và cũng không ai chặn xoá một node đang được dùng.

`PicklistProvider` hiện chỉ mô tả được picklist phẳng. Cây n-cấp cần quyết định
riêng: đưa vào registry dưới dạng đường dẫn, hay để `TicketReferenceValidator` tự lo?

### 14–15. `ticket_resolution`, `ticket_type` — mã chết

[seeding:947](../../src/crm-settings/tenant-settings-seeding.service.ts) và
[seeding:841](../../src/crm-settings/tenant-settings-seeding.service.ts).

Thẩm quyền là collection: [ticket-resolution-code.schema.ts](../../src/ticket-settings/entities/ticket-resolution-code.schema.ts),
[ticket-type.schema.ts](../../src/ticket-settings/entities/ticket-type.schema.ts), và
`PicklistProvider.ticketPicklists()` đọc từ đó ([picklist.provider.ts:136](../../src/object-manager/picklists/picklist.provider.ts)).

`getTicketTypeSettings`/`saveTicketTypeSettings` (`omniSettingsService.ts:909,914`) và
`getTicketResolutionSettings`/`saveTicketResolutionSettings` (`:935,940`) **không có
ai gọi** — `AdvancedTicketSettingsPage` chỉ dùng nhóm category.

Việc cần làm: xoá 4 hàm ở web, gỡ 2 khoá khỏi `DEFAULTS_MAP`, và **kiểm blob còn
sót trong dữ liệu tenant thật trước khi gỡ** — nếu có tenant từng lưu type/resolution
riêng ở đây thì phải chuyển vào collection như migration 2026-08-04 đã làm.

---

## Hai bẫy chung, không thuộc khoá nào

**Nút báo thành công mà không làm gì.** `AdvancedContactSettingsPage.tsx:280`:

```tsx
<Button onClick={() => toast.success(t('objectManager.advancedContact.syncSuccess'))}>
    <Save className="me-2 h-4 w-4" /> {t('objectManager.advancedContact.syncBtn')}
</Button>
```

Không gọi API. Các switch quanh nó tự lưu ngay khi đổi, nên nút này chưa bao giờ cần
thiết — nhưng nó dạy người dùng rằng có bước "Sync" và bước đó đã chạy xong.
Xoá nút, đừng gắn handler.

**Nút CRUD không có handler.** Ít nhất 6 chỗ: contact roles (`:225,229`), account
types (`:106,110`), industries (`:121,124`), configure territories (`:150`). Không
`onClick`, không `disabled`, không tooltip. Trông hoạt động, bấm im lặng.

Đề nghị: eslint rule chặn `<Button>` trong `features/settings/ui/**` mà thiếu cả
`onClick` và `type="submit"`. Loại bẫy này rẻ để chống bằng máy, đắt để tìm bằng mắt.

## Cổng chống tái phát

Chốt hiện trạng bằng test, để danh sách này không lặng lẽ dài ra: một spec liệt kê
tường minh các khoá **được phép** không có người đọc, đối chiếu với `DEFAULTS_MAP`,
và fail khi có khoá mới thêm vào map mà không nằm trong danh sách miễn trừ. Cùng hình
dạng với `object-registry.drift.spec.ts` — bắt lệch pha ngay lúc thêm, không phải
sau một vòng audit nữa.
