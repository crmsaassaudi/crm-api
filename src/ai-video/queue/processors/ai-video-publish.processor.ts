import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AI_VIDEO_PUBLISH_QUEUE } from '../ai-video-queue.constants';
import { FacebookPublisherService } from '../../services/facebook-publisher.service';

export interface AiVideoPublishJobData {
  tenantId: string;
  jobId: string;
  facebookPageId: string;
  videoUrl: string;
  caption: string;
}

/**
 * BullMQ processor for async video publishing to Facebook.
 *
 * This processor is only instantiated in the worker runtime
 * (when APP_RUNTIME=worker), keeping the API process lightweight.
 */
@Processor(AI_VIDEO_PUBLISH_QUEUE)
export class AiVideoPublishProcessor extends WorkerHost {
  private readonly logger = new Logger(AiVideoPublishProcessor.name);

  constructor(
    private readonly publisherService: FacebookPublisherService,
  ) {
    super();
  }

  async process(job: Job<AiVideoPublishJobData>): Promise<any> {
    const { tenantId, jobId, facebookPageId, videoUrl, caption } = job.data;

    this.logger.log(
      `Processing publish job ${job.id} for video job ${jobId} (attempt ${job.attemptsMade + 1}/${job.opts.attempts})`,
    );

    try {
      const result = await this.publisherService.publishVideo(
        tenantId,
        jobId,
        facebookPageId,
        videoUrl,
        caption,
      );

      this.logger.log(
        `Publish job ${job.id} completed. Platform video ID: ${result.platformVideoId}`,
      );

      return { success: true, ...result };
    } catch (error: any) {
      this.logger.error(
        `Publish job ${job.id} failed on attempt ${job.attemptsMade + 1}: ${error.message}`,
      );
      // Re-throw so BullMQ applies the configured retry backoff
      throw error;
    }
  }
}
