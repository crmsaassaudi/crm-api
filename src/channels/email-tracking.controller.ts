import { Controller, Get, Param, Req, Res, Logger } from '@nestjs/common';
import { ApiTags, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { EmailTrackingService } from './services/email-tracking.service';
import { Unprotected } from 'nest-keycloak-connect';
import { Throttle } from '@nestjs/throttler';

/**
 * Email Tracking Controller — Serves the 1x1 tracking pixel.
 *
 * This endpoint is PUBLIC (no auth) because it's called by email clients
 * when the recipient opens the email. The tracking pixel URL is embedded
 * in the email HTML body.
 *
 * Security:
 *   - No sensitive data exposed — the pixel URL is just an opaque identifier
 *   - Bot filtering happens in EmailTrackingService
 *   - Rate limiting via trackingId idempotency
 */
@ApiTags('Email Tracking')
@Controller({ path: 't', version: '1' })
export class EmailTrackingController {
  private readonly logger = new Logger(EmailTrackingController.name);

  constructor(private readonly trackingService: EmailTrackingService) {}

  /**
   * Serve tracking pixel and record the open event.
   * GET /v1/t/:trackingId.png
   */
  @Get(':trackingId.png')
  @Unprotected()
  @ApiExcludeEndpoint() // Hide from Swagger — this is not a user-facing API
  // Per-IP throttle so a scanner can't enumerate tracking IDs at line rate.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  servePixel(
    @Param('trackingId') trackingId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    // Validate trackingId format. Tracking IDs from EmailTrackingService are
    // ULID-like (base32 26 chars) or hex. Reject anything outside that to stop
    // path-style probing without paying the DB lookup.
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(trackingId)) {
      const pixel = this.trackingService.getPixelBuffer();
      res.status(200).set({ 'Content-Type': 'image/png' }).end(pixel);
      return;
    }
    // Extract fingerprint data for bot detection
    const userAgent = req.headers['user-agent'] || null;
    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    // Process hit asynchronously — don't block the pixel response
    this.trackingService
      .processPixelHit(trackingId, userAgent, ipAddress)
      .catch((err) => {
        this.logger.error(`[Tracking] Pixel hit error: ${err.message}`);
      });

    // Always serve the pixel immediately (even if processing fails)
    const pixel = this.trackingService.getPixelBuffer();
    res
      .status(200)
      .set({
        'Content-Type': 'image/png',
        'Content-Length': pixel.length.toString(),
        'Cache-Control':
          'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      })
      .end(pixel);
  }
}
