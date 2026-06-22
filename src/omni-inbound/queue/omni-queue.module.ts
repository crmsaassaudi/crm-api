import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OMNI_ROUTING_QUEUE, OMNI_WEBHOOK_QUEUE } from './omni-queue.constants';
import { OMNI_MEDIA_CACHE_QUEUE } from './omni-media-queue.constants';
import { OMNI_STICKY_RETRY_QUEUE } from './omni-sticky-queue.constants';
import { OMNI_AUTO_RESOLVE_QUEUE } from './omni-auto-resolve-queue.constants';
import { OMNI_FALLBACK_QUEUE } from './omni-fallback-queue.constants';
import { BOT_PROCESSING_QUEUE } from './bot-processing-queue.constants';

/**
 * Registers BullMQ queues for the omni-channel module:
 *   - omni-webhooks: inbound webhook processing
 *   - omni-routing: normalized OmniPayload routing boundary
 *   - omni-media-cache: async media download & caching
 *   - omni-sticky-retry: delayed sticky-routing retry after wait-time
 *   - omni-auto-resolve: per-conversation delayed auto-resolve (replaces cron)
 *   - bot-processing: async Typebot reply processing after inbound persistence
 *
 * Jobs are added by InboundController / ConversationService and
 * consumed by WebhookProcessor / MediaCacheProcessor / StickyRetryProcessor / AutoResolveProcessor.
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
        name: OMNI_ROUTING_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
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
      {
        name: OMNI_STICKY_RETRY_QUEUE,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 50,
          removeOnFail: 200,
        },
      },
      {
        name: OMNI_AUTO_RESOLVE_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      },
      {
        name: OMNI_FALLBACK_QUEUE,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 50,
          removeOnFail: 200,
        },
      },
      {
        name: BOT_PROCESSING_QUEUE,
        defaultJobOptions: {
          attempts: 8,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      },
    ),
  ],
  providers: [],
  exports: [BullModule],
})
export class OmniQueueModule {}
