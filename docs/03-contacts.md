# Contacts Module — Technical Reference

**Path:** `src/contacts/`  
**Module class:** `ContactsModule`

```
contacts/
├── contacts.controller.ts
├── contacts.service.ts           # ~800 lines — core business logic
├── contacts.module.ts
├── domain/
│   ├── contact.ts                # Domain entity
│   └── contact-lifecycle.ts     # Lifecycle enums/types
├── infrastructure/persistence/document/
│   ├── entities/contact.schema.ts
│   └── repositories/contact.repository.ts
├── dto/
│   ├── create-contact.dto.ts
│   ├── update-contact.dto.ts
│   ├── query-contact.dto.ts
│   └── change-stage.dto.ts
└── listeners/
    └── contact-automation.listener.ts
```

---

## 1. Contact Schema (MongoDB collection: `contacts`)

```typescript
Contact {
  // Identity
  id: string;
  tenantId: string;               // Immutable, indexed
  firstName?: string;
  lastName?: string;
  emails: string[];               // Normalized lowercase, trimmed
  phones: string[];               // Normalized E.164 where possible

  // Ownership
  ownerId?: string;               // Ref: users
  accountId?: string;             // Ref: accounts

  // Lifecycle
  lifecycleStageId: string;       // Stage key from CrmSettings
  statusId?: string;              // Sub-status within stage
  stageHistory: StageHistoryEntry[];
  version: number;                // Optimistic locking counter

  // Omni-channel
  omniIdentities: {
    channelType: string;          // 'facebook' | 'instagram' | 'whatsapp'
    senderId: string;             // Platform-specific sender ID
  }[];

  // Shadow contacts
  isShadow: boolean;              // Auto-created from inbound messages
  
  // Metadata
  tags: string[];
  customFields: Record<string, any>;
  lastActivityAt?: Date;
  createdById: string;
  updatedById?: string;
  deletedAt?: Date;               // Soft delete
  createdAt: Date;
  updatedAt: Date;
}

StageHistoryEntry {
  stageId: string;
  statusId?: string;
  changedAt: Date;
  changedById?: string;
  direction: 'forward' | 'backward' | 'lateral';
  fromStageId?: string;
  note?: string;
}
```

**MongoDB indexes:**
```
{ tenantId: 1, deletedAt: 1, createdAt: -1 }    — base list query
{ tenantId: 1, lifecycleStageId: 1 }             — lifecycle filter
{ tenantId: 1, ownerId: 1 }                      — own contacts policy
{ tenantId: 1, emails: 1 }                        — dedup check
{ tenantId: 1, phones: 1 }                        — dedup check
{ tenantId: 1, 'omniIdentities.senderId': 1 }    — omni-channel lookup
{ tenantId: 1, tags: 1 }                          — tag filter
Text index: { firstName, lastName, emails, phones } — full-text search
```

---

## 2. Lifecycle Stage Management

### 2.1 Stage Configuration

Stages are configured per-tenant in `CrmSettings` under key `contact_lifecycle`:
```typescript
CrmSettings['contact_lifecycle'] = {
  stages: [
    { id: 'lead', label: 'Lead', order: 1, statuses: [...] },
    { id: 'prospect', label: 'Prospect', order: 2, statuses: [...] },
    { id: 'customer', label: 'Customer', order: 3, statuses: [...] },
  ]
}
```

### 2.2 `changeStage(contactId, dto)` — Full Algorithm

```
1. Acquire MongoDB transaction (session)

2. Find contact with { _id, tenantId } — include version field

3. Load tenant lifecycle config from CrmSettings

4. Validate toStageId exists in config
   → BadRequestException if not found

5. Validate toStatusId (if provided) exists within the stage's statuses
   → BadRequestException if invalid

6. Compute transition direction:
   - Compare order(fromStage) vs order(toStage)
   - 'forward'  if toStage.order > fromStage.order
   - 'backward' if toStage.order < fromStage.order
   - 'lateral'  if same order (status change only)

7. Optimistic locking check:
   findOneAndUpdate({
     _id: contactId,
     tenantId,
     version: contact.version  ← must match current
   }, {
     $set: { lifecycleStageId, statusId, version: version+1 },
     $push: { stageHistory: historyEntry }
   })
   → ConflictException (409) if version mismatch

8. Emit 'activity.create' event → ActivityLog
9. Emit 'audit.record' event → AuditLog (CONTACT_STAGE_CHANGED)
10. Emit 'field_updated.Contact' event → AutomationRules

11. Commit transaction
```

### 2.3 Stage History Entry
```typescript
{
  stageId: dto.toStageId,
  statusId: dto.toStatusId,
  changedAt: new Date(),
  changedById: cls.get('userId'),
  direction: computed,         // 'forward' | 'backward' | 'lateral'
  fromStageId: contact.lifecycleStageId,
  note: dto.note,
}
```

---

## 3. Contact Deduplication

### 3.1 `checkDuplicate(dto)`

```
Input: { email?, phone?, tenantId }

Query MongoDB:
  { tenantId, deletedAt: null }
  + $or: [
    { emails: normalizedEmail },
    { phones: normalizedPhone }
  ]

Returns:
  { isDuplicate: boolean, matches: Contact[] }
```

### 3.2 Dedup on Create

`ContactsService.create()` always runs `checkDuplicate` first. If a duplicate is found:
- Returns `409 Conflict` with existing contact ID in response body
- Frontend can prompt user to merge or proceed

---

## 4. Shadow Contacts & Promotion

**Shadow contact** = auto-created from an inbound message, has no name/email/phone.

```typescript
// Created by OmniInboundService when sender is unknown:
createShadowContact({
  tenantId,
  isShadow: true,
  omniIdentities: [{ channelType: 'facebook', senderId: '1234567' }],
  lifecycleStageId: 'lead',  // default first stage
})
```

**Promotion** happens automatically in `update()`:
```typescript
if (dto.emails?.length || dto.phones?.length || dto.firstName) {
  contact.isShadow = false;
}
```

---

## 5. Contact Merging (`mergeContacts(primaryId, targetId)`)

**Rules:**
- Only `PENDING` or `PUBLISHED` contacts can be merged
- Primary contact retains the ID; target is soft-deleted

**Algorithm:**
```
1. Load primary and target contacts
2. Validate both exist, same tenantId, neither is deleted

3. Merge arrays (union + dedup):
   - emails = [...new Set([...primary.emails, ...target.emails])]
   - phones = [...new Set([...primary.phones, ...target.phones])]
   - omniIdentities = union by senderId
   - tags = union
   - stageHistory = [...primary.stageHistory, ...target.stageHistory]
                    sorted by changedAt ascending

4. Update primary contact with merged fields

5. Soft-delete target: { deletedAt: new Date() }

6. Emit audit log: CONTACTS_MERGED
   { primaryId, targetId, mergedEmails, mergedPhones }
```

---

## 6. Async CSV Export

```
POST /api/v1/contacts/export
→ { jobId: 'ulid...' }

BullMQ job:
  Queue: 'contact-export'
  Processor: ContactExportProcessor

Algorithm:
  1. Fetch all contacts matching filter (cursor pagination, batch 500)
  2. Respect restrict_own_contacts policy from CrmSettings
  3. Write CSV to: files/exports/{tenantId}/{jobId}.csv
  4. Store signed download token in Redis (TTL: 1h)

GET /api/v1/contacts/export/:jobId/status
→ { status: 'pending' | 'processing' | 'done' | 'failed', progress: 0-100 }

GET /api/v1/contacts/export/download?token=...
→ Stream CSV file
```

---

## 7. PII Field Unmasking

`unmaskFields(contactId, fields[])`:
- Returns actual email/phone values (normally masked as `****@***.***`)
- Requires permission: `contacts:unmask` (FEATURE tier — must be enabled per tenant)
- Emits `CONTACT_FIELDS_UNMASKED` audit log with:
  ```
  { actorId, contactId, fields: ['email', 'phone'], ipAddress, userAgent }
  ```
- `DataVisibilityInterceptor` (global) masks these fields in all list/detail responses

---

## 8. Access Policy: `restrict_own_contacts`

Configured in `CrmSettings['contact_access']`:
```typescript
{
  restrictOwnContacts: boolean   // Default: false
}
```

When `true`:
- `findAll()` appends `{ ownerId: cls.get('userId') }` to the query
- Export also filters by ownerId
- Owners/Admins are exempt

---

## 9. Pagination

**Offset mode** (default):
```
GET /contacts?page=1&limit=25&sortBy=createdAt&sortOrder=desc
```

**Cursor mode** (large datasets):
```
GET /contacts?cursor=<lastId>&direction=next&limit=25&sortBy=createdAt
```

Cursor is the MongoDB `_id` of the last item. Uses `_id` comparison with the sort field for consistent pagination.

---

## 10. API Endpoints

| Method   | Path                                          | Permission        | Description                  |
| -------- | --------------------------------------------- | ----------------- | ---------------------------- |
| `GET`    | `/api/v1/contacts`                            | `contacts:view`   | Paginated list with filters  |
| `POST`   | `/api/v1/contacts`                            | `contacts:create` | Create contact (dedup check) |
| `GET`    | `/api/v1/contacts/:id`                        | `contacts:view`   | Get contact                  |
| `PATCH`  | `/api/v1/contacts/:id`                        | `contacts:edit`   | Update contact               |
| `DELETE` | `/api/v1/contacts/:id`                        | `contacts:delete` | Soft delete                  |
| `POST`   | `/api/v1/contacts/:id/change-stage`           | `contacts:edit`   | Change lifecycle stage       |
| `GET`    | `/api/v1/contacts/:id/stage-history`          | `contacts:view`   | Stage history                |
| `POST`   | `/api/v1/contacts/:id/merge-identity`         | `contacts:edit`   | Add omni identity            |
| `POST`   | `/api/v1/contacts/:id/unmask`                 | `contacts:unmask` | Get PII fields               |
| `POST`   | `/api/v1/contacts/check-duplicate`            | `contacts:view`   | Dedup check                  |
| `POST`   | `/api/v1/contacts/bulk-tag`                   | `contacts:edit`   | Bulk tag                     |
| `POST`   | `/api/v1/contacts/:primaryId/merge/:targetId` | `contacts:delete` | Merge contacts               |
| `POST`   | `/api/v1/contacts/export`                     | `contacts:export` | Start export job             |
| `GET`    | `/api/v1/contacts/export/:jobId/status`       | `contacts:export` | Export status                |
| `GET`    | `/api/v1/contacts/export/download`            | `contacts:export` | Download CSV                 |

---

## 11. Events Emitted

| Event                    | Payload                            | Consumer               |
| ------------------------ | ---------------------------------- | ---------------------- |
| `record_created.Contact` | `{ contact, tenantId, userId }`    | AutomationRuleListener |
| `field_updated.Contact`  | `{ contact, changes, tenantId }`   | AutomationRuleListener |
| `activity.create`        | `{ type, targetId, actorId, ... }` | ActivityLogService     |
| `audit.record`           | `{ action, targetId, metadata }`   | AuditLogService        |
