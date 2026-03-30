---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/infrastructure/persistence/document/mappers/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.mapper.ts
---
import { <%= name %> } from '../../../../domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>';
import { <%= name %>SchemaClass } from '../entities/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class <%= name %>Mapper {
  /**
   * DB document → Domain entity.
   * Populated refs (owner, createdBy, updatedBy) are mapped to User domain objects.
   * Non-populated refs remain as ObjectId strings.
   */
  public static toDomain(raw: <%= name %>SchemaClass): <%= name %> {
    const domainEntity = new <%= name %>();
    domainEntity.id = raw._id.toString();
    domainEntity.tenantId = raw.tenantId;
    domainEntity.version = raw.__v;

    // Do not remove comment below.
    // <mapper-to-domain />

    // Populate-safe ref mapping
    if (raw.createdById) {
      domainEntity.createdBy = typeof raw.createdById === 'string'
        ? raw.createdById
        : UserMapper.toDomain(raw.createdById as any);
    }
    if (raw.updatedById) {
      domainEntity.updatedBy = typeof raw.updatedById === 'string'
        ? raw.updatedById
        : UserMapper.toDomain(raw.updatedById as any);
    }

    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    domainEntity.deletedAt = raw.deletedAt;
    return domainEntity;
  }

  /**
   * Domain entity → DB document.
   * Ref fields are stored as ObjectId strings (not populated objects).
   */
  public static toPersistence(domainEntity: <%= name %>): <%= name %>SchemaClass {
    const persistenceSchema: any = {};
    if (domainEntity.id) {
      persistenceSchema._id = domainEntity.id;
    }
    persistenceSchema.tenantId = domainEntity.tenantId;

    // Do not remove comment below.
    // <mapper-to-persistence />

    persistenceSchema.createdById = typeof domainEntity.createdBy === 'string'
      ? domainEntity.createdBy
      : (domainEntity.createdBy as any)?.id;
    persistenceSchema.updatedById = typeof domainEntity.updatedBy === 'string'
      ? domainEntity.updatedBy
      : (domainEntity.updatedBy as any)?.id;

    if (domainEntity.version !== undefined) {
      persistenceSchema.__v = domainEntity.version;
    }

    return persistenceSchema as <%= name %>SchemaClass;
  }
}
