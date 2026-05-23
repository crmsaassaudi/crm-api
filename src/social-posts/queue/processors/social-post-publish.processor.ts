import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PUBLICATION_INSTANCE_PUBLISH_QUEUE } from '../social-post-queue.constants';
import { PublicationPublishJobData } from '../../social-posts.types';
import { SocialContentAssetsService } from '../../services/social-posts.service';

@Processor(PUBLICATION_INSTANCE_PUBLISH_QUEUE, {
  limiter: {
    max: 30,
    duration: 60_000,
  },
})
export class PublicationInstancePublishProcessor extends WorkerHost {
  private readonly logger = new Logger(
    PublicationInstancePublishProcessor.name,
  );

  constructor(private readonly service: SocialContentAssetsService) {
    super();
  }

  async process(job: Job<PublicationPublishJobData>): Promise<void> {
    const { tenantId, publicationInstanceId } = job.data;
    this.logger.log(
      `Publishing publication instance ${publicationInstanceId} for tenant ${tenantId} (attempt ${job.attemptsMade + 1}/${job.opts.attempts})`,
    );
    await this.service.publishPublicationInstanceById(
      tenantId,
      publicationInstanceId,
    );
  }
}
