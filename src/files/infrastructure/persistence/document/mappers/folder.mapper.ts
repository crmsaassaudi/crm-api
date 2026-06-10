import { FolderType } from '../../../../domain/folder';
import { FolderSchemaClass } from '../entities/folder.schema';

export class FolderMapper {
  static toDomain(raw: FolderSchemaClass): FolderType {
    const folder = new FolderType();
    folder.id = raw._id.toString();
    folder.tenantId = raw.tenantId;
    folder.name = raw.name;
    folder.parentId = raw.parentId ? raw.parentId.toString() : null;
    folder.path = raw.path;
    folder.depth = raw.depth ?? 0;
    folder.createdBy = raw.createdBy;
    folder.color = raw.color;
    folder.isDeleted = raw.isDeleted ?? false;
    folder.deletedAt = raw.deletedAt;
    folder.createdAt = raw.createdAt;
    folder.updatedAt = raw.updatedAt;
    return folder;
  }

  static toPersistence(domain: FolderType): FolderSchemaClass {
    const schema = new FolderSchemaClass();
    if (domain.id) {
      schema._id = domain.id;
    }
    schema.tenantId = domain.tenantId;
    schema.name = domain.name;
    schema.parentId = domain.parentId;
    schema.path = domain.path;
    schema.depth = domain.depth;
    schema.createdBy = domain.createdBy;
    if (domain.color !== undefined) schema.color = domain.color;
    if (domain.isDeleted !== undefined) schema.isDeleted = domain.isDeleted;
    if (domain.deletedAt !== undefined) schema.deletedAt = domain.deletedAt;
    return schema;
  }
}
