import { Tag } from '../../../../domain/tag';
import { TagSchemaClass } from '../entities/tag.schema';

export class TagMapper {
  static toDomain(raw: TagSchemaClass): Tag {
    const entity = new Tag();
    entity.id = raw._id?.toString();
    entity.tenant = raw.tenant;
    entity.name = raw.name;
    entity.color = raw.color;
    entity.scope = raw.scope;
    entity.autoRule = raw.autoRule;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(domain: Tag): Partial<TagSchemaClass> {
    const persistence: any = {};
    if (domain.tenant) persistence.tenant = domain.tenant;
    if (domain.name) persistence.name = domain.name;
    if (domain.color) persistence.color = domain.color;
    if (domain.scope) persistence.scope = domain.scope;
    if (domain.autoRule !== undefined) persistence.autoRule = domain.autoRule;
    return persistence;
  }
}
