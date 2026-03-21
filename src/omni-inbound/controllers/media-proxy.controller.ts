import {
  Controller,
  Get,
  Param,
  Res,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Public } from 'nest-keycloak-connect';
import { Response } from 'express';
import { MediaProxyService } from '../services/media-proxy.service';

/**
 * Serves cached/proxied media files.
 *
 * URL: GET /omni/media/:mediaId
 *
 * This gives agents a stable URL to view images and files
 * even after the provider's original URL has expired (Zalo).
 */
@Controller('omni/media')
export class MediaProxyController {
  private readonly logger = new Logger(MediaProxyController.name);

  constructor(private readonly mediaProxyService: MediaProxyService) {}

  @Get(':mediaId')
  @Public() // Media endpoint — can be secured via signed URLs later
  async getMedia(
    @Param('mediaId') mediaId: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Serving media: ${mediaId}`);

    const buffer = await this.mediaProxyService.getMedia(mediaId);
    if (!buffer) {
      throw new NotFoundException('Media not found');
    }

    // TODO: set proper content-type based on stored metadata
    res.status(HttpStatus.OK)
      .header('Content-Type', 'application/octet-stream')
      .header('Cache-Control', 'public, max-age=86400')
      .send(buffer);
  }
}
