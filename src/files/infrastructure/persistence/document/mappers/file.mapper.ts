import { FileType } from '../../../../domain/file';
import { FileSchemaClass } from '../entities/file.schema';

export class FileMapper {
  static toDomain(raw: FileSchemaClass): FileType {
    const domainEntity = new FileType();
    domainEntity.id = raw._id.toString();
    domainEntity.path = raw.path;
    domainEntity.tenantId = raw.tenantId?.toString();
    domainEntity.version = raw.__v;
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;

    // New fields — safe fallback for old records without these fields
    domainEntity.fileName = raw.fileName;
    domainEntity.mimeType = raw.mimeType;
    domainEntity.fileSize = raw.fileSize;
    domainEntity.checksum = raw.checksum;

    domainEntity.category = (raw.category as FileType['category']) ?? 'general';
    domainEntity.source = (raw.source as FileType['source']) ?? 'upload';
    domainEntity.status = (raw.status as FileType['status']) ?? 'ready';

    domainEntity.uploadedBy = raw.uploadedBy;
    domainEntity.accessLevel =
      (raw.accessLevel as FileType['accessLevel']) ?? 'tenant';
    domainEntity.allowedUserIds = (raw.allowedUserIds ?? []).map((id) =>
      id?.toString(),
    );

    domainEntity.conversationId = raw.conversationId?.toString();
    domainEntity.messageId = raw.messageId;

    domainEntity.thumbnailKey = raw.thumbnailKey;
    domainEntity.imageMetadata = raw.imageMetadata;
    domainEntity.tags = raw.tags ?? [];
    domainEntity.folderId = raw.folderId?.toString();

    domainEntity.isDeleted = raw.isDeleted ?? false;
    domainEntity.deletedAt = raw.deletedAt;

    return domainEntity;
  }

  static toPersistence(domainEntity: FileType): FileSchemaClass {
    const p = new FileSchemaClass();
    if (domainEntity.id) {
      p._id = domainEntity.id;
    }
    p.path = domainEntity.path;
    p.tenantId = domainEntity.tenantId;
    if (domainEntity.version !== undefined) {
      p.__v = domainEntity.version;
    }

    FileMapper.applyBasicMetadata(p, domainEntity);
    FileMapper.applyOwnershipFields(p, domainEntity);
    FileMapper.applyMediaFields(p, domainEntity);

    // createdAt/updatedAt are managed by Mongoose timestamps
    return p;
  }

  /** Apply fileName, mimeType, fileSize, checksum, category, source, status. */
  private static applyBasicMetadata(p: FileSchemaClass, d: FileType): void {
    if (d.fileName !== undefined) p.fileName = d.fileName;
    if (d.mimeType !== undefined) p.mimeType = d.mimeType;
    if (d.fileSize !== undefined) p.fileSize = d.fileSize;
    if (d.checksum !== undefined) p.checksum = d.checksum;
    if (d.category !== undefined) p.category = d.category;
    if (d.source !== undefined) p.source = d.source;
    if (d.status !== undefined) p.status = d.status;
  }

  /** Apply uploadedBy, accessLevel, allowedUserIds, isDeleted, deletedAt. */
  private static applyOwnershipFields(p: FileSchemaClass, d: FileType): void {
    if (d.uploadedBy !== undefined) p.uploadedBy = d.uploadedBy;
    if (d.accessLevel !== undefined) p.accessLevel = d.accessLevel;
    if (d.allowedUserIds !== undefined) p.allowedUserIds = d.allowedUserIds;
    if (d.isDeleted !== undefined) p.isDeleted = d.isDeleted;
    if (d.deletedAt !== undefined) p.deletedAt = d.deletedAt;
  }

  /** Apply conversationId, messageId, thumbnailKey, imageMetadata, tags, folderId. */
  private static applyMediaFields(p: FileSchemaClass, d: FileType): void {
    if (d.conversationId !== undefined) p.conversationId = d.conversationId;
    if (d.messageId !== undefined) p.messageId = d.messageId;
    if (d.thumbnailKey !== undefined) p.thumbnailKey = d.thumbnailKey;
    if (d.imageMetadata !== undefined) p.imageMetadata = d.imageMetadata;
    if (d.tags !== undefined) p.tags = d.tags;
    if (d.folderId !== undefined) p.folderId = d.folderId;
  }
}
