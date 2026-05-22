import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

// Schemas
import {
  AiVideoJobSchemaClass,
  AiVideoJobSchema,
} from './infrastructure/persistence/document/entities/ai-video-job.schema';
import {
  AiVideoAssetSchemaClass,
  AiVideoAssetSchema,
} from './infrastructure/persistence/document/entities/ai-video-asset.schema';
import {
  AiVideoAuditLogSchemaClass,
  AiVideoAuditLogSchema,
} from './infrastructure/persistence/document/entities/ai-video-audit-log.schema';
import {
  AiVideoPublishTaskSchemaClass,
  AiVideoPublishTaskSchema,
} from './infrastructure/persistence/document/entities/ai-video-publish-task.schema';

// Controllers
import { AiVideoJobController } from './controllers/ai-video-job.controller';

// Services
import { AiVideoJobService } from './services/ai-video-job.service';
import { FacebookPublisherService } from './services/facebook-publisher.service';

// Repositories
import { AiVideoJobRepository } from './repositories/ai-video-job.repository';
import { AiVideoAuditLogRepository } from './repositories/ai-video-audit-log.repository';
import { AiVideoPublishTaskRepository } from './repositories/ai-video-publish-task.repository';

// Queue
import { AiVideoQueueModule } from './queue/ai-video-queue.module';
import { AiVideoPublishProcessor } from './queue/processors/ai-video-publish.processor';

// External modules
import { ChannelsModule } from '../channels/channels.module';
import { isWorkerRuntime } from '../config/runtime-role';

const workerProviders = isWorkerRuntime()
  ? [AiVideoPublishProcessor]
  : [];

/**
 * AiVideoModule — AI Video Orchestrator for CRM.
 *
 * Phase 1A scope:
 * 1. Video Job CRUD (create from URL, list, get, audit log)
 * 2. Approval / Rejection workflow
 * 3. Publish Now (direct Meta Graph API upload)
 * 4. Async publish via BullMQ worker
 * 5. Audit trail for every state transition
 *
 * Reuses ChannelsModule for Facebook Page access tokens (DRY).
 */
@Module({
  imports: [
    ChannelsModule,
    AiVideoQueueModule,
    MongooseModule.forFeature([
      { name: AiVideoJobSchemaClass.name, schema: AiVideoJobSchema },
      { name: AiVideoAssetSchemaClass.name, schema: AiVideoAssetSchema },
      {
        name: AiVideoAuditLogSchemaClass.name,
        schema: AiVideoAuditLogSchema,
      },
      {
        name: AiVideoPublishTaskSchemaClass.name,
        schema: AiVideoPublishTaskSchema,
      },
    ]),
  ],
  controllers: [AiVideoJobController],
  providers: [
    // ── Services ────────────────────────────────────────────────────────
    AiVideoJobService,
    FacebookPublisherService,

    // ── Repositories ────────────────────────────────────────────────────
    AiVideoJobRepository,
    AiVideoAuditLogRepository,
    AiVideoPublishTaskRepository,

    // ── Queue Workers (only in worker runtime) ──────────────────────────
    ...workerProviders,
  ],
  exports: [AiVideoJobService, FacebookPublisherService],
})
export class AiVideoModule {}
