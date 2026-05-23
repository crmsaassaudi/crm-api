# Social Posts Module — Technical Reference

**Path:** `src/social-posts/`  
**Module class:** `SocialContentModule`

```
social-posts/
├── social-posts.controller.ts       # REST endpoints
├── social-posts.module.ts
├── social-posts.types.ts            # Enums & shared types
├── services/
│   ├── social-posts.service.ts      # Core service (~950 lines)
│   └── social-post-queue.producer.ts # BullMQ enqueue helper
├── processors/
│   └── social-post-publish.processor.ts  # BullMQ worker
├── publishers/
│   ├── social-publisher-registry.service.ts   # Strategy registry
│   ├── publisher-error.util.ts
│   ├── facebook/
│   │   └── facebook-post.publisher.ts
│   ├── instagram/
│   │   └── instagram-post.publisher.ts
│   └── tiktok/
│       └── tiktok-post.publisher.ts     # Stub
├── repositories/
│   ├── social-post.repository.ts         # SocialContentAsset
│   ├── social-post-version.repository.ts # SocialContentAssetVersion
│   └── social-post-task.repository.ts    # PublicationInstance
└── infrastructure/persistence/document/
    └── entities/
        ├── social-post.schema.ts          # Collection: social_content_assets
        ├── social-post-version.schema.ts  # Collection: social_content_asset_versions
        └── social-post-task.schema.ts     # Collection: publication_instances
```

---

## 1. Domain Model

### 1.1 Type Definitions (`social-posts.types.ts`)

```typescript
SocialContentAssetStatus = 'ACTIVE' | 'ARCHIVED'
SocialContentApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED'
PublicationInstanceStatus = 'PENDING' | 'PUBLISHING' | 'SUCCESS' | 'FAILED' | 'CANCELED'
SocialContentPlatform = 'facebook' | 'instagram' | 'tiktok'
SocialContentMediaType = 'text' | 'image' | 'video' | 'mixed'

interface PublicationSnapshot {
  content: string;
  mediaUrls: string[];
  aiVideoJobIds?: string[];
  mediaType: SocialContentMediaType;
}
```

### 1.2 Three-Layer Entity Hierarchy

```
SocialContentAsset  (parent — one per content idea)
  └── SocialContentAssetVersion[]  (immutable versioning — each edit = new version)
       └── PublicationInstance[]   (one per channel per publish event)
```

### 1.3 `SocialContentAsset` Schema (collection: `social_content_assets`)

```typescript
{
  tenantId: ObjectId;        // Immutable
  title: string;             // Auto-derived if not provided
  status: 'ACTIVE' | 'ARCHIVED';
  latestVersionId?: ObjectId; // Points to latest version
  createdById?: ObjectId;
  createdAt, updatedAt: Date;
}

// MongoDB indexes:
{ tenantId: 1, status: 1, createdAt: -1 }  — name: tenant_content_asset_status_lookup
```

### 1.4 `SocialContentAssetVersion` Schema (collection: `social_content_asset_versions`)

```typescript
{
  tenantId: ObjectId;           // Immutable
  assetId: ObjectId;            // Immutable — parent asset
  versionNumber: number;        // Auto-incremented
  content: string;              // Post text
  mediaUrls: string[];          // Direct media URLs
  aiVideoJobIds: string[];      // AI video job references
  mediaType: SocialContentMediaType;
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  rejectionReason?: string;
  approvedById?: ObjectId;
  approvedAt?: Date;
  savedById?: ObjectId;
  changeNote?: string;
  createdAt, updatedAt: Date;
}
```

### 1.5 `PublicationInstance` Schema (collection: `publication_instances`)

```typescript
{
  tenantId: ObjectId;            // Immutable
  assetId: ObjectId;             // Immutable
  sourceVersionId: ObjectId;     // Immutable — version snapshot was taken from
  publicationGroupId: string;    // ULID — groups instances from same publish action
  channelId: ObjectId;
  channelName: string;           // Denormalized at creation time
  channelAccount: string;        // Denormalized (Page ID)
  platform: SocialContentPlatform;
  snapshot: PublicationSnapshot; // Content copy at time of publishing
  status: PublicationInstanceStatus;
  scheduledAt?: Date;
  publishedAt?: Date;
  platformPostId?: string;       // e.g. Facebook post ID after success
  platformMediaId?: string;      // e.g. video media ID
  platformResponseRaw?: object;  // Full platform API response
  retryCount: number;            // Default: 0
  maxRetries: number;            // Default: 3
  errorCode?: string;
  errorMessage?: string;
  createdAt, updatedAt: Date;
}

// MongoDB indexes:
{ tenantId, publicationGroupId, channelId }  — unique — prevents duplicate publish
{ tenantId, status, scheduledAt }             — queue consumer lookup
{ tenantId, assetId, updatedAt }              — asset detail view
```

---

## 2. Content Creation Flow

### 2.1 `create(dto)` — Full Algorithm

```
Input: CreateSocialContentAssetDto {
  title?: string
  content: string
  mediaUrls?: string[]
  aiVideoJobIds?: string[]
  mediaType?: SocialContentMediaType
}

1. resolveMediaUrls(tenantId, mediaUrls, aiVideoJobIds)
   - If aiVideoJobIds.length > 0 AND mediaUrls.length > 0 → BadRequestException
   - If aiVideoJobIds.length > 1 → BadRequestException (max 1 AI video)
   - If aiVideoJobIds provided: AiVideoJobService.resolveApprovedVideoUrls(tenantId, ids)
     → validates each job exists, belongs to tenant, status === 'APPROVED'
     → returns job.sourceUrl[]

2. inferMediaType(mediaUrls) — if not provided:
   - URLs containing .mp4/.mov/.webm → 'video'
   - URLs containing .jpg/.png/.gif  → 'image'
   - Mix of both                     → 'mixed'
   - Neither                         → 'text'

3. resolveTitle(title, content, mediaUrls):
   - Use dto.title if provided
   - Otherwise: content.slice(0, 60) or 'Untitled'

4. assetRepository.create({ tenantId, title, status: 'ACTIVE', createdById })

5. versionRepository.create({
     tenantId, assetId: asset.id,
     versionNumber: 1, content, mediaUrls, aiVideoJobIds,
     mediaType, approvalStatus: 'PENDING', savedById
   })

6. assetRepository.update(tenantId, assetId, { latestVersionId: version.id })

7. recordAssetAudit('SOCIAL_ASSET_CREATED')

8. Return decorated asset (with publicationCounts)
```

### 2.2 `update(id, dto)` — Immutable Versioning

Every update creates a **new version** — versions are never mutated:
```
1. Load current asset (fail if ARCHIVED)
2. Load latest version → use as baseline for unchanged fields
3. versionNumber = await getNextVersionNumber(tenantId, assetId) → max+1
4. Create new version (approvalStatus: 'PENDING')
5. Update asset.latestVersionId → new version
6. recordAssetAudit('SOCIAL_ASSET_VERSION_CREATED')
```

---

## 3. Approval Workflow

```
PENDING ──► APPROVED ──► (can be published)
    │
    └─► REJECTED (with rejectionReason)
         └──► (new update creates new PENDING version)
```

- `approveVersion(assetId, versionId)` — sets `approvalStatus: 'APPROVED'`, records `approvedById` + `approvedAt`
- `rejectVersion(assetId, versionId, { reason })` — sets `approvalStatus: 'REJECTED'` + `rejectionReason`
- `createPublications()` validates `version.approvalStatus === 'APPROVED'` before proceeding

---

## 4. Publication Flow

### 4.1 `createPublications(assetId, dto)`

```
Input: CreatePublicationInstancesDto {
  channelIds: string[]      // Required — target channels
  versionId?: string        // Optional — defaults to latest version
  scheduledAt?: string      // Optional ISO date — omit = immediate
  overrides?: ChannelOverride[]  // Per-channel content overrides
}

1. Load asset — fail if ARCHIVED
2. Resolve version — explicit versionId OR latest
3. Validate version.approvalStatus === 'APPROVED'
4. Parse scheduledAt (ISO → Date, validate future)
5. Resolve channels: channelRepository.findByIdWithCredentials[] (must be Connected)
6. Generate publicationGroupId = ulid()

7. For each channel:
   a. Look up override by channelId
   b. buildPublicationSnapshot(version, override)
      → resolveMediaUrls (same AI video validation)
   c. validateSnapshotForPlatform(channel.type, snapshot)
      → publisher.validateContentLimits(snapshot)
   d. Build payload: { ..., publicationGroupId, snapshot, status: 'PENDING' }

8. publicationRepository.createMany(payloads)

9. For each instance:
   queueProducer.schedule(tenantId, instanceId, scheduledAt)

10. recordAssetAudit('PUBLICATIONS_CREATED')
11. Return instances[]
```

### 4.2 BullMQ Queue Producer (`social-post-queue.producer.ts`)

```typescript
// Immediate publish:
schedule(tenantId, instanceId, undefined):
  queue.add('publish', { tenantId, publicationInstanceId: instanceId })

// Scheduled publish:
schedule(tenantId, instanceId, scheduledAt):
  delay = scheduledAt.getTime() - Date.now()
  queue.add('publish', payload, {
    delay,
    jobId: instanceId,     // idempotent — prevents duplicate enqueue
    removeOnComplete: true,
    removeOnFail: 3,       // keep 3 failed jobs for debugging
  })

// Cancel (remove from queue):
cancel(instanceId):
  queue.remove(instanceId)  // removes by jobId
```

### 4.3 BullMQ Processor (`social-post-publish.processor.ts`)

```
process({ data: { tenantId, publicationInstanceId } }):

1. Load instance from DB
2. Guard: if status in ['CANCELED', 'SUCCESS', 'PUBLISHING'] → skip (idempotent)
3. Update status → 'PUBLISHING' (atomic)

4. Load channel with credentials (findByIdWithCredentials)
5. Validate channel.status === 'Connected'

6. publisherRegistry.get(instance.platform)
   → BadRequestException if no publisher registered

7. publisher.validateContentLimits(instance.snapshot)

8. result = await publisher.publish({ post: snapshot, instance, channel })
   → { platformPostId, platformMediaId?, raw }

9. On success:
   updateStatus → 'SUCCESS', store publishedAt, platformPostId, raw
   recordAudit('PUBLICATION_INSTANCE_SUCCEEDED')

10. On error:
    normalizePublisherError(error) → { code, message, isAuthError }
    publicationRepository.incrementRetry(tenantId, instanceId, code, message)
      → status 'FAILED' if retryCount >= maxRetries
    If isAuthError: channelRepository.update → status: 'Error'
    recordAudit('PUBLICATION_INSTANCE_FAILED')
```

---

## 5. Publisher Strategies

### 5.1 Registry (`social-publisher-registry.service.ts`)

```typescript
// Maps platform → publisher implementation
registry = Map<SocialContentPlatform, ISocialPublisher>
get(platform): ISocialPublisher | undefined
```

### 5.2 Facebook Publisher (`publishers/facebook/`)

**Photo/text post:**
```
POST https://graph.facebook.com/{pageId}/photos
  { url: mediaUrl, caption: content, access_token }
→ { id: postId }

or (text only):
POST https://graph.facebook.com/{pageId}/feed
  { message: content, access_token }
```

**Video Reel (Resumable Chunked Upload):**
```
Step 1 — Initialize:
POST https://graph.facebook.com/{pageId}/video_reels
  { upload_phase: 'start', access_token }
→ { video_id, upload_url, start_offset, end_offset }

Step 2 — Upload chunks (binary):
  chunkSize = 4MB
  for each chunk:
    POST upload_url
      Content-Type: multipart/form-data
      file_size, start_offset, end_offset, video_file_chunk (binary)
    → { start_offset, end_offset } (next chunk position)

Step 3 — Publish:
POST https://graph.facebook.com/{pageId}/video_reels
  { upload_phase: 'finish', video_id, video_state: 'PUBLISHED',
    description: content, access_token }
→ { post_id, success: true }
```

**Content limits validation:**
```typescript
validateContentLimits(snapshot):
  if snapshot.content.length > 63206 → throw 'Caption too long (max 63,206 chars)'
  if snapshot.mediaUrls.length > 10  → throw 'Max 10 photos per post'
```

### 5.3 Instagram Publisher

**Photo post:**
```
Step 1 — Create media container:
POST https://graph.facebook.com/{igUserId}/media
  { image_url: url, caption: content, access_token }
→ { id: containerId }

Step 2 — Publish:
POST https://graph.facebook.com/{igUserId}/media_publish
  { creation_id: containerId, access_token }
→ { id: postId }
```

**Content limits:** 2,200 chars caption, 1 media item

### 5.4 Error Normalization (`publisher-error.util.ts`)

```typescript
normalizePublisherError(error):
  Meta API error codes mapped to:
  - code 190 (Invalid OAuth)     → isAuthError: true
  - code 368 (Temporarily blocked) → isAuthError: false
  - code 10 (Permission denied)  → isAuthError: false
  Returns: { code: string, message: string, isAuthError: boolean }
```

---

## 6. AI Video Integration

When `aiVideoJobIds` is provided:
```typescript
resolveMediaUrls(tenantId, [], aiVideoJobIds):
  AiVideoJobService.resolveApprovedVideoUrls(tenantId, aiVideoJobIds)
  
  // In AiVideoJobService:
  for each jobId:
    job = findById(tenantId, jobId)
    if !job → NotFoundException
    if job.status !== 'APPROVED' → BadRequestException
    return job.sourceUrl
```

**Constraint:** Only 1 AI video per publication (checked in `resolveMediaUrls`).

---

## 7. API Endpoints

### Social Content Assets
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/social-content-assets` | `social_content_assets:view` | List assets |
| `POST` | `/api/v1/social-content-assets` | `social_content_assets:create` | Create |
| `GET` | `/api/v1/social-content-assets/:id` | `social_content_assets:view` | Get detail |
| `PATCH` | `/api/v1/social-content-assets/:id` | `social_content_assets:edit` | Update (new version) |
| `DELETE` | `/api/v1/social-content-assets/:id` | `social_content_assets:delete` | Archive |
| `GET` | `/api/v1/social-content-assets/:id/versions` | `social_content_assets:view` | Version history |
| `POST` | `/api/v1/social-content-assets/:id/versions/:vid/approve` | `social_content_assets:approve` | Approve |
| `POST` | `/api/v1/social-content-assets/:id/versions/:vid/reject` | `social_content_assets:approve` | Reject |
| `POST` | `/api/v1/social-content-assets/:id/publications` | `publication_instances:create` | Schedule |

### Publication Instances
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/publication-instances` | `publication_instances:view` | List |
| `PATCH` | `/api/v1/publication-instances/:id` | `publication_instances:edit` | Edit pending |
| `POST` | `/api/v1/publication-instances/:id/cancel` | `publication_instances:cancel` | Cancel |
| `POST` | `/api/v1/publication-instances/:id/retry` | `publication_instances:retry` | Retry failed |
| `POST` | `/api/v1/publication-instances/:id/publish-now` | `publication_instances:publish` | Immediate |

---

## 8. Audit Log Events

| Event | Trigger |
|---|---|
| `SOCIAL_ASSET_CREATED` | New asset created |
| `SOCIAL_ASSET_VERSION_CREATED` | New version from update |
| `SOCIAL_ASSET_VERSION_APPROVED` | Version approved |
| `SOCIAL_ASSET_VERSION_REJECTED` | Version rejected |
| `SOCIAL_ASSET_ARCHIVED` | Asset archived |
| `PUBLICATIONS_CREATED` | New publication instances enqueued |
| `PUBLICATION_INSTANCE_UPDATED` | Pending instance edited |
| `PUBLICATION_INSTANCE_CANCELED` | Instance cancelled |
| `PUBLICATION_INSTANCE_RETRIED` | Failed instance re-queued |
| `PUBLICATION_INSTANCE_SUCCEEDED` | Successfully published |
| `PUBLICATION_INSTANCE_FAILED` | Publish failed |
