import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantsService } from '../../tenants/tenants.service';

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
 * - Store in local/S3 storage
 * - Return a stable proxy URL that never expires
 */
@Injectable()
export class MediaProxyService {
  private readonly logger = new Logger(MediaProxyService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly tenantsService: TenantsService,
  ) {}

  /**
   * Download and cache a media file from a provider.
   * Returns our internal stable URL.
   *
   * If the tenant's storage quota is exceeded, returns the original
   * URL as a fallback (file is not cached).
   */
  async cacheMedia(
    tenantId: string,
    channelType: string,
    originalUrl: string,
    mediaId: string,
    accessToken?: string,
  ): Promise<string> {
    this.logger.log(
      `Caching media: ${channelType} / ${mediaId} from ${originalUrl}`,
    );

    // ── Quota check ────────────────────────────────────────────────
    try {
      const quota = await this.tenantsService.checkStorageQuota(tenantId);
      if (!quota.allowed) {
        this.logger.warn(
          `Tenant ${tenantId} storage quota exceeded ` +
            `(${quota.usedMB.toFixed(1)}/${quota.limitMB} MB) — returning original URL`,
        );
        return originalUrl;
      }
    } catch (err) {
      this.logger.warn(
        `Quota check failed for tenant ${tenantId}: ${err.message} — proceeding with cache`,
      );
    }

    try {
      // Step 1: Download from provider
      const buffer = await this.downloadFromProvider(
        channelType,
        originalUrl,
        mediaId,
        accessToken,
      );

      // Step 2: Store locally or in S3
      const storedPath = await this.store(mediaId, buffer);

      // Step 3: Increment tenant storage usage
      try {
        await this.tenantsService.incrementStorageUsage(
          tenantId,
          buffer.length,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to increment storage usage for tenant ${tenantId}: ${err.message}`,
        );
      }

      // Step 4: Return the proxy URL
      const baseUrl = this.configService.get('app.backendDomain', {
        infer: true,
      });
      return `${baseUrl}/omni/media/${storedPath}`;
    } catch (error) {
      this.logger.error(
        `Failed to cache media ${mediaId}: ${error.message}`,
        error.stack,
      );
      // Return the original URL as fallback (may expire)
      return originalUrl;
    }
  }

  /**
   * Retrieve a cached media file by its stored path.
   */
  getMedia(mediaPath: string): Promise<Buffer | null> {
    // TODO: implement actual retrieval from storage
    this.logger.log(`Retrieving media: ${mediaPath}`);
    return Promise.resolve(null);
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
      // GET https://graph.facebook.com/v18.0/{media_id}
      // Response: { url: '<download_url>' }
      const graphResponse = await fetch(
        `https://graph.facebook.com/v18.0/${mediaId}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      const graphData = await graphResponse.json();
      downloadUrl = graphData.url;
    }

    const response = await fetch(downloadUrl, {
      headers: accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : undefined,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download media: ${response.status} ${response.statusText}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Store a media buffer and return a storage key.
   */
  private store(mediaId: string, buffer: Buffer): Promise<string> {
    // TODO: implement actual file storage (local disk / S3)
    // For now, log the action and return a placeholder path
    this.logger.log(`Storing media ${mediaId} (${buffer.length} bytes)`);
    return Promise.resolve(mediaId);
  }
}
