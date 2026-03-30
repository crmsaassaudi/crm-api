import { FileType } from '../../../../domain/file';
import { FileSchemaClass } from '../entities/file.schema';

export class FileMapper {
  static toDomain(raw: FileSchemaClass): FileType {
    const domainEntity = new FileType();
    domainEntity.id = raw._id.toString();
    domainEntity.path = raw.path;
    domainEntity.tenantId = raw.tenantId;
    domainEntity.version = raw.__v;
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
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
    // createdAt/updatedAt are managed by Mongoose timestamps
    return persistenceSchema;
  }
}
