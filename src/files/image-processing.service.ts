import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { ChannelType } from '../omni-inbound/domain/omni-payload';

/**
 * Compression presets per platform.
 * Each entry defines the maximum dimensions and target quality.
 * The service will iteratively reduce quality if the output exceeds maxBytes.
 */
interface CompressionPreset {
  maxWidth: number;
  maxHeight: number;
  /** JPEG quality (1–100) — start value */
  quality: number;
  /** Minimum quality before giving up */
  minQuality: number;
  /** Target max output size in bytes */
  maxBytes: number;
  /** Output format — JPEG for maximum platform compatibility */
  format: 'jpeg' | 'webp';
}

const STORAGE_PRESET: CompressionPreset = {
  maxWidth: 2048,
  maxHeight: 2048,
  quality: 80,
  minQuality: 60,
  maxBytes: 5 * 1024 * 1024, // 5 MB — generous for internal storage
  format: 'webp',
};

const PLATFORM_PRESETS: Record<string, CompressionPreset> = {
  zalo: {
    maxWidth: 1024,
    maxHeight: 1024,
    quality: 75,
    minQuality: 40,
    maxBytes: 1 * 1024 * 1024, // 1 MB — Zalo's strict limit
    format: 'jpeg',
  },
  whatsapp: {
    maxWidth: 1600,
    maxHeight: 1600,
    quality: 80,
    minQuality: 55,
    maxBytes: 5 * 1024 * 1024, // 5 MB
    format: 'jpeg',
  },
  facebook: {
    maxWidth: 2048,
    maxHeight: 2048,
    quality: 85,
    minQuality: 65,
    maxBytes: 25 * 1024 * 1024, // 25 MB
    format: 'jpeg',
  },
  instagram: {
    maxWidth: 2048,
    maxHeight: 2048,
    quality: 85,
    minQuality: 65,
    maxBytes: 25 * 1024 * 1024,
    format: 'jpeg',
  },
  livechat: {
    maxWidth: 2048,
    maxHeight: 2048,
    quality: 85,
    minQuality: 60,
    maxBytes: 25 * 1024 * 1024,
    format: 'webp',
  },
  email: {
    maxWidth: 2048,
    maxHeight: 2048,
    quality: 85,
    minQuality: 60,
    maxBytes: 25 * 1024 * 1024,
    format: 'jpeg',
  },
};

const THUMBNAIL_SIZE = 200;
const THUMBNAIL_QUALITY = 60;

export interface ProcessedImage {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  /** Original size before compression */
  originalSize: number;
}

/**
 * Image processing service using `sharp` (libvips).
 *
 * Responsibilities:
 * - Compress images for internal S3 storage (WebP, max 2048px)
 * - Compress images to meet platform-specific size limits (Zalo < 1MB, etc.)
 * - Generate thumbnails for preview (200×200 WebP)
 *
 * All methods return NEW buffers — originals are never mutated.
 */
@Injectable()
export class ImageProcessingService {
  private readonly logger = new Logger(ImageProcessingService.name);

  /**
   * Compress an image for internal S3 storage.
   * Converts to WebP (quality 80), resizes to max 2048px, preserves aspect ratio.
   * If the input is already small enough, returns it with minimal processing.
   */
  async compressForStorage(
    buffer: Buffer,
    originalMimeType: string,
  ): Promise<ProcessedImage> {
    const originalSize = buffer.length;

    try {
      const metadata = await sharp(buffer).metadata();
      const needsResize =
        (metadata.width ?? 0) > STORAGE_PRESET.maxWidth ||
        (metadata.height ?? 0) > STORAGE_PRESET.maxHeight;

      let pipeline = sharp(buffer).rotate(); // auto-rotate from EXIF

      if (needsResize) {
        pipeline = pipeline.resize(
          STORAGE_PRESET.maxWidth,
          STORAGE_PRESET.maxHeight,
          { fit: 'inside', withoutEnlargement: true },
        );
      }

      const result = await pipeline
        .webp({ quality: STORAGE_PRESET.quality, effort: 4 })
        .toBuffer({ resolveWithObject: true });

      this.logger.debug(
        `compressForStorage: ${originalMimeType} ${(originalSize / 1024).toFixed(0)}KB → WebP ${(result.info.size / 1024).toFixed(0)}KB (${result.info.width}×${result.info.height})`,
      );

      return {
        buffer: result.data,
        mimeType: 'image/webp',
        width: result.info.width,
        height: result.info.height,
        originalSize,
      };
    } catch (error) {
      this.logger.warn(
        `compressForStorage failed, returning original: ${(error as Error).message}`,
      );
      // Fallback: return original buffer unchanged
      return {
        buffer,
        mimeType: originalMimeType,
        width: 0,
        height: 0,
        originalSize,
      };
    }
  }

  /**
   * Compress an image to meet a specific platform's size limit.
   *
   * Uses iterative quality reduction to hit the target:
   * 1. First attempt: resize + quality from preset
   * 2. If over limit: reduce quality by 10
   * 3. If still over: reduce dimensions by 20%
   * 4. Repeat until under limit or minQuality reached
   *
   * Returns JPEG for maximum platform compatibility (all platforms accept JPEG).
   * Returns a NEW buffer — original is never modified.
   */
  async compressForPlatform(
    buffer: Buffer,
    channelType: ChannelType,
  ): Promise<ProcessedImage> {
    const originalSize = buffer.length;
    const preset = PLATFORM_PRESETS[channelType] ?? PLATFORM_PRESETS.facebook;

    // If already under limit, still convert to JPEG for consistency
    // but don't aggressively compress
    let currentWidth = preset.maxWidth;
    let currentHeight = preset.maxHeight;
    let currentQuality = preset.quality;
    let attempt = 0;
    const maxAttempts = 5;

    while (attempt < maxAttempts) {
      attempt++;

      try {
        const result = await sharp(buffer)
          .rotate()
          .resize(currentWidth, currentHeight, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: currentQuality, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });

        if (result.info.size <= preset.maxBytes) {
          this.logger.debug(
            `compressForPlatform[${channelType}]: attempt ${attempt} OK — ${(result.info.size / 1024).toFixed(0)}KB (q${currentQuality}, ${result.info.width}×${result.info.height})`,
          );
          return {
            buffer: result.data,
            mimeType: 'image/jpeg',
            width: result.info.width,
            height: result.info.height,
            originalSize,
          };
        }

        this.logger.debug(
          `compressForPlatform[${channelType}]: attempt ${attempt} — ${(result.info.size / 1024).toFixed(0)}KB > ${(preset.maxBytes / 1024).toFixed(0)}KB limit, retrying...`,
        );
      } catch (error) {
        this.logger.warn(
          `compressForPlatform attempt ${attempt} failed: ${(error as Error).message}`,
        );
      }

      // Strategy: first reduce quality, then reduce dimensions
      if (currentQuality > preset.minQuality) {
        currentQuality = Math.max(preset.minQuality, currentQuality - 15);
      } else {
        // Quality at minimum — reduce dimensions
        currentWidth = Math.round(currentWidth * 0.8);
        currentHeight = Math.round(currentHeight * 0.8);
      }
    }

    // Final attempt with most aggressive settings
    this.logger.warn(
      `compressForPlatform[${channelType}]: all ${maxAttempts} attempts exceeded limit — using most aggressive settings`,
    );

    const finalResult = await sharp(buffer)
      .rotate()
      .resize(Math.min(currentWidth, 640), Math.min(currentHeight, 640), {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: Math.max(30, preset.minQuality - 10), mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: finalResult.data,
      mimeType: 'image/jpeg',
      width: finalResult.info.width,
      height: finalResult.info.height,
      originalSize,
    };
  }

  /**
   * Generate a small thumbnail for preview in chat and file listings.
   * Always returns 200×200 WebP regardless of input format.
   */
  async generateThumbnail(buffer: Buffer): Promise<Buffer> {
    try {
      return await sharp(buffer)
        .rotate()
        .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
          fit: 'cover',
          position: 'centre',
        })
        .webp({ quality: THUMBNAIL_QUALITY, effort: 6 })
        .toBuffer();
    } catch (error) {
      this.logger.warn(`generateThumbnail failed: ${(error as Error).message}`);
      // Return a 1×1 transparent pixel as fallback
      return sharp({
        create: {
          width: 1,
          height: 1,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .webp()
        .toBuffer();
    }
  }

  /**
   * Check if a MIME type is an image that sharp can process.
   */
  isProcessableImage(mimeType: string): boolean {
    return [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/tiff',
      'image/avif',
    ].includes(mimeType.toLowerCase());
  }
}
