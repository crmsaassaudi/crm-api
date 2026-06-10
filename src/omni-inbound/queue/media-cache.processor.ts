import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  BaseTenantConsumer,
  TenantJobData,
} from '../../queue/base-tenant.consumer';
import { MediaProxyService } from '../services/media-proxy.service';
import { MessageRepository } from '../repositories/message.repository';
import { OMNI_MEDIA_CACHE_QUEUE } from './omni-media-queue.constants';

export interface MediaCacheJobData extends TenantJobData {
  conversationId: string;
  messageId: string;
  mediaUrl: string;
  channelType: string;
  mediaId: string;
  accessToken?: string;
}

/**
 * BullMQ processor that handles asynchronous media caching.
 *
 * When a message with media arrives, the main inbound flow saves the message
 * immediately (with the original provider URL) and enqueues a job here.
 *
 * This processor:
 *   1. Downloads the media file from the provider
 *   2. Compresses images and generates thumbnails
 *   3. Stores in S3 via MediaProxyService (idempotent by messageId)
 *   4. Updates the message record with the stable presigned URL
 *   5. Emits a WebSocket event so the frontend can swap the URL in real-time
 *
 * Benefits:
 *   - Messages appear instantly (no download delay)
 *   - The distributed lock (per-sender) is released immediately
 *   - Large files and slow networks don't block the inbound pipeline
 *   - Automatic retries via BullMQ (3 attempts, exponential backoff)
 *   - Idempotent: re-processing the same messageId is safe (upsert)
 */
@Processor(OMNI_MEDIA_CACHE_QUEUE)
export class MediaCacheProcessor extends BaseTenantConsumer<MediaCacheJobData> {
  protected readonly logger = new Logger(MediaCacheProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    private readonly mediaProxy: MediaProxyService,
    private readonly messageRepo: MessageRepository,
    private readonly eventEmitter: EventEmitter2,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<MediaCacheJobData>): Promise<void> {
    const {
      tenantId,
      conversationId,
      messageId,
      mediaUrl,
      channelType,
      mediaId,
      accessToken,
    } = job.data;

    this.logger.log(
      `Processing media cache job ${job.id} — ${channelType} media for message ${messageId}`,
    );

    try {
      // Step 1: Download, compress, store, and create file record
      const { proxyUrl, fileId } = await this.mediaProxy.cacheMedia(
        tenantId,
        channelType,
        mediaUrl,
        mediaId,
        conversationId,
        messageId,
        accessToken,
      );

      // Step 2: If the proxy URL is the same as original, caching failed or was skipped
      // (e.g. quota exceeded) — no need to update
      if (proxyUrl === mediaUrl) {
        this.logger.debug(
          `Media cache returned original URL for message ${messageId} — skipping update`,
        );
        return;
      }

      // Step 3: Update the message record with the stable proxy URL
      await this.messageRepo.updateMediaProxyUrl(messageId, proxyUrl);

      // Step 4: Emit event for real-time frontend notification
      this.eventEmitter.emit('omni.message.media_cached', {
        tenantId,
        conversationId,
        messageId,
        mediaProxyUrl: proxyUrl,
        fileId,
      });

      this.logger.log(
        `Media cached successfully for message ${messageId}: ${fileId ?? 'no-file-id'}`,
      );
    } catch (error: any) {
      // Check if this is the last attempt
      const isLastAttempt = job.attemptsMade >= (job.opts?.attempts ?? 3) - 1;

      if (isLastAttempt) {
        this.logger.error(
          `Final attempt failed to cache media for message ${messageId}: ${error.message}`,
          error.stack,
        );

        // Emit event so frontend can show "Media unavailable"
        this.eventEmitter.emit('omni.message.media_cache_failed', {
          tenantId,
          conversationId,
          messageId,
          error: error.message,
        });
      } else {
        this.logger.warn(
          `Attempt ${job.attemptsMade + 1} failed to cache media for message ${messageId}: ${error.message}`,
        );
      }

      throw error; // Re-throw so BullMQ retries
    }
  }
}
