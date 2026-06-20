import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomStringGenerator } from '@nestjs/common/utils/random-string-generator.util';
import * as crypto from 'crypto';
import { FilesService } from '../files/files.service';
import { FileCategory, FileSource } from '../files/domain/file';
import { ImageProcessingService } from '../files/image-processing.service';
import { AllConfigType } from '../config/config.type';

/**
 * VisitorUploadService
 *
 * Handles base64-encoded files uploaded by livechat visitors:
 * 1. Decode base64 → Buffer
 * 2. Compress if image (via ImageProcessingService)
 * 3. Upload buffer → S3
 * 4. Generate thumbnail if image
 * 5. Persist FileRecord via FilesService.upsertByMessageId()
 * 6. Return { fileId, storageKey } so LivechatInboundBridge can build OmniPayload
 *
 * Called synchronously from LivechatInboundBridge before emitting
 * omni.inbound.webhook — so ConversationService receives fileId (not base64).
 */
@Injectable()
export class VisitorUploadService {
  private readonly logger = new Logger(VisitorUploadService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly filesService: FilesService,
    private readonly imageProcessingService: ImageProcessingService,
    private readonly configService: ConfigService<AllConfigType>,
  ) {
    this.bucket =
      configService.get('file.awsDefaultS3Bucket', { infer: true }) ?? '';

    // NOTE: NestJS @Injectable() is singleton-scoped, so this S3Client is
    // constructed exactly once per application lifecycle — not per request.
    // FilesService owns its own private S3Client too; a future S3Module could
    // consolidate them, but the current overhead is negligible.
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
    });
  }

  /**
   * Upload a visitor file from base64 and persist a FileRecord.
   *
   * @returns fileId (DB record ID) and storageKey (S3 path)
   */
  async uploadFromBase64(params: {
    tenantId: string;
    visitorId: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    base64: string;
    dedupeKey: string; // externalMessageId for idempotency
  }): Promise<{ fileId: string; storageKey: string; thumbnailKey?: string }> {
    const { tenantId, fileName, mimeType, base64, dedupeKey } = params;

    // ── Decode base64 ─────────────────────────────────────────────────
    // Strip data URI prefix if present (e.g. "data:image/png;base64,")
    const raw = base64.replace(/^data:[^;]+;base64,/, '');
    let buffer = Buffer.from(raw, 'base64');

    // ── Compress image if applicable ──────────────────────────────────
    let uploadMimeType = mimeType;
    let thumbnailBuffer: Buffer | undefined;
    let thumbnailKey: string | undefined;

    if (this.imageProcessingService.isProcessableImage(mimeType)) {
      try {
        const compressed = await this.imageProcessingService.compressForStorage(
          buffer,
          mimeType,
        );
        buffer = compressed.buffer as Buffer<ArrayBuffer>;
        uploadMimeType = compressed.mimeType;
      } catch (err: any) {
        this.logger.warn(
          `Image compression failed for visitor upload: ${err?.message}. Using original.`,
        );
      }

      // Generate thumbnail
      try {
        thumbnailBuffer =
          await this.imageProcessingService.generateThumbnail(buffer);
      } catch {
        /* non-fatal */
      }
    }

    // ── S3 upload ────────────────────────────────────────────────────
    const ext =
      (fileName.split('.').pop() ?? 'bin')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 8) || 'bin';
    const finalExt = uploadMimeType === 'image/webp' ? 'webp' : ext;
    const storageKey = `${tenantId}/livechat-visitor/${randomStringGenerator()}.${finalExt}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: buffer,
        ContentType: uploadMimeType,
        ContentDisposition: `attachment; filename="${fileName.replace(/["\\\r\n]/g, '_').slice(0, 120)}"`,
        Metadata: { tenantId, source: 'livechat-visitor' },
      }),
    );

    // ── Thumbnail upload ──────────────────────────────────────────────
    if (thumbnailBuffer) {
      thumbnailKey = `${tenantId}/livechat-visitor/thumbs/${randomStringGenerator()}.webp`;
      try {
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: thumbnailKey,
            Body: thumbnailBuffer,
            ContentType: 'image/webp',
            Metadata: { tenantId },
          }),
        );
      } catch (err: any) {
        this.logger.warn(`Thumbnail upload failed: ${err?.message}`);
        thumbnailKey = undefined;
      }
    }

    // ── Checksum ─────────────────────────────────────────────────────
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    // ── Persist FileRecord ────────────────────────────────────────────
    const { file } = await this.filesService.upsertByMessageId(
      tenantId,
      `visitor-upload:${dedupeKey}`,
      {
        path: storageKey,
        fileName: fileName,
        mimeType: uploadMimeType,
        fileSize: buffer.length,
        checksum,
        category: this.mimeToCategory(mimeType) as FileCategory,
        source: 'omni_inbound' as FileSource,
        status: 'ready',
        uploadedBy: null as any, // no agent user for visitor uploads
        accessLevel: 'tenant',
        allowedUserIds: [],
        thumbnailKey,
        isDeleted: false,
      },
    );

    this.logger.log(
      `Visitor file saved: ${storageKey} (${(buffer.length / 1024).toFixed(0)}KB) fileId=${file.id}`,
    );

    return { fileId: file.id, storageKey, thumbnailKey };
  }

  private mimeToCategory(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'omni_media';
    if (mimeType.startsWith('video/')) return 'omni_media';
    if (mimeType.startsWith('audio/')) return 'omni_media';
    return 'general';
  }
}
