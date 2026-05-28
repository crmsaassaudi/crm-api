import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiVideoJobController } from './controllers/ai-video-job.controller';
import { AiVideoSettingsController } from './controllers/ai-video-settings.controller';
import {
  AiVideoAssetSchema,
  AiVideoAssetSchemaClass,
} from './infrastructure/persistence/document/entities/ai-video-asset.schema';
import {
  AiVideoAuditLogSchema,
  AiVideoAuditLogSchemaClass,
} from './infrastructure/persistence/document/entities/ai-video-audit-log.schema';
import {
  AiVideoJobSchema,
  AiVideoJobSchemaClass,
} from './infrastructure/persistence/document/entities/ai-video-job.schema';
import {
  AiVideoSettingsSchema,
  AiVideoSettingsSchemaClass,
} from './infrastructure/persistence/document/entities/ai-video-settings.schema';
import { AiVideoAuditLogRepository } from './repositories/ai-video-audit-log.repository';
import { AiVideoJobRepository } from './repositories/ai-video-job.repository';
import { AiVideoSettingsRepository } from './repositories/ai-video-settings.repository';
import { AiGeneratorService } from './services/ai-generator.service';
import { AiVideoJobService } from './services/ai-video-job.service';
import { VideoCompositorService } from './services/video-compositor.service';
import { VoiceSynthesisService } from './services/voice-synthesis.service';
import { HttpResilienceModule } from '../common/http/http-resilience.module';

@Module({
  imports: [
    HttpResilienceModule,
    MongooseModule.forFeature([
      { name: AiVideoJobSchemaClass.name, schema: AiVideoJobSchema },
      { name: AiVideoAssetSchemaClass.name, schema: AiVideoAssetSchema },
      {
        name: AiVideoAuditLogSchemaClass.name,
        schema: AiVideoAuditLogSchema,
      },
      {
        name: AiVideoSettingsSchemaClass.name,
        schema: AiVideoSettingsSchema,
      },
    ]),
  ],
  controllers: [AiVideoJobController, AiVideoSettingsController],
  providers: [
    AiVideoJobService,
    AiGeneratorService,
    VoiceSynthesisService,
    VideoCompositorService,
    AiVideoJobRepository,
    AiVideoAuditLogRepository,
    AiVideoSettingsRepository,
  ],
  exports: [
    AiVideoJobService,
    AiGeneratorService,
    VoiceSynthesisService,
    VideoCompositorService,
    AiVideoSettingsRepository,
  ],
})
export class AiVideoModule {}
