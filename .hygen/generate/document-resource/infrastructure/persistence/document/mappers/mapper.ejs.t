---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/infrastructure/persistence/document/mappers/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.mapper.ts
---
import { <%= name %> } from '../../../../domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>';
import { <%= name %>SchemaClass } from '../entities/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.schema';

export class <%= name %>Mapper {
  public static toDomain(raw: <%= name %>SchemaClass): <%= name %> {
    const domainEntity = new <%= name %>();
    domainEntity.id = raw._id.toString();
    domainEntity.version = raw.__v; // Map DB __v -> Domain version
    domainEntity.tenantId = raw.tenantId;
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    return domainEntity;
  }

  public static toPersistence(domainEntity: <%= name %>): <%= name %>SchemaClass {
    const persistenceSchema: any = {
      _id: domainEntity.id,
      tenantId: domainEntity.tenantId,
      createdAt: domainEntity.createdAt,
      updatedAt: domainEntity.updatedAt,
    };

    // Chỉ gán __v nếu domain có version (dùng cho update check)
    if (domainEntity.version !== undefined) {
      persistenceSchema.__v = domainEntity.version;
    }

    return persistenceSchema as <%= name %>SchemaClass;
  }
}
