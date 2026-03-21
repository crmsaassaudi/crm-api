import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

  constructor(private readonly configService: ConfigService) {}

  /**
   * Download and cache a media file from a provider.
   * Returns our internal stable URL.
   */
  async cacheMedia(
    channelType: string,
    originalUrl: string,
    mediaId: string,
    accessToken?: string,
  ): Promise<string> {
    this.logger.log(
      `Caching media: ${channelType} / ${mediaId} from ${originalUrl}`,
    );

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

      // Step 3: Return the proxy URL
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
  async getMedia(mediaPath: string): Promise<Buffer | null> {
    // TODO: implement actual retrieval from storage
    this.logger.log(`Retrieving media: ${mediaPath}`);
    return null;
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
  private async store(mediaId: string, buffer: Buffer): Promise<string> {
    // TODO: implement actual file storage (local disk / S3)
    // For now, log the action and return a placeholder path
    this.logger.log(
      `Storing media ${mediaId} (${buffer.length} bytes)`,
    );
    return mediaId;
  }
}
