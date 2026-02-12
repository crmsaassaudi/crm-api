---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/infrastructure/persistence/document/mappers/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.mapper.ts
---
import { <%= name %> } from '../../../../domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>';
import { <%= name %>SchemaClass } from '../entities/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.schema';

export class <%= name %>Mapper {
  public static toDomain(raw: <%= name %>SchemaClass): <%= name %> {
    const domainEntity = new <%= name %>();
    domainEntity.id = raw._id.toString();
    
    // 1. Map từ __v (DB) -> version (Domain)
    domainEntity.version = raw.__v;
    
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    domainEntity.tenantId = raw.tenantId;
    return domainEntity;
  }

  public static toPersistence(domainEntity: <%= name %>): <%= name %>SchemaClass {
    // Không dùng new Class() để tránh sinh rác _id nếu không cần thiết
    const persistenceSchema: any = {
      _id: domainEntity.id,
      tenantId: domainEntity.tenantId,
      createdAt: domainEntity.createdAt,
      updatedAt: domainEntity.updatedAt,
    };

    // 2. Map từ version (Domain) -> __v (DB)
    // Quan trọng: Chỉ gán __v nếu domain có version (Update case)
    if (domainEntity.version !== undefined) {
      persistenceSchema.__v = domainEntity.version;
    }

    return persistenceSchema as <%= name %>SchemaClass;
  }
}
