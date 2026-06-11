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
    domainEntity.allowedUserIds = (raw.allowedUserIds ?? []).map((id) => id?.toString());

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
    const persistenceSchema = new FileSchemaClass();
    if (domainEntity.id) {
      persistenceSchema._id = domainEntity.id;
    }
    persistenceSchema.path = domainEntity.path;
    persistenceSchema.tenantId = domainEntity.tenantId;
    if (domainEntity.version !== undefined) {
      persistenceSchema.__v = domainEntity.version;
    }

    // New fields
    if (domainEntity.fileName !== undefined)
      persistenceSchema.fileName = domainEntity.fileName;
    if (domainEntity.mimeType !== undefined)
      persistenceSchema.mimeType = domainEntity.mimeType;
    if (domainEntity.fileSize !== undefined)
      persistenceSchema.fileSize = domainEntity.fileSize;
    if (domainEntity.checksum !== undefined)
      persistenceSchema.checksum = domainEntity.checksum;

    if (domainEntity.category !== undefined)
      persistenceSchema.category = domainEntity.category;
    if (domainEntity.source !== undefined)
      persistenceSchema.source = domainEntity.source;
    if (domainEntity.status !== undefined)
      persistenceSchema.status = domainEntity.status;

    if (domainEntity.uploadedBy !== undefined)
      persistenceSchema.uploadedBy = domainEntity.uploadedBy;
    if (domainEntity.accessLevel !== undefined)
      persistenceSchema.accessLevel = domainEntity.accessLevel;
    if (domainEntity.allowedUserIds !== undefined)
      persistenceSchema.allowedUserIds = domainEntity.allowedUserIds;

    if (domainEntity.conversationId !== undefined)
      persistenceSchema.conversationId = domainEntity.conversationId;
    if (domainEntity.messageId !== undefined)
      persistenceSchema.messageId = domainEntity.messageId;

    if (domainEntity.thumbnailKey !== undefined)
      persistenceSchema.thumbnailKey = domainEntity.thumbnailKey;
    if (domainEntity.imageMetadata !== undefined)
      persistenceSchema.imageMetadata = domainEntity.imageMetadata;
    if (domainEntity.tags !== undefined)
      persistenceSchema.tags = domainEntity.tags;
    if (domainEntity.folderId !== undefined)
      persistenceSchema.folderId = domainEntity.folderId;

    if (domainEntity.isDeleted !== undefined)
      persistenceSchema.isDeleted = domainEntity.isDeleted;
    if (domainEntity.deletedAt !== undefined)
      persistenceSchema.deletedAt = domainEntity.deletedAt;

    // createdAt/updatedAt are managed by Mongoose timestamps
    return persistenceSchema;
  }
}
