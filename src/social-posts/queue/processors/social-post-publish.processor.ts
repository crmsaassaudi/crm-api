import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SOCIAL_POST_PUBLISH_QUEUE } from '../social-post-queue.constants';
import { SocialPostPublishJobData } from '../../social-posts.types';
import { SocialPostsService } from '../../services/social-posts.service';

@Processor(SOCIAL_POST_PUBLISH_QUEUE, {
  limiter: {
    max: 30,
    duration: 60_000,
  },
})
export class SocialPostPublishProcessor extends WorkerHost {
  private readonly logger = new Logger(SocialPostPublishProcessor.name);

  constructor(private readonly socialPostsService: SocialPostsService) {
    super();
  }

  async process(job: Job<SocialPostPublishJobData>): Promise<void> {
    const { tenantId, postId, batchId } = job.data;
    this.logger.log(
      `Publishing social post ${postId} batch ${batchId} for tenant ${tenantId} (attempt ${job.attemptsMade + 1}/${job.opts.attempts})`,
    );
    await this.socialPostsService.publishPostById(tenantId, postId, batchId);
  }
}
