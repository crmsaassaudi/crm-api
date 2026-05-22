import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AI_VIDEO_PUBLISH_QUEUE } from './ai-video-queue.constants';

/**
 * Registers BullMQ queues for the AI Video module:
 *   - ai-video-publish: Facebook Graph API video upload jobs
 *
 * Uses exponential backoff matching Meta's recommended retry strategy.
 * Queues use the global Redis connection configured in QueueModule.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: AI_VIDEO_PUBLISH_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 600_000 }, // 10 min * 2^attempt
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
  ],
  exports: [BullModule],
})
export class AiVideoQueueModule {}
