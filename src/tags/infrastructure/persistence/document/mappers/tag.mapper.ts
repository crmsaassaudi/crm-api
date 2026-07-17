import { Tag } from '../../../../domain/tag';
import { TagSchemaClass } from '../entities/tag.schema';

export class TagMapper {
  static toDomain(raw: TagSchemaClass): Tag {
    const entity = new Tag();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.name = raw.name;
    entity.color = raw.color;
    entity.scope = raw.scope;
    entity.order = raw.order ?? 0;
    entity.channelIds = raw.channelIds ?? [];
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(domain: Partial<Tag>): Partial<TagSchemaClass> {
    const persistence: Partial<TagSchemaClass> = {};
    if (domain.tenantId) persistence.tenantId = domain.tenantId;
    if (domain.name) persistence.name = domain.name;
    if (domain.color) persistence.color = domain.color;
    if (domain.scope) persistence.scope = domain.scope;
    if (domain.order !== undefined) persistence.order = domain.order;
    if (domain.channelIds !== undefined)
      persistence.channelIds = domain.channelIds;
    return persistence;
  }
}
