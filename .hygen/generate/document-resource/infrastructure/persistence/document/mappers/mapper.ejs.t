---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/infrastructure/persistence/document/mappers/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.mapper.ts
---
import { <%= name %> } from '../../../../domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>';
import { <%= name %>SchemaClass } from '../entities/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.schema';

export class <%= name %>Mapper {
  public static toDomain(raw: <%= name %>SchemaClass): <%= name %> {
    const domainEntity = new <%= name %>();
    domainEntity.id = raw._id.toString();

    domainEntity.version = (raw as any).__v;
    domainEntity.createdAt = (raw as any).createdAt;
    domainEntity.updatedAt = (raw as any).updatedAt;

    return domainEntity;
  }

  public static toPersistence(domainEntity: <%= name %>): <%= name %>SchemaClass {
    const persistenceSchema = new <%= name %>SchemaClass();
    if (domainEntity.id) {
      persistenceSchema._id = domainEntity.id;
    }

    return persistenceSchema;
  }
}
