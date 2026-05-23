import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SOCIAL_POST_PUBLISH_QUEUE } from './social-post-queue.constants';

@Module({
  imports: [
    BullModule.registerQueue({
      name: SOCIAL_POST_PUBLISH_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 300_000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    }),
  ],
  exports: [BullModule],
})
export class SocialPostQueueModule {}
