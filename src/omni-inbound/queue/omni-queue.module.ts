import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OMNI_WEBHOOK_QUEUE } from './omni-queue.constants';

/**
 * Registers the BullMQ queue for processing inbound webhooks.
 *
 * Jobs are added by InboundController and consumed by WebhookProcessor.
 * Queue uses the global Redis connection configured in QueueModule.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: OMNI_WEBHOOK_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100, // keep last 100 completed for debugging
        removeOnFail: 500,
      },
    }),
  ],
  providers: [],
  exports: [BullModule],
})
export class OmniQueueModule {}
