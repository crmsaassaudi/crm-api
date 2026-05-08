import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { MongooseModule } from '@nestjs/mongoose';

import { ReadStateSyncProducer } from './read-state-sync.producer';
import { ReadStateSyncProcessor } from './read-state-sync.processor';
import { ReadStateSyncEventListener } from './read-state-sync-event.listener';

import {
  EmailMetadataSchema,
  EmailMetadataSchemaClass,
} from '../../channels/infrastructure/persistence/document/entities/email-metadata.schema';
import { ChannelsModule } from '../../channels/channels.module';
import { RedisModule } from '../../redis/redis.module';

/**
 * ReadStateSyncModule — BullMQ queue for Two-Way Read State Sync.
 *
 * Handles syncing CRM read/unread actions back to the provider's mailbox
 * (Gmail/Outlook) by setting/removing the IMAP \Seen flag.
 *
 * Features:
 *   - 5-second delayed jobs for click aggregation (batching)
 *   - Deduplication by emailMessageId
 *   - Redis lock per message to prevent concurrent processing
 *   - Error classification: auth errors → halt, transient → retry 3×
 *   - Bull Board integration for monitoring
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: 'read-state-sync',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000, // 5s → 10s → 20s
        },
        removeOnComplete: 100, // Keep last 100 completed jobs
        removeOnFail: 500, // Keep last 500 failed jobs for debugging
      },
    }),
    BullBoardModule.forFeature({
      name: 'read-state-sync',
      adapter: BullMQAdapter,
    }),
    MongooseModule.forFeature([
      { name: EmailMetadataSchemaClass.name, schema: EmailMetadataSchema },
    ]),
    forwardRef(() => ChannelsModule),
    RedisModule,
  ],
  providers: [
    ReadStateSyncProducer,
    ReadStateSyncProcessor,
    ReadStateSyncEventListener,
  ],
  exports: [ReadStateSyncProducer],
})
export class ReadStateSyncModule {}
