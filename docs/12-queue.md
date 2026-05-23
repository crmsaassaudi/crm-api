# Queue & Background Jobs — Technical Reference

**Path:** `src/queue/`, `src/modules/mail-queue/`, `src/social-posts/services/`

---

## 1. Overview

The system uses **BullMQ** backed by Redis for all background processing. The codebase runs in two runtime modes:

| `RUNTIME_ROLE` | What runs |
|---|---|
| `api` (default) | HTTP server + WebSocket + queue producers |
| `worker` | Only queue processors (no HTTP port) |

**Entry points:**
- `src/main.ts` → API mode
- `src/worker.ts` → Worker mode

This separation allows independent horizontal scaling.

---

## 2. BullBoard (Queue Monitor)

Mounted at `GET /queues` using `@bull-board/express`:
- Shows all queues, job counts, failed/completed jobs
- Requires `HybridAuthGuard` + `SUPER_ADMIN` role
- **Do NOT expose to public internet**

---

## 3. Queue Registry

### 3.1 `social-publication` Queue

**Producer:** `PublicationQueueProducer`  
**Processor:** `SocialPostPublishProcessor`  
**BullMQ job name:** `publish`

```typescript
// Job data:
interface PublicationPublishJobData {
  tenantId: string;
  publicationInstanceId: string;
}

// Producer:
schedule(tenantId, instanceId, scheduledAt?):
  options = {
    jobId: instanceId,        // Idempotent — prevents duplicate scheduling
    removeOnComplete: true,
    removeOnFail: 3,          // Keep 3 failed for inspection
    attempts: 1,              // No BullMQ auto-retry; retries are manual
  }
  if scheduledAt:
    options.delay = scheduledAt.getTime() - Date.now()
  queue.add('publish', { tenantId, publicationInstanceId: instanceId }, options)

// Cancel:
cancel(instanceId):
  job = await queue.getJob(instanceId)
  if job?.opts.delay > 0:
    await job.remove()  // Remove delayed job from BullMQ
```

**Retry strategy:** Manual only (no BullMQ `attempts` > 1).  
User calls `POST /publication-instances/:id/retry` → `resetForRetry()` + re-enqueue.

### 3.2 `contact-export` Queue

**Producer:** `ContactExportProducer`  
**Processor:** `ContactExportProcessor`

```typescript
// Job data:
interface ContactExportJobData {
  tenantId: string;
  userId: string;
  filters: ContactQueryFilters;
}

// Processor algorithm:
1. Set BullMQ job progress = 0
2. Cursor-paginate through contacts (batch 500)
3. Write CSV row by row (streaming)
4. Update progress every batch
5. Store file: files/exports/{tenantId}/{jobId}.csv
6. Generate signed download token (Redis, TTL=1h)
7. Store token → jobId mapping in Redis
8. Set job progress = 100
```

### 3.3 `mail` Queue

**Producer:** `MailQueueProducer`  
**Processor:** `MailProcessor`

```typescript
// Job data:
interface MailJobData {
  to: string;
  subject: string;
  template: string;       // Template name in src/mail/templates/
  context: Record<string, any>;
}

// Processor: uses nodemailer + handlebars templates
// Concurrency: QUEUE_MAIL_CONCURRENCY (default: 5)
```

### 3.4 `read-state-sync` Queue

**Purpose:** Batch-update message read/unread states without individual write amplification.

```typescript
// Job data:
interface ReadStateSyncJobData {
  tenantId: string;
  ticketId: string;
  userId: string;
  readAt: number;  // Unix ms
}

// Processor: batch UPSERT using MongoDB bulkWrite
// Concurrency: 1 (sequential to preserve order)
```

---

## 4. Worker Bootstrap (`src/worker.ts`)

```typescript
async function bootstrap() {
  process.env.APP_RUNTIME = 'worker';

  // Same AppModule — but HTTP is NOT started
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  // BullMQ processors auto-register via @Processor() decorator
  // No app.listen() call
}
```

**Docker Compose — Worker service:**
```yaml
worker:
  build: ./crm-api
  command: node dist/worker.js
  environment:
    RUNTIME_ROLE: worker
    REDIS_URL: redis://crm-redis:6379
    MONGODB_URI: mongodb://...
  depends_on:
    - crm-redis
    - mongodb
```

---

## 5. BullMQ Configuration

**Connection:** All queues share a single Redis connection from `RedisModule`.

```typescript
// Default queue options (applied to all queues):
defaultJobOptions: {
  removeOnComplete: true,
  removeOnFail: 50,        // Keep last 50 failed
  attempts: 1,
  backoff: { type: 'fixed', delay: 5000 },
}
```

---

## 6. Concurrency Settings

| Queue | Default Concurrency | Env Override |
|---|---|---|
| `social-publication` | 5 | `QUEUE_SOCIAL_PUBLICATION_CONCURRENCY` |
| `contact-export` | 2 | `QUEUE_CONTACT_EXPORT_CONCURRENCY` |
| `mail` | 5 | `QUEUE_MAIL_CONCURRENCY` |
| `read-state-sync` | 1 | — |

---

## 7. Environment Variables

| Variable | Description |
|---|---|
| `REDIS_URL` | Redis connection string |
| `RUNTIME_ROLE` | `api` or `worker` |
| `QUEUE_MAIL_CONCURRENCY` | Mail processor concurrency |
| `QUEUE_SOCIAL_PUBLICATION_CONCURRENCY` | Social publisher concurrency |
| `QUEUE_CONTACT_EXPORT_CONCURRENCY` | Export concurrency |
