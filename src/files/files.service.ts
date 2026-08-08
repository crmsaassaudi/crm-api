import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  FileRepository,
  PaginatedResult,
  PaginationOptions,
  FileListFilters,
} from './infrastructure/persistence/file.repository';
import { FileType, FileAccessLevel, FileStatus } from './domain/file';
import { NullableType } from '../utils/types/nullable.type';
import { AllConfigType } from '../config/config.type';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  /** Redis cache TTL for presigned URLs — 10 minutes */
  private static readonly PRESIGNED_CACHE_TTL_SECONDS = 10 * 60;

  constructor(
    private readonly fileRepository: FileRepository,
    private readonly configService: ConfigService<AllConfigType>,
    private readonly cls: ClsService,
    @Optional() private readonly redisService?: RedisService,
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

  async findById(id: FileType['id'], tenantId?: string): Promise<NullableType<FileType>> {
    const file = await this.fileRepository.findById(id);
    if (!file) return null;
    if (tenantId && file.tenantId !== tenantId) return null;
    return file;
  }

  findByIds(ids: FileType['id'][]): Promise<FileType[]> {
    return this.fileRepository.findByIds(ids);
  }

  /**
   * Check if a user has access to a file.
   * OWNER/ADMIN bypass all ACL. Otherwise:
   * - tenant: all tenant members
   * - private: only uploadedBy or allowedUserIds
   * - public: everyone
   */
  checkAccess(
    file: FileType,
    userId: string,
    userRole: string,
    requestingTenantId?: string,
  ): boolean {
    if (!file) return false;
    if (requestingTenantId && file.tenantId !== requestingTenantId) return false;
    if (file.isDeleted && file.status === 'deleted') return false;

    if (['OWNER', 'ADMIN'].includes(userRole?.toUpperCase())) return true;

    if (file.accessLevel === 'public') return true;
    if (file.accessLevel === 'tenant') return true; // Tenant guard already filters by tenantId

    if (file.accessLevel === 'private') {
      if (file.uploadedBy === userId) return true;
      if (file.allowedUserIds?.includes(userId)) return true;
      return false;
    }

    return false;
  }

  /**
   * Generate (or return Redis-cached) presigned download URL for a file.
   *
   * Cache strategy:
   * - Key: `presigned:<storageKey>` in Redis
   * - TTL: 10 minutes (presigned URL lives 60 min → 50 min safety margin)
   * - Shared across all pods/processes → no redundant signing
   * - Falls back to direct generation if Redis is unavailable
   *
   * ACL must be checked BEFORE calling this method.
   */
  async getPresignedDownloadUrl(
    storageKey: string,
    ttlSeconds = 3600,
  ): Promise<string> {
    const cacheKey = `presigned:${storageKey}`;

    if (this.redisService) {
      try {
        const cached = await this.redisService.get<string>(cacheKey);
        if (cached) return cached;
      } catch {
        // Redis unavailable — fall through to generate fresh
      }
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
    });
    const url = await getSignedUrl(this.s3, command, { expiresIn: ttlSeconds });

    // Store in Redis with TTL (fire-and-forget, don't block response)
    if (this.redisService) {
      this.redisService
        .set(cacheKey, url, FilesService.PRESIGNED_CACHE_TTL_SECONDS)
        .catch(() => {}); // Silently ignore Redis write failures
    }

    return url;
  }

  async listFiles(
    tenantId: string,
    userId: string,
    userRole: string,
    filters?: FileListFilters,
    pagination?: PaginationOptions,
  ): Promise<PaginatedResult<FileType>> {
    return this.fileRepository.findByTenant(
      tenantId,
      userId,
      userRole,
      filters,
      pagination,
    );
  }

  async listConversationFiles(
    tenantId: string,
    conversationId: string,
    filters?: { mimeTypePrefix?: string },
    pagination?: PaginationOptions,
  ): Promise<PaginatedResult<FileType>> {
    return this.fileRepository.findByConversation(
      tenantId,
      conversationId,
      filters,
      pagination,
    );
  }

  async softDelete(
    fileId: string,
    userId: string,
    userRole: string,
    tenantId?: string,
  ): Promise<FileType> {
    const file = await this.fileRepository.findById(fileId);
    if (!file || (tenantId && file.tenantId !== tenantId)) throw new NotFoundException('File not found');
    if (!this.checkAccess(file, userId, userRole, tenantId)) {
      throw new ForbiddenException('No access to this file');
    }
    if (
      file.uploadedBy !== userId &&
      !['OWNER', 'ADMIN'].includes(userRole?.toUpperCase())
    ) {
      throw new ForbiddenException('Only file owner or admin can delete');
    }
    const deleted = await this.fileRepository.softDelete(fileId);
    if (!deleted) throw new NotFoundException('File not found');
    return deleted;
  }

  // Hard Delete (SUPER_ADMIN / OWNER)

  /**
   * Permanently delete file from S3 + DB. Returns fileSize for quota decrement.
   */
  async hardDelete(fileId: string, tenantId?: string): Promise<{ fileSize: number }> {
    const file = await this.fileRepository.findById(fileId);
    if (!file || (tenantId && file.tenantId !== tenantId)) throw new NotFoundException('File not found');

    try {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: file.path }),
      );
      if (file.thumbnailKey) {
        await this.s3.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: file.thumbnailKey,
          }),
        );
      }
    } catch (err) {
      this.logger.error(
        `S3 delete failed for ${file.path}: ${(err as Error).message}`,
      );
      throw new BadRequestException(
        `Failed to delete object from storage: ${(err as Error).message}`,
      );
    }

    await this.fileRepository.hardDelete(fileId);

    if (this.redisService && file.path) {
      this.redisService.del(`presigned:${file.path}`).catch(() => {});
    }

    return { fileSize: file.fileSize ?? 0 };
  }

  async updateAccessLevel(
    fileId: string,
    userId: string,
    userRole: string,
    accessLevel: FileAccessLevel,
    allowedUserIds: string[],
    tenantId?: string,
  ): Promise<FileType> {
    const file = await this.fileRepository.findById(fileId);
    if (!file || (tenantId && file.tenantId !== tenantId)) throw new NotFoundException('File not found');

    if (
      file.uploadedBy !== userId &&
      !['OWNER', 'ADMIN'].includes(userRole?.toUpperCase())
    ) {
      throw new ForbiddenException(
        'Only file owner or admin can change access',
      );
    }

    const updated = await this.fileRepository.updateAccessLevel(
      fileId,
      accessLevel,
      allowedUserIds,
    );
    if (!updated) throw new NotFoundException('File not found');

    if (this.redisService && file.path) {
      this.redisService.del(`presigned:${file.path}`).catch(() => {});
    }

    return updated;
  }

  async updateStatus(
    fileId: string,
    status: FileStatus,
  ): Promise<NullableType<FileType>> {
    return this.fileRepository.updateStatus(fileId, status);
  }

  // Upsert (Omni media dedup)

  async upsertByMessageId(
    tenantId: string,
    messageId: string,
    data: Partial<FileType>,
  ): Promise<{ file: FileType; isNew: boolean }> {
    return this.fileRepository.upsertByMessageId(tenantId, messageId, data);
  }

  async renameFile(
    fileId: string,
    userId: string,
    userRole: string,
    newName: string,
    tenantId?: string,
  ): Promise<FileType> {
    const file = await this.fileRepository.findById(fileId);
    if (!file || (tenantId && file.tenantId !== tenantId)) throw new NotFoundException('File not found');
    if (!this.checkAccess(file, userId, userRole, tenantId)) {
      throw new ForbiddenException('No access to this file');
    }
    if (
      file.uploadedBy !== userId &&
      !['OWNER', 'ADMIN'].includes(userRole?.toUpperCase())
    ) {
      throw new ForbiddenException('Only file owner or admin can rename');
    }

    const trimmed = newName.trim();
    if (!trimmed || trimmed.length > 255) {
      throw new BadRequestException('File name must be 1-255 characters');
    }

    const renamed = await this.fileRepository.rename(fileId, trimmed);
    if (!renamed) throw new NotFoundException('File not found');
    return renamed;
  }

  async moveFile(
    fileId: string,
    userId: string,
    userRole: string,
    folderId: string | null,
    tenantId?: string,
  ): Promise<FileType> {
    const file = await this.fileRepository.findById(fileId);
    if (!file || (tenantId && file.tenantId !== tenantId)) throw new NotFoundException('File not found');
    if (!this.checkAccess(file, userId, userRole, tenantId)) {
      throw new ForbiddenException('No access to this file');
    }

    const moved = await this.fileRepository.moveToFolder(fileId, folderId);
    if (!moved) throw new NotFoundException('File not found');
    return moved;
  }

  async bulkMove(
    tenantId: string,
    fileIds: string[],
    folderId: string | null,
  ): Promise<number> {
    if (!fileIds.length) return 0;
    return this.fileRepository.bulkMoveToFolder(fileIds, folderId);
  }

  async bulkDelete(
    tenantId: string,
    userId: string,
    userRole: string,
    fileIds: string[],
  ): Promise<number> {
    if (!fileIds.length) return 0;
    return this.fileRepository.bulkSoftDelete(fileIds);
  }

  async restoreFile(
    fileId: string,
    userId: string,
    userRole: string,
  ): Promise<FileType> {
    const file = await this.fileRepository.findById(fileId);
    if (!file) throw new NotFoundException('File not found');
    if (
      file.uploadedBy !== userId &&
      !['OWNER', 'ADMIN'].includes(userRole?.toUpperCase())
    ) {
      throw new ForbiddenException('Only file owner or admin can restore');
    }

    const restored = await this.fileRepository.restore(fileId);
    if (!restored) throw new NotFoundException('File not found');
    return restored;
  }

  async listTrash(
    tenantId: string,
    pagination?: { page: number; limit: number },
  ) {
    return this.fileRepository.findTrashed(tenantId, pagination);
  }

  async getTopFiles(tenantId: string, limit = 10) {
    return this.fileRepository.findTopBySize(tenantId, limit);
  }

  async countFiles(tenantId: string) {
    return this.fileRepository.countByTenant(tenantId);
  }

  async countRecentUploads(tenantId: string, days = 7) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    return this.fileRepository.countRecentUploads(tenantId, since);
  }

  async sumFileSizes(tenantId: string): Promise<number> {
    return this.fileRepository.sumFileSizes(tenantId);
  }

  async getCategoryBreakdown(
    tenantId: string,
  ): Promise<Record<string, { count: number; sizeBytes: number }>> {
    return this.fileRepository.getCategoryBreakdown(tenantId);
  }
}
