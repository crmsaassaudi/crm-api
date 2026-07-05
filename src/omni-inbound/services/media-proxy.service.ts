import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomStringGenerator } from '@nestjs/common/utils/random-string-generator.util';
import * as crypto from 'crypto';

import { TenantsService } from '../../tenants/tenants.service';
import { FilesService } from '../../files/files.service';
import { ImageProcessingService } from '../../files/image-processing.service';
import { detectMimeFromBuffer } from '../../files/file-upload-security.util';
import { AllConfigType } from '../../config/config.type';

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
        configService.get('file.awsS3Endpoint', { infer: true }) ?? undefined,
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
    if (!(await this.checkQuotaOrWarn(tenantId))) {
      return { proxyUrl: originalUrl };
    }

    try {
      // ── Download ─────────────────────────────────────────────────
      const buffer = await this.downloadFromProvider(
        channelType,
        originalUrl,
        mediaId,
        accessToken,
      );

      // ── Detect & compress ────────────────────────────────────────
      const detectedMime =
        detectMimeFromBuffer(buffer) ?? 'application/octet-stream';
      const compressed = await this.compressIfImage(buffer, detectedMime);

      // ── Upload to S3 + thumbnail ─────────────────────────────────
      const ext = this.getExtensionFromMime(compressed.mimeType);
      const storageKey = `${tenantId}/omni-media/${randomStringGenerator()}.${ext}`;
      await this.uploadToS3(
        storageKey,
        compressed.buffer,
        compressed.mimeType,
        {
          tenantId,
          messageId,
          channelType,
          originalMediaId: mediaId,
        },
      );

      const thumbnailKey = await this.generateImageThumbnail(
        tenantId,
        buffer,
        detectedMime,
        'omni-media/thumbs',
      );

      // ── Persist + quota ──────────────────────────────────────────
      const checksum = crypto
        .createHash('sha256')
        .update(compressed.buffer)
        .digest('hex');

      const { file, isNew } = await this.filesService.upsertByMessageId(
        tenantId,
        messageId,
        {
          path: storageKey,
          fileName: `${mediaId}.${ext}`,
          mimeType: compressed.mimeType,
          fileSize: compressed.buffer.length,
          checksum,
          category: 'omni_media',
          source: 'omni_inbound',
          status: 'ready',
          accessLevel: 'tenant',
          conversationId,
          messageId,
          thumbnailKey,
          imageMetadata: compressed.imageMetadata,
          tags: [channelType],
        },
      );

      if (isNew) {
        await this.tryIncrementQuota(tenantId, compressed.buffer.length);
      }

      // ── Presigned URL ────────────────────────────────────────────
      const proxyUrl = await this.getPresignedUrl(storageKey);

      this.logger.log(
        `Media cached: ${channelType}/${mediaId} → ${storageKey} (${(compressed.buffer.length / 1024).toFixed(0)}KB, ${isNew ? 'new' : 'dedup'})`,
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

  /** Quick quota pre-check; returns true if caching should proceed. */
  private async checkQuotaOrWarn(tenantId: string): Promise<boolean> {
    try {
      const quota = await this.tenantsService.checkStorageQuota(tenantId);
      if (!quota.allowed) {
        this.logger.warn(
          `Tenant ${tenantId} storage quota exceeded ` +
            `(${(quota.usedBytes / (1024 * 1024)).toFixed(1)}/${quota.limitBytes === -1 ? 'unlimited' : (quota.limitBytes / (1024 * 1024)).toFixed(0)} MB) — returning original URL`,
        );
        return false;
      }
    } catch (err) {
      this.logger.warn(
        `Quota check failed for tenant ${tenantId}: ${(err as Error).message} — proceeding with cache`,
      );
    }
    return true;
  }

  /** Compress image buffers; returns original data for non-images. */
  private async compressIfImage(
    buffer: Buffer,
    detectedMime: string,
  ): Promise<{
    buffer: Buffer;
    mimeType: string;
    imageMetadata?: {
      width: number;
      height: number;
      originalMimeType: string;
      originalSize: number;
    };
  }> {
    const isImage = detectedMime.startsWith('image/');
    if (
      !isImage ||
      !this.imageProcessingService.isProcessableImage(detectedMime)
    ) {
      return { buffer, mimeType: detectedMime };
    }
    try {
      const compressed = await this.imageProcessingService.compressForStorage(
        buffer,
        detectedMime,
      );
      return {
        buffer: compressed.buffer,
        mimeType: compressed.mimeType,
        imageMetadata: {
          width: compressed.width,
          height: compressed.height,
          originalMimeType: detectedMime,
          originalSize: buffer.length,
        },
      };
    } catch (err) {
      this.logger.warn(
        `Image compression failed, using original: ${(err as Error).message}`,
      );
      return { buffer, mimeType: detectedMime };
    }
  }

  /** Upload a buffer to S3 with the given key. */
  private async uploadToS3(
    key: string,
    body: Buffer,
    contentType: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: metadata,
      }),
    );
  }

  /** Generate an image thumbnail and upload to S3; returns the key or undefined. */
  private async generateImageThumbnail(
    tenantId: string,
    buffer: Buffer,
    detectedMime: string,
    subPath: string,
  ): Promise<string | undefined> {
    const isImage = detectedMime.startsWith('image/');
    if (
      !isImage ||
      !this.imageProcessingService.isProcessableImage(detectedMime)
    ) {
      return undefined;
    }
    try {
      const thumbBuffer =
        await this.imageProcessingService.generateThumbnail(buffer);
      const thumbnailKey = `${tenantId}/${subPath}/${randomStringGenerator()}.webp`;
      await this.uploadToS3(thumbnailKey, thumbBuffer, 'image/webp', {
        tenantId,
      });
      return thumbnailKey;
    } catch (err) {
      this.logger.warn(
        `Thumbnail generation failed: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /** Best-effort quota increment. */
  private async tryIncrementQuota(
    tenantId: string,
    bytes: number,
  ): Promise<void> {
    try {
      const withinQuota = await this.tenantsService.incrementStorageUsage(
        tenantId,
        bytes,
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

  /**
   * Generate a presigned download URL for a stored media file.
   */
  async getPresignedUrl(
    storageKey: string,
    ttlSeconds = 3600,
  ): Promise<string> {
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
      (h) => hostname === h || (h.startsWith('.') && hostname.endsWith(h)),
    );

    if (!isAllowed) {
      this.logger.warn(
        `[HIGH-12] SSRF blocked: media download from non-allowlisted host: ${hostname}`,
      );
      throw new Error(`SSRF blocked: host ${hostname} not in allowlist`);
    }
  }
}
