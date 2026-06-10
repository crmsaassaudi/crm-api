import {
  Controller,
  Get,
  Param,
  Res,
  Redirect,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Public } from 'nest-keycloak-connect';
import { Response } from 'express';
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
 */
@Controller({ path: 'omni/media', version: '1' })
export class MediaProxyController {
  private readonly logger = new Logger(MediaProxyController.name);

  constructor(
    private readonly mediaProxyService: MediaProxyService,
    private readonly filesService: FilesService,
  ) {}

  /**
   * Redirect to a presigned S3 URL for the media file.
   * This is the preferred approach — S3/CDN handles the bandwidth.
   */
  @Get('redirect/*storageKey')
  @Public()
  async redirectToMedia(
    @Param('storageKey') storageKey: string,
    @Res() res: Response,
  ) {
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
  @Public() // Media endpoint — can be secured via signed URLs later
  async getMedia(
    @Param('storageKey') storageKey: string,
    @Res() res: Response,
  ) {
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
      .send(buffer);
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
