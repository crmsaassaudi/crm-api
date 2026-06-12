import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomStringGenerator } from '@nestjs/common/utils/random-string-generator.util';
import * as crypto from 'crypto';

import { TenantsService } from '../../tenants/tenants.service';
import { FilesService } from '../../files/files.service';
import { ImageProcessingService } from '../../files/image-processing.service';
import { detectMimeFromBuffer } from '../../files/file-upload-security.util';
import { AllConfigType } from '../../config/config.type';
import { ChannelType } from '../domain/omni-payload';

/**
 * `fetch` with a hard timeout via AbortController. Node's global fetch has
 * no default timeout, so a hung provider can pin a worker forever.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Service for proxying and caching media files from messaging providers.
 *
 * Problem:
 * - Zalo media URLs expire after ~30 minutes
 * - WhatsApp media requires an access token to download
 * - Facebook media URLs may become unavailable after account changes
 *
 * Solution:
 * - On receiving a media message, download the file immediately
 * - Compress images with ImageProcessingService
 * - Store in S3 (DigitalOcean Spaces) with tenant-isolated paths
 * - Create idempotent file record via upsertByMessageId
 * - Return a presigned URL that the frontend can use
 */
@Injectable()
export class MediaProxyService {
  private readonly logger = new Logger(MediaProxyService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly configService: ConfigService<AllConfigType>,
    private readonly tenantsService: TenantsService,
    private readonly filesService: FilesService,
    private readonly imageProcessingService: ImageProcessingService,
  ) {
    this.bucket =
      configService.get('file.awsDefaultS3Bucket', { infer: true }) ?? '';
    this.s3 = new S3Client({
      region: configService.get('file.awsS3Region', { infer: true }),
      endpoint:
        configService.get('file.awsS3Endpoint', { infer: true }) || undefined,
      forcePathStyle: !!configService.get('file.awsS3Endpoint', {
        infer: true,
      }),
      credentials: {
        accessKeyId:
          configService.get('file.accessKeyId', { infer: true }) ?? '',
        secretAccessKey:
          configService.get('file.secretAccessKey', { infer: true }) ?? '',
      },
      maxAttempts: 3,
    });
  }

  /**
   * Download and cache a media file from a provider.
   *
   * Flow:
   * 1. Quota check (fast fail)
   * 2. Download from provider
   * 3. Detect MIME type from magic bytes
   * 4. Compress if image
   * 5. Upload to S3 with tenant-isolated key
   * 6. Generate thumbnail (images only)
   * 7. Upsert file record (idempotent by messageId)
   * 8. Increment quota (only on NEW records)
   * 9. Return presigned URL
   *
   * If quota is exceeded, returns the original URL (file not cached).
   * If any step fails, returns the original URL as fallback.
   */
  async cacheMedia(
    tenantId: string,
    channelType: string,
    originalUrl: string,
    mediaId: string,
    conversationId: string,
    messageId: string,
    accessToken?: string,
  ): Promise<{ proxyUrl: string; fileId?: string }> {
    this.logger.log(
      `Caching media: ${channelType} / ${mediaId} for message ${messageId}`,
    );

    // ── Quota check ────────────────────────────────────────────────
    try {
      const quota = await this.tenantsService.checkStorageQuota(tenantId);
      if (!quota.allowed) {
        this.logger.warn(
          `Tenant ${tenantId} storage quota exceeded ` +
            `(${(quota.usedBytes / (1024 * 1024)).toFixed(1)}/${quota.limitBytes === -1 ? 'unlimited' : (quota.limitBytes / (1024 * 1024)).toFixed(0)} MB) — returning original URL`,
        );
        return { proxyUrl: originalUrl };
      }
    } catch (err) {
      this.logger.warn(
        `Quota check failed for tenant ${tenantId}: ${(err as Error).message} — proceeding with cache`,
      );
    }

    try {
      // ── Step 1: Download from provider ────────────────────────────
      const buffer = await this.downloadFromProvider(
        channelType,
        originalUrl,
        mediaId,
        accessToken,
      );

      // ── Step 2: Detect MIME from magic bytes ──────────────────────
      const detectedMime =
        detectMimeFromBuffer(buffer) || 'application/octet-stream';
      const isImage = detectedMime.startsWith('image/');

      // ── Step 3: Compress if image ─────────────────────────────────
      let uploadBuffer = buffer;
      let uploadMimeType = detectedMime;
      let imageWidth: number | undefined;
      let imageHeight: number | undefined;
      let originalMimeType: string | undefined;
      let originalSize: number | undefined;

      if (isImage && this.imageProcessingService.isProcessableImage(detectedMime)) {
        try {
          const compressed =
            await this.imageProcessingService.compressForStorage(
              buffer,
              detectedMime,
            );
          uploadBuffer = compressed.buffer;
          uploadMimeType = compressed.mimeType;
          imageWidth = compressed.width;
          imageHeight = compressed.height;
          originalMimeType = detectedMime;
          originalSize = buffer.length;
        } catch (err) {
          this.logger.warn(
            `Image compression failed, using original: ${(err as Error).message}`,
          );
        }
      }

      // ── Step 4: Upload to S3 ──────────────────────────────────────
      const ext = this.getExtensionFromMime(uploadMimeType);
      const storageKey = `${tenantId}/omni-media/${randomStringGenerator()}.${ext}`;

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
          Body: uploadBuffer,
          ContentType: uploadMimeType,
          Metadata: {
            tenantId,
            messageId,
            channelType,
            originalMediaId: mediaId,
          },
        }),
      );

      // ── Step 5: Generate thumbnail (images only) ──────────────────
      let thumbnailKey: string | undefined;
      if (isImage && this.imageProcessingService.isProcessableImage(detectedMime)) {
        try {
          const thumbBuffer =
            await this.imageProcessingService.generateThumbnail(buffer);
          thumbnailKey = `${tenantId}/omni-media/thumbs/${randomStringGenerator()}.webp`;
          await this.s3.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: thumbnailKey,
              Body: thumbBuffer,
              ContentType: 'image/webp',
              Metadata: { tenantId },
            }),
          );
        } catch (err) {
          this.logger.warn(
            `Thumbnail generation failed: ${(err as Error).message}`,
          );
        }
      }

      // ── Step 6: Checksum ──────────────────────────────────────────
      const checksum = crypto
        .createHash('sha256')
        .update(uploadBuffer)
        .digest('hex');

      // ── Step 7: Upsert file record (idempotent by messageId) ──────
      const { file, isNew } = await this.filesService.upsertByMessageId(
        tenantId,
        messageId,
        {
          path: storageKey,
          fileName: `${mediaId}.${ext}`,
          mimeType: uploadMimeType,
          fileSize: uploadBuffer.length,
          checksum,
          category: 'omni_media',
          source: 'omni_inbound',
          status: 'ready',
          accessLevel: 'tenant',
          conversationId,
          messageId,
          thumbnailKey,
          imageMetadata:
            imageWidth || imageHeight
              ? {
                  width: imageWidth,
                  height: imageHeight,
                  originalMimeType,
                  originalSize,
                }
              : undefined,
          tags: [channelType],
        },
      );

      // ── Step 8: Increment quota (only on new records) ─────────────
      if (isNew) {
        try {
          const withinQuota = await this.tenantsService.incrementStorageUsage(
            tenantId,
            uploadBuffer.length,
          );
          if (!withinQuota) {
            this.logger.warn(
              `Quota increment rejected for tenant ${tenantId} — file stored but quota not updated`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `Failed to increment storage for tenant ${tenantId}: ${(err as Error).message}`,
          );
        }
      }

      // ── Step 9: Generate presigned URL ────────────────────────────
      const proxyUrl = await this.getPresignedUrl(storageKey);

      this.logger.log(
        `Media cached: ${channelType}/${mediaId} → ${storageKey} (${(uploadBuffer.length / 1024).toFixed(0)}KB, ${isNew ? 'new' : 'dedup'})`,
      );

      return { proxyUrl, fileId: file.id };
    } catch (error) {
      this.logger.error(
        `Failed to cache media ${mediaId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return { proxyUrl: originalUrl };
    }
  }

  /**
   * Generate a presigned download URL for a stored media file.
   */
  async getPresignedUrl(storageKey: string, ttlSeconds = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
    });
    return getSignedUrl(this.s3, command, { expiresIn: ttlSeconds });
  }

  /**
   * Get the stored media file as a buffer (for proxy endpoint fallback).
   */
  async getMedia(storageKey: string): Promise<Buffer | null> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
        }),
      );
      if (!response.Body) return null;
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (err) {
      this.logger.warn(
        `Failed to retrieve media ${storageKey}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Download media from provider API.
   * WhatsApp requires fetching the download URL first via Graph API.
   */
  private async downloadFromProvider(
    channelType: string,
    originalUrl: string,
    mediaId: string,
    accessToken?: string,
  ): Promise<Buffer> {
    let downloadUrl = originalUrl;

    if (channelType === 'whatsapp' && accessToken) {
      // WA: media ID → Graph API → download URL
      const graphResponse = await fetchWithTimeout(
        `https://graph.facebook.com/v18.0/${mediaId}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        10_000,
      );
      const graphData = await graphResponse.json();
      downloadUrl = graphData.url;
    }

    // HIGH-12: SSRF guard — validate URL before fetching.
    // A crafted webhook payload could supply a media URL pointing to internal
    // services (e.g., http://169.254.169.254/latest/meta-data/) allowing cloud
    // credential exfiltration via the CRM's server-side fetch.
    this.validateDownloadUrl(downloadUrl);

    const response = await fetchWithTimeout(
      downloadUrl,
      {
        headers: accessToken
          ? { Authorization: `Bearer ${accessToken}` }
          : undefined,
      },
      30_000,
    );

    if (!response.ok) {
      throw new Error(
        `Failed to download media: ${response.status} ${response.statusText}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Map MIME type to a safe file extension.
   */
  private getExtensionFromMime(mimeType: string): string {
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'audio/aac': 'aac',
      'audio/amr': 'amr',
      'audio/mp4': 'm4a',
      'application/pdf': 'pdf',
    };
    return map[mimeType.toLowerCase()] || 'bin';
  }

  /**
   * HIGH-12: Validate a download URL to prevent SSRF attacks.
   * Only allows HTTPS URLs from known media provider domains.
   */
  private validateDownloadUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid media URL: ${url}`);
    }

    // Enforce HTTPS only
    if (parsed.protocol !== 'https:') {
      throw new Error(
        `SSRF blocked: media URL must use HTTPS (got ${parsed.protocol})`,
      );
    }

    // Known provider CDN domains — extend as needed
    const ALLOWED_HOSTS = [
      'graph.facebook.com',
      '.fbcdn.net',
      '.whatsapp.net',
      '.whatsapp.biz',
      '.xx.fbcdn.net',
      '.zalo.me',
      '.zadn.vn',
      '.zdn.vn',
      // Instagram CDN domains
      '.cdninstagram.com',
      '.instagram.com',
    ];

    const hostname = parsed.hostname.toLowerCase();
    const isAllowed = ALLOWED_HOSTS.some(
      (h) =>
        hostname === h ||
        (h.startsWith('.') && hostname.endsWith(h)),
    );

    if (!isAllowed) {
      this.logger.warn(
        `[HIGH-12] SSRF blocked: media download from non-allowlisted host: ${hostname}`,
      );
      throw new Error(`SSRF blocked: host ${hostname} not in allowlist`);
    }
  }
}
