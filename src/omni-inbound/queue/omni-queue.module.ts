import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OMNI_WEBHOOK_QUEUE } from './omni-queue.constants';
import { OMNI_MEDIA_CACHE_QUEUE } from './omni-media-queue.constants';

/**
 * Registers BullMQ queues for the omni-channel module:
 *   - omni-webhooks: inbound webhook processing
 *   - omni-media-cache: async media download & caching
 *
 * Jobs are added by InboundController / ConversationService and
 * consumed by WebhookProcessor / MediaCacheProcessor.
 * Queues use the global Redis connection configured in QueueModule.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      {
        name: OMNI_WEBHOOK_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100, // keep last 100 completed for debugging
          removeOnFail: 500,
        },
      },
      {
        name: OMNI_MEDIA_CACHE_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 3000 },
          removeOnComplete: 50,
          removeOnFail: 200,
        },
      },
    ),
  ],
  providers: [],
  exports: [BullModule],
})
export class OmniQueueModule {}
