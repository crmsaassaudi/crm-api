import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  PUBLICATION_INSTANCE_PUBLISH_QUEUE,
  publicationInstancePublishJobId,
} from '../queue/social-post-queue.constants';
import { PublicationPublishJobData } from '../social-posts.types';

@Injectable()
export class PublicationQueueProducer {
  constructor(
    @InjectQueue(PUBLICATION_INSTANCE_PUBLISH_QUEUE)
    private readonly queue: Queue<PublicationPublishJobData>,
  ) {}

  async schedule(
    tenantId: string,
    publicationInstanceId: string,
    scheduledAt?: Date,
  ): Promise<void> {
    const jobId = publicationInstancePublishJobId(publicationInstanceId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      await existing.remove();
    }

    const delay = scheduledAt
      ? Math.max(0, scheduledAt.getTime() - Date.now())
      : 0;
    await this.queue.add(
      'publish',
      { tenantId, publicationInstanceId },
      {
        jobId,
        delay,
      },
    );
  }

  async cancel(publicationInstanceId: string): Promise<void> {
    const jobId = publicationInstancePublishJobId(publicationInstanceId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      await existing.remove();
    }
  }
}
