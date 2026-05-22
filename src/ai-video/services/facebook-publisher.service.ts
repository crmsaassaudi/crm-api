import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';
import { AiVideoPublishTaskRepository } from '../repositories/ai-video-publish-task.repository';
import { AiVideoJobService } from './ai-video-job.service';
import { AiVideoAuditLogRepository } from '../repositories/ai-video-audit-log.repository';
import axios, { AxiosError } from 'axios';

const META_GRAPH_API_VERSION = 'v20.0';

/**
 * Service responsible for uploading videos to Facebook Pages via Meta Graph API.
 *
 * Phase 1A: Direct URL-based upload (file_url).
 * Phase 1B: Chunked/resumable upload for large files.
 *
 * Reuses the access token stored in the existing `channels` module's
 * repository — no OAuth credentials are duplicated.
 */
@Injectable()
export class FacebookPublisherService {
  private readonly logger = new Logger(FacebookPublisherService.name);

  constructor(
    private readonly channelRepository: ChannelRepository,
    private readonly publishTaskRepository: AiVideoPublishTaskRepository,
    private readonly jobService: AiVideoJobService,
    private readonly auditLogRepository: AiVideoAuditLogRepository,
  ) {}

  /**
   * Publish a video to a Facebook Page.
   *
   * @param tenantId - The tenant context
   * @param jobId - The AI Video Job ID
   * @param facebookPageId - The target Facebook Page account ID
   * @param videoUrl - A publicly-accessible URL to the video file
   * @param caption - The post description/caption
   */
  async publishVideo(
    tenantId: string,
    jobId: string,
    facebookPageId: string,
    videoUrl: string,
    caption: string,
  ): Promise<{ platformVideoId: string; platformPostId?: string }> {
    // 1. Fetch page access token from the channels integration
    const channel =
      await this.channelRepository.findByAccountWithCredentials(
        tenantId,
        'facebook',
        facebookPageId,
      );

    if (!channel?.credentials?.accessToken) {
      const errorMsg = `Facebook Page ${facebookPageId} is not connected or missing access token for tenant ${tenantId}`;
      this.logger.error(errorMsg);
      throw new NotFoundException(errorMsg);
    }

    const accessToken = channel.credentials.accessToken;

    // 2. Create (or update) a publish task record for tracking
    let publishTask = await this.publishTaskRepository.findByJobId(
      tenantId,
      jobId,
    );
    if (!publishTask) {
      publishTask = await this.publishTaskRepository.create({
        tenantId,
        jobId,
        platform: 'facebook',
        facebookPageId,
        scheduledAt: new Date(),
        status: 'PUBLISHING',
      });
    } else {
      await this.publishTaskRepository.updateStatus(
        publishTask._id.toString(),
        'PUBLISHING',
      );
    }

    // 3. Update job status to PUBLISHING
    await this.jobService.updateStatus(jobId, 'PUBLISHING');

    await this.auditLogRepository.record({
      tenantId,
      jobId,
      action: 'PUBLISH_STARTED',
      actorType: 'system',
      oldStatus: 'SCHEDULED',
      newStatus: 'PUBLISHING',
      payload: { facebookPageId, videoUrl },
    });

    try {
      // 4. Upload via Meta Graph API (Phase 1A: URL-based upload)
      this.logger.log(
        `Starting video upload to Facebook Page ${facebookPageId} for job ${jobId}`,
      );

      const response = await axios.post(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${facebookPageId}/videos`,
        {
          file_url: videoUrl,
          description: caption,
          access_token: accessToken,
        },
      );

      const platformVideoId: string = response.data.id;

      // 5. Update publish task and job as successful
      await this.publishTaskRepository.updateStatus(
        publishTask._id.toString(),
        'SUCCESS',
        {
          platformVideoId,
          platformResponseRaw: response.data,
        },
      );

      await this.jobService.markAsPublished(jobId, platformVideoId);

      await this.auditLogRepository.record({
        tenantId,
        jobId,
        action: 'PUBLISHED',
        actorType: 'system',
        oldStatus: 'PUBLISHING',
        newStatus: 'PUBLISHED',
        payload: {
          platformVideoId,
          facebookPageId,
        },
      });

      this.logger.log(
        `Successfully published video for job ${jobId}. Platform ID: ${platformVideoId}`,
      );

      return { platformVideoId };
    } catch (error) {
      const axiosError = error as AxiosError<any>;
      const errorCode =
        axiosError.response?.data?.error?.code?.toString() ?? 'UNKNOWN';
      const errorMessage =
        axiosError.response?.data?.error?.message ??
        axiosError.message ??
        'Unknown publishing error';

      this.logger.error(
        `Failed to publish video for job ${jobId}: [${errorCode}] ${errorMessage}`,
      );

      // Record failure in publish task
      await this.publishTaskRepository.recordRetry(
        publishTask._id.toString(),
        errorCode,
        errorMessage,
      );

      // Update job status to PUBLISH_FAILED
      await this.jobService.markAsFailed(jobId, `[${errorCode}] ${errorMessage}`);

      await this.auditLogRepository.record({
        tenantId,
        jobId,
        action: 'PUBLISH_FAILED',
        actorType: 'system',
        oldStatus: 'PUBLISHING',
        newStatus: 'PUBLISH_FAILED',
        errorMessage: `[${errorCode}] ${errorMessage}`,
        payload: {
          facebookPageId,
          metaErrorCode: errorCode,
          retryCount: (publishTask.retryCount ?? 0) + 1,
        },
      });

      throw error;
    }
  }
}
