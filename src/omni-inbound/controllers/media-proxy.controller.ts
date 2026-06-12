import {
  Controller,
  Get,
  Param,
  Res,
  HttpStatus,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { MediaProxyService } from '../services/media-proxy.service';
import { FilesService } from '../../files/files.service';

/**
 * Serves cached/proxied media files.
 *
 * Two serving strategies:
 * 1. Redirect to presigned S3 URL (preferred — offloads bandwidth to CDN/S3)
 * 2. Stream through backend (fallback for clients that can't follow redirects)
 *
 * URL: GET /omni/media/:storageKey
 *
 * This gives agents a stable URL to view images and files
 * even after the provider's original URL has expired (Zalo).
 *
 * CRIT-02: Auth required + tenant-prefix validation.
 * Previously @Public() — any unauthenticated request could sign/stream
 * any S3 object in the shared bucket, including cross-tenant PII exports.
 */
@Controller({ path: 'omni/media', version: '1' })
export class MediaProxyController {
  private readonly logger = new Logger(MediaProxyController.name);

  constructor(
    private readonly mediaProxyService: MediaProxyService,
    private readonly filesService: FilesService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Redirect to a presigned S3 URL for the media file.
   * This is the preferred approach — S3/CDN handles the bandwidth.
   */
  @Get('redirect/*storageKey')
  async redirectToMedia(
    @Param('storageKey') storageKey: string,
    @Res() res: Response,
  ) {
    this.assertTenantOwnsKey(storageKey);

    try {
      const presignedUrl =
        await this.mediaProxyService.getPresignedUrl(storageKey);
      return res.redirect(HttpStatus.TEMPORARY_REDIRECT, presignedUrl);
    } catch (err) {
      this.logger.warn(
        `Failed to generate presigned URL for ${storageKey}: ${(err as Error).message}`,
      );
      throw new NotFoundException('Media not found');
    }
  }

  /**
   * Stream the media file through the backend.
   * Used as a fallback or for specific security requirements.
   */
  @Get('*storageKey')
  async getMedia(
    @Param('storageKey') storageKey: string,
    @Res() res: Response,
  ) {
    this.assertTenantOwnsKey(storageKey);

    this.logger.debug(`Serving media: ${storageKey}`);

    const buffer = await this.mediaProxyService.getMedia(storageKey);
    if (!buffer) {
      throw new NotFoundException('Media not found');
    }

    // Detect content type from the file extension
    const contentType = this.getContentType(storageKey);

    res
      .status(HttpStatus.OK)
      .header('Content-Type', contentType)
      .header('Content-Length', String(buffer.length))
      .header('Cache-Control', 'public, max-age=86400, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'attachment')
      .send(buffer);
  }

  /**
   * CRIT-02: Validate that the authenticated user's tenant owns the
   * requested storage key. S3 keys are structured as:
   *   ${tenantId}/omni-media/${randomId}.${ext}
   *
   * Without this check, any authenticated user could access another
   * tenant's media by guessing/learning a storage key.
   */
  private assertTenantOwnsKey(storageKey: string): void {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new ForbiddenException('Authentication required');
    }

    // The storage key must start with the caller's tenantId
    const keyTenantId = storageKey.split('/')[0];
    if (keyTenantId !== tenantId) {
      this.logger.warn(
        `[CRIT-02] Cross-tenant media access blocked: tenant=${tenantId} tried key=${storageKey}`,
      );
      throw new ForbiddenException('Access denied');
    }
  }

  private getContentType(key: string): string {
    const ext = key.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      mp4: 'video/mp4',
      webm: 'video/webm',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
      aac: 'audio/aac',
      amr: 'audio/amr',
      m4a: 'audio/mp4',
      pdf: 'application/pdf',
    };
    return map[ext ?? ''] || 'application/octet-stream';
  }
}
