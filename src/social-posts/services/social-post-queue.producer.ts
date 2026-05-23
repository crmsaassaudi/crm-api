import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  SOCIAL_POST_PUBLISH_QUEUE,
  socialPostPublishJobId,
} from '../queue/social-post-queue.constants';
import { SocialPostPublishJobData } from '../social-posts.types';

@Injectable()
export class SocialPostQueueProducer {
  constructor(
    @InjectQueue(SOCIAL_POST_PUBLISH_QUEUE)
    private readonly queue: Queue<SocialPostPublishJobData>,
  ) {}

  async schedule(
    tenantId: string,
    postId: string,
    scheduledAt: Date,
  ): Promise<void> {
    const jobId = socialPostPublishJobId(postId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      await existing.remove();
    }

    const delay = Math.max(0, scheduledAt.getTime() - Date.now());
    await this.queue.add(
      'publish',
      { tenantId, postId },
      {
        jobId,
        delay,
      },
    );
  }

  async enqueueNow(tenantId: string, postId: string): Promise<void> {
    const jobId = socialPostPublishJobId(postId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      await existing.remove();
    }
    await this.queue.add('publish', { tenantId, postId }, { jobId });
  }
}
