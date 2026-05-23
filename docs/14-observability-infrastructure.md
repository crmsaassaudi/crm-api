# Observability & Supporting Infrastructure — Technical Reference

---

## 1. Audit Log Module (`src/audit-log/`)

Records **all write operations** across the system for compliance and traceability.

### Schema (collection: `audit_logs`)

```typescript
AuditLog {
  id: string;
  tenantId: string;
  action: string;              // e.g. 'CONTACT_CREATED', 'TICKET_ASSIGNED'
  targetType: string;          // Entity type: 'Contact', 'Ticket', 'Deal'...
  targetId: string;            // Entity ID
  actorId?: string;            // User who performed the action
  actorType: 'user' | 'system' | 'ai' | 'webhook';
  metadata?: Record<string, any>;  // Action-specific details
  correlationId?: string;      // Request correlation ID
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}
```

**MongoDB indexes:**
```
{ tenantId: 1, targetType: 1, targetId: 1, createdAt: -1 }
{ tenantId: 1, actorId: 1, createdAt: -1 }
{ tenantId: 1, action: 1, createdAt: -1 }
{ createdAt: 1 }  — TTL index (auto-delete after configured days)
```

### API

```
GET /api/v1/audit-log?targetType=Contact&targetId=:id&from=&to=
→ Paginated audit trail for a specific record

GET /api/v1/audit-log?actorId=:userId&from=&to=
→ All actions by a specific user
```

**Audit actions by module:**

| Module | Actions logged |
|---|---|
| Auth | `USER_LOGIN`, `USER_LOGOUT`, `TOKEN_REFRESHED` |
| Contacts | `CONTACT_CREATED`, `CONTACT_UPDATED`, `CONTACT_DELETED`, `CONTACT_STAGE_CHANGED`, `CONTACTS_MERGED`, `CONTACT_FIELDS_UNMASKED` |
| Social Posts | `SOCIAL_ASSET_CREATED`, `SOCIAL_ASSET_VERSION_APPROVED`, `PUBLICATION_INSTANCE_SUCCEEDED`, `PUBLICATION_INSTANCE_FAILED` |
| AI Video | `VIDEO_CREATED`, `APPROVED`, `REJECTED`, `PIPELINE_FAILED` |
| Users | `USER_INVITED`, `USER_REMOVED_FROM_TENANT`, `USER_STATUS_CHANGED` |
| Channels | `CHANNEL_CONNECTED`, `CHANNEL_DISCONNECTED` |

---

## 2. Activity Log Module (`src/activity-log/`)

Tracks **customer-facing activity** on contacts and deals — displayed in the timeline view of the CRM.

### Schema (collection: `activity_logs`)

```typescript
ActivityLog {
  tenantId: ObjectId;
  type: ActivityType;
  targetType: 'Contact' | 'Deal' | 'Ticket';
  targetId: ObjectId;
  actorId?: ObjectId;
  subject?: string;
  body?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

ActivityType =
  | 'stage_changed'
  | 'note_added'
  | 'email_sent'
  | 'call_logged'
  | 'meeting_logged'
  | 'task_created'
  | 'deal_won'
  | 'deal_lost'
  | 'message_received'
  | 'ticket_created'
  | 'ticket_resolved'
```

**API:**
```
GET /api/v1/activity-log?targetType=Contact&targetId=:id
→ Timeline of activities for a CRM record
```

---

## 3. Observability Module (`src/observability/`)

Structured request logging with correlation IDs.

### Logging Interceptor

Applied globally as `APP_INTERCEPTOR`:

```typescript
LoggingInterceptor.intercept(ctx, next):
  correlationId = req.headers['x-correlation-id'] || ulid()
  cls.set('correlationId', correlationId)
  res.setHeader('x-correlation-id', correlationId)

  logger.log({
    method: req.method,
    url: req.url,
    tenantAlias: req.tenantAlias,
    correlationId,
  })

  → next.handle()

  → log response: { statusCode, durationMs }
```

**Log format (Winston JSON):**
```json
{
  "timestamp": "2026-05-23T18:00:00.000Z",
  "level": "info",
  "context": "HTTP",
  "method": "POST",
  "url": "/api/v1/contacts",
  "statusCode": 201,
  "durationMs": 45,
  "tenantAlias": "acme",
  "correlationId": "01HXY...",
  "userId": "664f..."
}
```

---

## 4. Files Module (`src/files/`)

Handles all file uploads (user photos, contact attachments, export CSVs).

### Upload Flow

```
POST /api/v1/files/upload
  Content-Type: multipart/form-data
  file: <binary>

FilesController:
  1. multer middleware → saves to disk: files/{uuid}.{ext}
  2. FilesService.create({ path, size, mimeType })
  3. Returns { id, url }
```

**File serving:**
```
GET /api/v1/files/:filename
→ Static file middleware (express.static('files/'))
→ No auth required (URLs contain unpredictable filenames)
```

**Storage:** Local filesystem by default (`files/` directory).  
**Production:** Should be replaced with S3/MinIO via `STORAGE_DRIVER` env.

---

## 5. Custom Fields Module (`src/custom-fields/`)

Tenant-defined extra fields for contacts, deals, tickets, accounts.

```typescript
CustomFieldDefinition {
  tenantId: ObjectId;
  entityType: 'contact' | 'deal' | 'ticket' | 'account' | 'task';
  fieldKey: string;          // e.g. 'company_tax_id'
  label: string;             // Display name
  type: 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multi_select' | 'url';
  options?: string[];        // For select/multi_select
  isRequired: boolean;
  order: number;
  createdAt: Date;
}
```

**Storage:** Custom field values are stored on the entity's `customFields: Record<string, any>` field.

**API:**
```
GET  /api/v1/custom-fields?entityType=contact
POST /api/v1/custom-fields
PATCH /api/v1/custom-fields/:id
DELETE /api/v1/custom-fields/:id
```

---

## 6. Tags Module (`src/tags/`)

Centralized tag registry per tenant (for autocomplete and reporting):

```typescript
Tag {
  tenantId: ObjectId;
  name: string;         // Lowercase, trimmed, unique per tenant
  color?: string;
  usageCount: number;   // Incremented when tag is applied
  createdAt: Date;
}
```

**API:**
```
GET  /api/v1/tags?search=support
POST /api/v1/tags
DELETE /api/v1/tags/:id
```

---

## 7. List Views Module (`src/list-views/`)

Saved filter + column configurations per user per entity type:

```typescript
ListView {
  tenantId: ObjectId;
  userId: ObjectId;
  entityType: 'contact' | 'deal' | 'ticket' | 'account';
  name: string;
  filters: FilterConfig[];
  columns: string[];
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  isDefault: boolean;
  isShared: boolean;     // Shared with all tenant users
}
```

**API:**
```
GET  /api/v1/list-views?entityType=contact
POST /api/v1/list-views
PATCH /api/v1/list-views/:id
DELETE /api/v1/list-views/:id
```

---

## 8. Redis Module (`src/redis/`)

Central Redis client provider shared across all modules.

```typescript
// Two injection tokens:
REDIS_SERVICE     → RedisService (abstraction layer)
IOREDIS_CLIENT    → raw ioredis client (for session operations)

// Connection:
new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
})
```

**BullMQ uses separate connection** created by `@nestjs/bullmq` using the same env vars.

---

## 9. Mail Module (`src/mail/`, `src/mailer/`)

**`MailModule`** (`src/mail/`) — Template-based transactional emails:
- Templates: Handlebars `.hbs` files in `src/mail/templates/`
- Available templates: `invite-user`, `reset-password`, `ticket-notification`, `export-ready`

**`MailerModule`** (`src/mailer/`) — Low-level nodemailer transport wrapper.

**Send flow:**
```
MailQueueProducer.enqueue(template, to, context)
  → BullMQ 'mail' queue

MailProcessor.process():
  render = handlebars.compile(template)(context)
  nodemailer.sendMail({ to, subject, html: render })
```

**Config:**
```bash
MAIL_HOST=smtp.sendgrid.net
MAIL_PORT=587
MAIL_USER=apikey
MAIL_PASSWORD=SG.xxx
MAIL_DEFAULT_EMAIL=noreply@crmsaudi.dev
MAIL_DEFAULT_NAME=CRM Platform
```

---

## 10. i18n Module (`src/i18n/`)

Uses `nestjs-i18n` with locale files in `src/i18n/`.

**Resolution order:** User preference → Tenant default → System default (`en`)

**Config:**
```bash
# Supported locales:
APP_DEFAULT_LOCALE=en
# Files: src/i18n/en.json, src/i18n/ar.json, etc.
```

**Usage in services:**
```typescript
constructor(private readonly i18n: I18nService) {}

async someMethod() {
  const message = await this.i18n.translate('errors.notFound', {
    lang: this.cls.get('locale') || 'en',
  });
}
```
