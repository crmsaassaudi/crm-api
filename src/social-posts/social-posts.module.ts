import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { ChannelsModule } from '../channels/channels.module';
import { isWorkerRuntime } from '../config/runtime-role';
import {
  SocialPostSchema,
  SocialPostSchemaClass,
} from './infrastructure/persistence/document/entities/social-post.schema';
import {
  SocialPostTaskSchema,
  SocialPostTaskSchemaClass,
} from './infrastructure/persistence/document/entities/social-post-task.schema';
import { FacebookPostPublisher } from './publishers/facebook-post-publisher.service';
import { InstagramPostPublisher } from './publishers/instagram-post-publisher.service';
import { SocialPublisherRegistry } from './publishers/social-publisher-registry.service';
import { TikTokPostPublisher } from './publishers/tiktok-post-publisher.service';
import { SocialPostPublishProcessor } from './queue/processors/social-post-publish.processor';
import { SocialPostQueueModule } from './queue/social-post-queue.module';
import { SocialPostRepository } from './repositories/social-post.repository';
import { SocialPostTaskRepository } from './repositories/social-post-task.repository';
import { SocialPostQueueProducer } from './services/social-post-queue.producer';
import { SocialPostsService } from './services/social-posts.service';
import { SocialPostsController } from './social-posts.controller';

const workerProviders = isWorkerRuntime() ? [SocialPostPublishProcessor] : [];

@Module({
  imports: [
    ChannelsModule,
    AuditLogModule,
    SocialPostQueueModule,
    MongooseModule.forFeature([
      { name: SocialPostSchemaClass.name, schema: SocialPostSchema },
      { name: SocialPostTaskSchemaClass.name, schema: SocialPostTaskSchema },
    ]),
  ],
  controllers: [SocialPostsController],
  providers: [
    SocialPostsService,
    SocialPostQueueProducer,
    SocialPostRepository,
    SocialPostTaskRepository,
    FacebookPostPublisher,
    InstagramPostPublisher,
    TikTokPostPublisher,
    SocialPublisherRegistry,
    ...workerProviders,
  ],
  exports: [SocialPostsService],
})
export class SocialPostsModule {}
