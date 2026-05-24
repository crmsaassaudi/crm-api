import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiVideoModule } from '../ai-video/ai-video.module';

import { ChannelsModule } from '../channels/channels.module';
import { isWorkerRuntime } from '../config/runtime-role';
import {
  SocialContentAssetSchema,
  SocialContentAssetSchemaClass,
} from './infrastructure/persistence/document/entities/social-post.schema';
import {
  PublicationInstanceSchema,
  PublicationInstanceSchemaClass,
} from './infrastructure/persistence/document/entities/social-post-task.schema';
import {
  SocialContentAssetVersionSchema,
  SocialContentAssetVersionSchemaClass,
} from './infrastructure/persistence/document/entities/social-post-version.schema';
import { FacebookPostPublisher } from './publishers/facebook-post-publisher.service';
import { InstagramPostPublisher } from './publishers/instagram-post-publisher.service';
import { SocialPublisherRegistry } from './publishers/social-publisher-registry.service';
import { TikTokPostPublisher } from './publishers/tiktok-post-publisher.service';
import { PublicationInstancePublishProcessor } from './queue/processors/social-post-publish.processor';
import { SocialPublicationQueueModule } from './queue/social-post-queue.module';
import { SocialContentAssetRepository } from './repositories/social-post.repository';
import { PublicationInstanceRepository } from './repositories/social-post-task.repository';
import { SocialContentAssetVersionRepository } from './repositories/social-post-version.repository';
import { PublicationQueueProducer } from './services/social-post-queue.producer';
import { SocialContentAssetsService } from './services/social-posts.service';
import {
  PublicationInstancesController,
  SocialContentAssetsController,
} from './social-posts.controller';

const workerProviders = isWorkerRuntime()
  ? [PublicationInstancePublishProcessor]
  : [];

@Module({
  imports: [
    AiVideoModule,
    ChannelsModule,

    SocialPublicationQueueModule,
    MongooseModule.forFeature([
      {
        name: SocialContentAssetSchemaClass.name,
        schema: SocialContentAssetSchema,
      },
      {
        name: PublicationInstanceSchemaClass.name,
        schema: PublicationInstanceSchema,
      },
      {
        name: SocialContentAssetVersionSchemaClass.name,
        schema: SocialContentAssetVersionSchema,
      },
    ]),
  ],
  controllers: [SocialContentAssetsController, PublicationInstancesController],
  providers: [
    SocialContentAssetsService,
    PublicationQueueProducer,
    SocialContentAssetRepository,
    PublicationInstanceRepository,
    SocialContentAssetVersionRepository,
    FacebookPostPublisher,
    InstagramPostPublisher,
    TikTokPostPublisher,
    SocialPublisherRegistry,
    ...workerProviders,
  ],
  exports: [SocialContentAssetsService],
})
export class SocialContentModule {}
