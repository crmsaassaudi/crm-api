import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ClsService } from 'nestjs-cls';

import { FilesService } from './files.service';
import { TenantsService } from '../tenants/tenants.service';
import { ImageProcessingService } from './image-processing.service';
import { RequirePermission } from '../common/permissions';

import {
  UploadFileDto,
  ListFilesQueryDto,
  UpdateFileAccessDto,
  RenameFileDto,
  MoveFileDto,
  BulkMoveDto,
  BulkDeleteDto,
} from './dto/file-management.dto';
import { FileAccessLevel } from './domain/file';
import {
  isAllowedFileName,
  isAllowedMimeType,
  getFileCategory,
  detectMimeFromBuffer,
} from './file-upload-security.util';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../config/config.type';
import { randomStringGenerator } from '@nestjs/common/utils/random-string-generator.util';
import * as crypto from 'crypto';

const SAFE_EXT = /^[a-z0-9]{1,8}$/;

/**
 * File Management REST API.
 *
 * Endpoints:
 *   POST   /files/upload             — upload a file (multipart)
 *   GET    /files                     — list files with ACL filter
 *   GET    /files/:id                 — file detail with presigned URL
 *   GET    /files/:id/download        — presigned download URL
 *   PATCH  /files/:id/access          — update access level
 *   DELETE /files/:id                 — soft delete
 *   DELETE /files/:id/purge           — hard delete (SUPER_ADMIN)
 *   GET    /storage                   — storage usage overview
 */
@Controller({ path: 'files', version: '1' })
export class FileManagementController {
  private readonly logger = new Logger(FileManagementController.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly filesService: FilesService,
    private readonly tenantsService: TenantsService,
    private readonly imageProcessingService: ImageProcessingService,
    private readonly configService: ConfigService<AllConfigType>,
    private readonly cls: ClsService,
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
    });
  }

  // ── Upload ────────────────────────────────────────────────────────

  @Post('upload')
  @RequirePermission('create', 'files')
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(HttpStatus.CREATED)
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadFileDto,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');
    if (!tenantId || !userId) {
      throw new BadRequestException('Tenant/User context not found');
    }
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // ── Validate ────────────────────────────────────────────────────
    if (!isAllowedFileName(file.originalname)) {
      throw new BadRequestException('File type not allowed');
    }
    if (file.mimetype && !isAllowedMimeType(file.mimetype)) {
      throw new BadRequestException(`MIME type ${file.mimetype} not allowed`);
    }

    // HIGH-11: Verify magic bytes match the declared MIME type.
    // Client-supplied Content-Type is trivially forged. An attacker can rename
    // malware.exe → resume.pdf and send Content-Type: application/pdf.
    // The extension check passes, but magic bytes reveal the real format.
    const detectedMime = detectMimeFromBuffer(file.buffer);
    if (detectedMime && !isAllowedMimeType(detectedMime)) {
      throw new BadRequestException(
        `File content does not match an allowed type (detected: ${detectedMime})`,
      );
    }

    const maxFileSize =
      this.configService.get('file.maxFileSize', { infer: true }) || 26214400;
    if (file.size > maxFileSize) {
      throw new PayloadTooLargeException(
        `File size ${(file.size / (1024 * 1024)).toFixed(1)}MB exceeds limit of ${(maxFileSize / (1024 * 1024)).toFixed(0)}MB`,
      );
    }

    // ── Quota check (atomic) ────────────────────────────────────────
    const category = dto.category ?? getFileCategory(file.mimetype);
    const countsQuota = category !== 'general';

    if (countsQuota) {
      const withinQuota = await this.tenantsService.incrementStorageUsage(
        tenantId,
        file.size,
      );
      if (!withinQuota) {
        const quota = await this.tenantsService.checkStorageQuota(tenantId);
        throw new PayloadTooLargeException(
          `Storage quota exceeded (${(quota.usedBytes / (1024 * 1024)).toFixed(1)}MB / ${quota.limitBytes === -1 ? 'unlimited' : (quota.limitBytes / (1024 * 1024)).toFixed(0) + 'MB'})`,
        );
      }
    }

    try {
      // ── Compress if image ───────────────────────────────────────────
      let uploadBuffer = file.buffer;
      let uploadMimeType = file.mimetype;
      let imageWidth: number | undefined;
      let imageHeight: number | undefined;
      let originalMimeType: string | undefined;
      let originalSize: number | undefined;

      if (this.imageProcessingService.isProcessableImage(file.mimetype)) {
        const compressed = await this.imageProcessingService.compressForStorage(
          file.buffer,
          file.mimetype,
        );
        uploadBuffer = compressed.buffer;
        uploadMimeType = compressed.mimeType;
        imageWidth = compressed.width;
        imageHeight = compressed.height;
        originalMimeType = file.mimetype;
        originalSize = file.size;
      }

      // ── S3 Upload ─────────────────────────────────────────────────
      const ext = (file.originalname.split('.').pop() || '').toLowerCase();
      const safeExt = SAFE_EXT.test(ext) ? ext : 'bin';
      // Use webp extension if compressed to webp
      const finalExt =
        uploadMimeType === 'image/webp' && safeExt !== 'webp'
          ? 'webp'
          : safeExt;
      const storageKey = `${tenantId}/${randomStringGenerator()}.${finalExt}`;

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
          Body: uploadBuffer,
          ContentType: uploadMimeType,
          ContentDisposition: `attachment; filename="${sanitizeFilename(file.originalname)}"`,
          Metadata: { tenantId },
        }),
      );

      // ── Thumbnail ─────────────────────────────────────────────────
      let thumbnailKey: string | undefined;
      if (this.imageProcessingService.isProcessableImage(file.mimetype)) {
        try {
          const thumbBuffer =
            await this.imageProcessingService.generateThumbnail(file.buffer);
          thumbnailKey = `${tenantId}/thumbs/${randomStringGenerator()}.webp`;
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

      // ── Checksum ──────────────────────────────────────────────────
      const checksum = crypto
        .createHash('sha256')
        .update(uploadBuffer)
        .digest('hex');

      // ── DB Record ─────────────────────────────────────────────────
      const fileRecord = await this.filesService.upsertByMessageId(
        tenantId,
        `upload_${storageKey}`, // unique key for uploads
        {
          path: storageKey,
          fileName: file.originalname,
          mimeType: uploadMimeType,
          fileSize: uploadBuffer.length,
          checksum,
          category,
          source: 'upload',
          status: 'ready',
          uploadedBy: userId,
          accessLevel: dto.accessLevel ?? 'tenant',
          allowedUserIds: [],
          conversationId: dto.conversationId,
          folderId: dto.folderId ?? undefined,
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
          tags: dto.tags ?? [],
          isDeleted: false,
        },
      );

      this.logger.log(
        `File uploaded: ${storageKey} (${(uploadBuffer.length / 1024).toFixed(0)}KB) by user ${userId}`,
      );

      return { file: fileRecord.file };
    } catch (err) {
      // Rollback quota on failure
      if (countsQuota) {
        await this.tenantsService
          .decrementStorageUsage(tenantId, file.size)
          .catch((e) =>
            this.logger.warn(`Quota rollback failed: ${(e as Error).message}`),
          );
      }
      throw err;
    }
  }

  // ── List ──────────────────────────────────────────────────────────

  @Get()
  @RequirePermission('view', 'files')
  async listFiles(@Query() query: ListFilesQueryDto) {
    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';

    return this.filesService.listFiles(
      tenantId,
      userId,
      userRole,
      {
        category: query.category,
        mimeTypePrefix: query.type,
        search: query.search,
        folderId: query.folderId === 'root' ? null : query.folderId,
      },
      { page: query.page ?? 1, limit: query.limit ?? 20 },
    );
  }

  // ── Detail ────────────────────────────────────────────────────────

  @Get(':id')
  @RequirePermission('view', 'files')
  async getFile(@Param('id') id: string) {
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';

    const file = await this.filesService.findById(id);
    if (!file) throw new BadRequestException('File not found');
    if (!this.filesService.checkAccess(file, userId, userRole)) {
      throw new ForbiddenException('No access to this file');
    }

    const downloadUrl = await this.filesService.getPresignedDownloadUrl(
      file.path,
    );
    const thumbnailUrl = file.thumbnailKey
      ? await this.filesService.getPresignedDownloadUrl(file.thumbnailKey)
      : undefined;

    return {
      ...file,
      path: undefined, // Never expose storageKey
      downloadUrl,
      thumbnailUrl,
    };
  }

  // ── Download URL ──────────────────────────────────────────────────

  @Get(':id/download')
  @RequirePermission('view', 'files')
  async getDownloadUrl(@Param('id') id: string) {
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';

    const file = await this.filesService.findById(id);
    if (!file) throw new BadRequestException('File not found');
    if (!this.filesService.checkAccess(file, userId, userRole)) {
      throw new ForbiddenException('No access to this file');
    }

    const url = await this.filesService.getPresignedDownloadUrl(file.path);
    return { url, expiresIn: 3600 };
  }

  // ── Update Access ─────────────────────────────────────────────────

  @Patch(':id/access')
  @RequirePermission('edit', 'files')
  @HttpCode(HttpStatus.OK)
  async updateAccess(
    @Param('id') id: string,
    @Body() dto: UpdateFileAccessDto,
  ) {
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';

    return this.filesService.updateAccessLevel(
      id,
      userId,
      userRole,
      dto.accessLevel,
      dto.allowedUserIds ?? [],
    );
  }

  // ── Soft Delete ───────────────────────────────────────────────────

  @Delete(':id')
  @RequirePermission('delete', 'files')
  @HttpCode(HttpStatus.OK)
  async softDeleteFile(@Param('id') id: string) {
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';

    return this.filesService.softDelete(id, userId, userRole);
  }

  // ── Hard Delete (SUPER_ADMIN) ─────────────────────────────────────

  @Delete(':id/purge')
  @HttpCode(HttpStatus.OK)
  async hardDeleteFile(@Param('id') id: string) {
    const userRole = this.cls.get<string>('tenantRole') ?? '';
    const tenantId = this.cls.get<string>('tenantId');

    if (!['OWNER'].includes(userRole?.toUpperCase())) {
      throw new ForbiddenException('Only OWNER can permanently delete files');
    }

    const { fileSize } = await this.filesService.hardDelete(id);

    // Decrement quota
    if (fileSize > 0) {
      await this.tenantsService.decrementStorageUsage(tenantId, fileSize);
    }

    return { deleted: true, freedBytes: fileSize };
  }

  // ── Storage Overview ──────────────────────────────────────────────

  @Get('/storage/usage')
  @RequirePermission('view', 'storage')
  async getStorageUsage() {
    const tenantId = this.cls.get<string>('tenantId');
    const result = await this.tenantsService.getStorageBreakdown(tenantId);

    const [topFiles, totalFilesCount, recentUploadsCount, actualUsedBytes, categoryBreakdown] = await Promise.all([
      this.filesService.getTopFiles(tenantId, 10),
      this.filesService.countFiles(tenantId),
      this.filesService.countRecentUploads(tenantId, 7),
      this.filesService.sumFileSizes(tenantId),
      this.filesService.getCategoryBreakdown(tenantId),
    ]);

    const limitBytes = result.quota.limitBytes;

    return {
      quota: {
        limitBytes,
        usedBytes: actualUsedBytes,
        usagePercent:
          limitBytes > 0 && limitBytes !== -1
            ? Math.round((actualUsedBytes / limitBytes) * 100)
            : 0,
        unlimited: limitBytes === -1,
        limitMB:
          limitBytes === -1
            ? -1
            : Math.round(limitBytes / (1024 * 1024)),
        usedMB: Math.round(actualUsedBytes / (1024 * 1024)),
      },
      breakdown: categoryBreakdown,
      topFiles: topFiles.map((f) => ({
        id: f.id,
        fileName: f.fileName,
        mimeType: f.mimeType,
        fileSize: f.fileSize,
        category: f.category,
        createdAt: f.createdAt,
      })),
      totalFilesCount,
      recentUploadsCount,
    };
  }

  // ── Cloud Drive Extensions ────────────────────────────────────────

  @Patch(':id/rename')
  @RequirePermission('edit', 'files')
  @HttpCode(HttpStatus.OK)
  async renameFile(
    @Param('id') id: string,
    @Body() dto: RenameFileDto,
  ) {
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';
    return this.filesService.renameFile(id, userId, userRole, dto.name);
  }

  @Patch(':id/move')
  @RequirePermission('edit', 'files')
  @HttpCode(HttpStatus.OK)
  async moveFile(
    @Param('id') id: string,
    @Body() dto: MoveFileDto,
  ) {
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';
    return this.filesService.moveFile(id, userId, userRole, dto.folderId ?? null);
  }

  @Post('bulk/move')
  @RequirePermission('edit', 'files')
  @HttpCode(HttpStatus.OK)
  async bulkMove(@Body() dto: BulkMoveDto) {
    const tenantId = this.cls.get<string>('tenantId');
    const count = await this.filesService.bulkMove(
      tenantId,
      dto.fileIds,
      dto.folderId ?? null,
    );
    return { movedCount: count };
  }

  @Post('bulk/delete')
  @RequirePermission('delete', 'files')
  @HttpCode(HttpStatus.OK)
  async bulkDelete(@Body() dto: BulkDeleteDto) {
    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';
    const count = await this.filesService.bulkDelete(
      tenantId,
      userId,
      userRole,
      dto.fileIds,
    );
    return { deletedCount: count };
  }

  @Post(':id/restore')
  @RequirePermission('edit', 'files')
  @HttpCode(HttpStatus.OK)
  async restoreFile(@Param('id') id: string) {
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';
    return this.filesService.restoreFile(id, userId, userRole);
  }

  @Get('trash')
  @RequirePermission('view', 'files')
  async listTrash(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    return this.filesService.listTrash(tenantId, {
      page: page ?? 1,
      limit: limit ?? 20,
    });
  }

  @Get('search')
  @RequirePermission('view', 'files')
  async searchFiles(
    @Query('q') q?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';

    return this.filesService.listFiles(
      tenantId,
      userId,
      userRole,
      { search: q },
      { page: page ?? 1, limit: limit ?? 20 },
    );
  }
}

function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[\r\n"\\]/g, '_')
      .replace(/[^\w.\-]/g, '_')
      .slice(0, 120) || 'file'
  );
}
