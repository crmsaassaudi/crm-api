# AI Video Module — Technical Reference

**Path:** `src/ai-video/`  
**Module class:** `AiVideoModule`

```
ai-video/
├── ai-video.module.ts
├── controllers/
│   ├── ai-video-job.controller.ts
│   └── ai-video-settings.controller.ts
├── services/
│   ├── ai-video-job.service.ts         # Main orchestrator (~535 lines)
│   ├── ai-generator.service.ts         # OpenAI GPT integration
│   ├── voice-synthesis.service.ts      # ElevenLabs TTS
│   └── video-compositor.service.ts     # FFmpeg video rendering
├── domain/
│   ├── ai-video-job.ts                 # Domain entity + status type
│   ├── ai-video-asset.ts
│   └── ai-video-settings.ts
├── dto/
│   ├── create-ai-video-job.dto.ts
│   ├── reject-ai-video-job.dto.ts
│   └── generate-content.dto.ts
├── infrastructure/persistence/document/
│   ├── entities/
│   │   ├── ai-video-job.schema.ts      # Collection: ai_video_jobs
│   │   ├── ai-video-asset.schema.ts    # Collection: ai_video_assets
│   │   ├── ai-video-audit-log.schema.ts
│   │   └── ai-video-settings.schema.ts
│   └── repositories/
│       ├── ai-video-job.repository.ts
│       └── ai-video-settings.repository.ts
└── audit/
    └── ai-video-audit-log.service.ts
```

---

## 1. Domain Model

### 1.1 Status State Machine

```
                    ┌──────────────────────────────────────────────────┐
                    │               AI Video Job Lifecycle              │
                    └──────────────────────────────────────────────────┘

  CREATED
    │
    ├──► INGESTING          (Downloading URL / synthesizing voice)
    │       │
    │       ├──► INGESTED
    │       │       │
    │       │       ├──► NORMALIZING      (FFmpeg: convert to 1080x1920)
    │       │       │       │
    │       │       │       ├──► NORMALIZED
    │       │       │       │       │
    │       │       │       │       ├──► PROCESSING   (AI: captions + hashtags)
    │       │       │       │       │       │
    │       │       │       │       │       ├──► PROCESSED
    │       │       │       │       │       │       │
    │       │       │       │       │       │       └──► PENDING_REVIEW
    │       │       │       │       │       │               │
    │       │       │       │       │       │       ┌───────┴───────┐
    │       │       │       │       │       │       ▼               ▼
    │       │       │       │       │       │    APPROVED        REJECTED
    │       │       │       │       │       │
    │       │       │       │       │       └──► PROCESS_FAILED
    │       │       │       │       │
    │       │       │       │       └──► PROCESS_FAILED
    │       │       │       │
    │       │       │       └──► NORMALIZE_FAILED
    │       │       │
    │       │       └──► INGEST_FAILED (URL unreachable / synthesis error)
    │       │
    │       └──► INGEST_FAILED
    │
    └──► CANCELLED  (manual cancellation before pipeline starts)
```

**Full status type:**
```typescript
type AiVideoJobStatus =
  | 'CREATED' | 'INGESTING' | 'INGESTED'
  | 'NORMALIZING' | 'NORMALIZED'
  | 'PROCESSING' | 'PROCESSED'
  | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
  | 'INGEST_FAILED' | 'NORMALIZE_FAILED' | 'PROCESS_FAILED';
```

### 1.2 `AiVideoJob` Schema (collection: `ai_video_jobs`)

```typescript
{
  tenantId: ObjectId;          // Immutable
  sourceType: 'url_import' | 'script_production';  // Immutable
  sourceUrl?: string;          // Input URL (url_import) or rendered video path (output)
  scriptText?: string;         // Script for voice synthesis (script_production)
  status: string;              // AiVideoJobStatus
  recipeId?: ObjectId;         // Optional: video template/recipe reference
  caption?: string;            // AI-generated or manual caption
  hashtags: string[];
  errorDetails?: string;       // Pipeline error message
  rejectReason?: string;       // Human rejection reason
  createdById?: ObjectId;
  createdAt, updatedAt: Date;
}

// MongoDB indexes:
{ tenantId: 1, status: 1, createdAt: -1 }        — tenant_status_created_lookup
{ tenantId: 1, sourceType: 1, createdAt: -1 }     — tenant_source_created_lookup
```

### 1.3 `AiVideoAuditLog` Schema (collection: `ai_video_audit_logs`)

```typescript
{
  tenantId: ObjectId;
  jobId: ObjectId;
  action: string;              // e.g. 'VIDEO_CREATED', 'APPROVED', 'REJECTED'
  actorType: 'user' | 'system' | 'ai';
  actorId?: string;
  oldStatus?: AiVideoJobStatus;
  newStatus?: AiVideoJobStatus;
  payload?: Record<string, any>;
  createdAt: Date;
}

// MongoDB indexes:
{ tenantId: 1, jobId: 1, createdAt: -1 }
```

---

## 2. Core Service (`ai-video-job.service.ts`)

### 2.1 `createJob(dto)` → fire-and-forget pipeline

```typescript
async createJob(dto: CreateAiVideoJobDto): Promise<AiVideoJob> {
  tenantId = cls.get('tenantId')
  userId = cls.get('userId')

  job = await jobRepository.create({
    tenantId, sourceType: dto.sourceType,
    sourceUrl: dto.sourceUrl,
    scriptText: dto.scriptText,
    status: 'CREATED', createdById: userId,
  })

  await auditLog('VIDEO_CREATED', { actorType: 'user', actorId: userId })

  // Fire-and-forget — does NOT await pipeline
  void this.runVideoPipeline(job.id, tenantId)

  return job
}
```

### 2.2 `runVideoPipeline(jobId, tenantId)` — Full Pipeline

```
async runVideoPipeline(jobId, tenantId):

Step 1: INGESTING
  updateStatus(jobId, 'INGESTING')
  
  if sourceType === 'url_import':
    → validate URL accessible (HEAD request)
    → sourceUrl stays as-is (remote URL for next steps)
  
  if sourceType === 'script_production':
    → voiceSynthesisService.synthesizeSpeech(tenantId, job.scriptText)
       → POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}
          { text, model_id: 'eleven_multilingual_v2' }
       → returns Buffer (MP3 audio)
  
  updateStatus(jobId, 'INGESTED')

Step 2: NORMALIZING
  updateStatus(jobId, 'NORMALIZING')
  
  videoCompositorService.renderVideo(tenantId, {
    jobId,
    sourceUrl or audioBuffer,
    scriptText (for captions overlay)
  })
  → FFmpeg pipeline:
    Input:  sourceUrl / synthesized audio + background video template
    Filter: scale=1080:1920, pad, overlay audio
    Output: files/{tenantId}/{jobId}.mp4
    Codec:  H.264, AAC, 30fps
  → returns localOutputPath
  
  updateStatus(jobId, 'NORMALIZED')
  update sourceUrl → localOutputPath (or served URL)

Step 3: PROCESSING  
  updateStatus(jobId, 'PROCESSING')
  
  aiGeneratorService.generateCaptionAndHashtags({
    source: job.scriptText || job.sourceUrl,
    prompt: optional custom prompt,
    existingCaption: job.caption,
  })
  → GPT-4o prompt:
    "Generate a social media caption and 5-10 hashtags for this content.
     Return JSON: { caption: string, hashtags: string[] }"
  → { caption, hashtags }
  
  update job: { caption, hashtags, status: 'PROCESSED' }

Step 4: PENDING_REVIEW
  updateStatus(jobId, 'PENDING_REVIEW')
  auditLog('STATUS_CHANGED', { newStatus: 'PENDING_REVIEW', actorType: 'system' })

Error handling at any step:
  catch(error):
    updateStatus(jobId, 'INGEST_FAILED' | 'NORMALIZE_FAILED' | 'PROCESS_FAILED')
    update errorDetails = error.message
    auditLog('PIPELINE_FAILED', { error: error.message, actorType: 'system' })
```

### 2.3 `approve(jobId)`

```
1. Load job (tenantId scope)
2. Validate status in ['PENDING_REVIEW', 'PROCESSED', 'REJECTED']
   → BadRequestException if invalid
3. updateStatus(jobId, 'APPROVED')
4. auditLog('APPROVED', { actorType: 'user', actorId: userId })
```

### 2.4 `reject(jobId, dto)`

```
1. Load job
2. Validate status in ['PENDING_REVIEW', 'PROCESSED']
   → BadRequestException if invalid
3. update { status: 'REJECTED', rejectReason: dto.reason }
4. auditLog('REJECTED', { payload: { reason: dto.reason }, actorType: 'user' })
```

### 2.5 `resolveApprovedVideoUrls(tenantId, jobIds[])` — for Social Posts

```
for each jobId:
  job = findById(tenantId, jobId)
  if !job → NotFoundException('AI video job not found: {jobId}')
  if job.status !== 'APPROVED' → BadRequestException('AI video job is not approved')
  if !job.sourceUrl → BadRequestException('AI video has no resolved URL')
  collect job.sourceUrl

return string[]  (array of video URLs)
```

---

## 3. AI Generator Service (`ai-generator.service.ts`)

Uses **OpenAI GPT-4o** (or configured model) via `openai` SDK.

```typescript
generateCaptionAndHashtags(params: {
  source: string;         // Script text or video description
  prompt?: string;        // Custom override prompt
  existingCaption?: string;
}): Promise<{ caption: string; hashtags: string[] }>

// System prompt:
"You are a professional social media content writer.
 Generate an engaging caption and relevant hashtags.
 Return ONLY valid JSON: { \"caption\": string, \"hashtags\": string[] }"

// User message: params.source
// Response parsed as JSON
// Fallback: if parse fails → caption = raw response, hashtags = []
```

---

## 4. Voice Synthesis Service (`voice-synthesis.service.ts`)

Uses **ElevenLabs API**.

```typescript
synthesizeSpeech(tenantId: string, text: string): Promise<Buffer>

POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}
  Headers: xi-api-key: ELEVENLABS_API_KEY
  Body: {
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.5, similarity_boost: 0.75 }
  }
→ MP3 audio Buffer
```

**Voice ID resolution:**
1. `tenant.aiVideoSettings.voiceId` (per-tenant override)
2. `ELEVENLABS_VOICE_ID` env variable
3. ElevenLabs default voice

---

## 5. Video Compositor Service (`video-compositor.service.ts`)

Uses **FFmpeg** (must be installed on the server).

```typescript
renderVideo(tenantId, { jobId, sourceUrl?, audioBuffer?, scriptText? }): Promise<string>

// Output path: files/{tenantId}/{jobId}.mp4

// FFmpeg command (url_import — normalize to vertical):
ffmpeg -i {sourceUrl}
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,
       pad=1080:1920:(ow-iw)/2:(oh-ih)/2,
       setsar=1"
  -c:v libx264 -preset fast -crf 23
  -c:a aac -b:a 128k
  -r 30
  -movflags +faststart
  output.mp4

// FFmpeg command (script_production — compose with audio):
ffmpeg -loop 1 -i background_template.jpg
  -i synthesized_audio.mp3
  -vf "scale=1080:1920,fps=30"
  -c:v libx264 -tune stillimage -preset fast
  -c:a aac -b:a 128k
  -shortest -movflags +faststart
  output.mp4
```

---

## 6. AI Video Settings

```typescript
// Collection: ai_video_settings (one document per tenant)
AiVideoSettings {
  tenantId: ObjectId;           // Unique
  retainOriginalDays: number;   // Default: 30 — cleanup after N days
  retainProcessedDays: number;  // Default: 180
  autoCleanupTempFiles: boolean; // Default: true
  voiceId?: string;             // ElevenLabs voice override
  defaultPrompt?: string;       // GPT prompt override
}
```

---

## 7. File Storage

Generated video files are stored locally:
- **Path:** `files/{tenantId}/{jobId}.mp4`
- **Served via:** `GET /api/v1/files/{filename}` (static file server)
- **Cleanup:** Cron job reads `AiVideoSettings.retainProcessedDays`

---

## 8. API Endpoints

### Jobs (`/api/v1/ai-video/jobs`)
| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/` | `ai_video:create` | Create video job |
| `GET` | `/` | `ai_video:view` | List jobs (filter by status, sourceType) |
| `GET` | `/:id` | `ai_video:view` | Get job detail |
| `GET` | `/:id/audit-log` | `ai_video:view` | Get audit trail |
| `POST` | `/:id/approve` | `ai_video:manage_system` | Approve job |
| `POST` | `/:id/reject` | `ai_video:manage_system` | Reject with reason |
| `POST` | `/:id/generate-content` | `ai_video:edit` | Re-generate caption/hashtags |
| `POST` | `/:id/cancel` | `ai_video:delete` | Cancel job |

### Settings (`/api/v1/ai-video/settings`)
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/` | `ai_video:view` | Get tenant AI video settings |
| `PATCH` | `/` | `ai_video:manage_system` | Update settings |

---

## 9. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | OpenAI API key |
| `OPENAI_MODEL` | ❌ | Default: `gpt-4o` |
| `ELEVENLABS_API_KEY` | ✅ | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | ❌ | Default: ElevenLabs default voice |
| `FFMPEG_PATH` | ❌ | Override ffmpeg binary path |
| `FILES_DIR` | ❌ | Default: `./files` |
