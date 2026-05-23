import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';
import { AiVideoPublishTaskRepository } from '../repositories/ai-video-publish-task.repository';
import { AiVideoJobService } from './ai-video-job.service';
import { AiVideoAuditLogRepository } from '../repositories/ai-video-audit-log.repository';
import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';

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
    const channel = await this.channelRepository.findByAccountWithCredentials(
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

    let filePath = '';
    let isTempFile = false;

    try {
      // 4. Resolve video file path
      if (videoUrl.startsWith('/') || videoUrl.includes('/files/')) {
        const fileName = path.basename(videoUrl);
        filePath = path.join(process.cwd(), 'files', fileName);
        if (!fs.existsSync(filePath)) {
          filePath = path.join(
            '/tmp',
            'crm-render',
            tenantId,
            `ai-video-${jobId}.mp4`,
          );
        }
      }

      if (!filePath || !fs.existsSync(filePath)) {
        if (videoUrl.startsWith('http')) {
          const tempDir = path.join('/tmp', 'crm-render', tenantId);
          fs.mkdirSync(tempDir, { recursive: true });
          filePath = path.join(tempDir, `downloaded_${jobId}.mp4`);

          this.logger.log(
            `Downloading remote video from ${videoUrl} to ${filePath}...`,
          );
          const writer = fs.createWriteStream(filePath);
          const downloadResponse = await axios({
            method: 'get',
            url: videoUrl,
            responseType: 'stream',
          });

          downloadResponse.data.pipe(writer);
          await new Promise<void>((resolve, reject) => {
            writer.on('finish', () => resolve());
            writer.on('error', (err) => reject(err));
          });
          isTempFile = true;
        } else {
          throw new NotFoundException(
            `Could not resolve video file path for: ${videoUrl}`,
          );
        }
      }

      if (!fs.existsSync(filePath)) {
        throw new NotFoundException(
          `Resolved video file does not exist: ${filePath}`,
        );
      }

      const fileSize = fs.statSync(filePath).size;
      this.logger.log(
        `Starting real resumable chunked video upload to Facebook Page ${facebookPageId} for job ${jobId}. File size: ${fileSize} bytes`,
      );

      // --- PHASE 1: INIT ---
      this.logger.log(
        `[ChunkUpload] Phase 1 - Initializing upload session for job ${jobId}...`,
      );

      const initResponse = await axios.post(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${facebookPageId}/videos`,
        null,
        {
          params: {
            upload_phase: 'start',
            access_token: accessToken,
            file_size: fileSize,
          },
        },
      );

      const {
        upload_session_id: uploadSessionId,
        video_id: platformVideoIdTemp,
        start_offset: startOffsetStr,
        end_offset: endOffsetStr,
      } = initResponse.data;

      this.logger.log(
        `[ChunkUpload] Phase 1 Completed. Session ID: ${uploadSessionId}, Video ID: ${platformVideoIdTemp}, Start Offset: ${startOffsetStr}, End Offset: ${endOffsetStr}`,
      );

      await this.auditLogRepository.record({
        tenantId,
        jobId,
        action: 'PUBLISH_INITIATED',
        actorType: 'system',
        oldStatus: 'PUBLISHING',
        newStatus: 'PUBLISHING',
        payload: {
          phase: 'INIT',
          uploadSessionId,
          videoId: platformVideoIdTemp,
          fileSizeEstimateBytes: fileSize,
        },
      });

      // --- PHASE 2: TRANSFER ---
      let startOffset = parseInt(startOffsetStr, 10);
      let endOffset = parseInt(endOffsetStr, 10);
      const fd = fs.openSync(filePath, 'r');
      let chunkIdx = 0;

      try {
        while (startOffset < fileSize && startOffset !== endOffset) {
          const length = endOffset - startOffset;
          const chunkBuffer = Buffer.alloc(length);
          const bytesRead = fs.readSync(
            fd,
            chunkBuffer,
            0,
            length,
            startOffset,
          );

          this.logger.log(
            `[ChunkUpload] Transferring chunk ${chunkIdx + 1}: bytes ${startOffset}-${endOffset}/${fileSize} (${bytesRead} read)...`,
          );

          const form = new FormData();
          form.append('upload_phase', 'transfer');
          form.append('access_token', accessToken);
          form.append('upload_session_id', uploadSessionId);
          form.append('start_offset', startOffset.toString());
          form.append('video_file_chunk', chunkBuffer, {
            filename: 'chunk.mp4',
            contentType: 'video/mp4',
          });

          const transferResponse = await axios.post(
            `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${facebookPageId}/videos`,
            form,
            {
              headers: form.getHeaders(),
              maxContentLength: Infinity,
              maxBodyLength: Infinity,
            },
          );

          const nextStartOffset = parseInt(
            transferResponse.data.start_offset,
            10,
          );
          const nextEndOffset = parseInt(transferResponse.data.end_offset, 10);

          await this.auditLogRepository.record({
            tenantId,
            jobId,
            action: 'PUBLISH_CHUNK_TRANSFERRED',
            actorType: 'system',
            oldStatus: 'PUBLISHING',
            newStatus: 'PUBLISHING',
            payload: {
              phase: 'TRANSFER',
              chunkIndex: chunkIdx + 1,
              bytesSent: length,
              startOffset,
              endOffset,
            },
          });

          startOffset = nextStartOffset;
          endOffset = nextEndOffset;
          chunkIdx++;
        }
      } finally {
        fs.closeSync(fd);
      }

      // --- PHASE 3: FINISH ---
      this.logger.log(
        `[ChunkUpload] Phase 3 - Finishing upload and registering Reels on page ${facebookPageId}...`,
      );

      const finishResponse = await axios.post(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${facebookPageId}/videos`,
        null,
        {
          params: {
            upload_phase: 'finish',
            access_token: accessToken,
            upload_session_id: uploadSessionId,
            description: caption,
          },
        },
      );

      const platformVideoId = finishResponse.data.id;

      // 5. Update publish task and job as successful
      await this.publishTaskRepository.updateStatus(
        publishTask._id.toString(),
        'SUCCESS',
        {
          platformVideoId,
          platformResponseRaw: finishResponse.data,
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
          uploadSessionId,
        },
      });

      this.logger.log(
        `Successfully published chunked video for job ${jobId}. Platform ID: ${platformVideoId}`,
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
      await this.jobService.markAsFailed(
        jobId,
        `[${errorCode}] ${errorMessage}`,
      );

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
    } finally {
      if (isTempFile && filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          this.logger.log(`Cleaned up temporary downloaded video: ${filePath}`);
        } catch (cleanupErr: any) {
          this.logger.error(
            `Failed to clean up temporary video: ${cleanupErr.message}`,
          );
        }
      }
    }
  }
}
