import { Group } from '../../../../domain/group';
import { GroupSchemaClass } from '../entities/group.schema';

export class GroupMapper {
  static toDomain(raw: GroupSchemaClass): Group {
    const entity = new Group();
    entity.id = raw._id?.toString();
    entity.tenant = raw.tenant;
    entity.name = raw.name;
    entity.description = raw.description ?? undefined;
    entity.parentGroup = raw.parentGroup ? raw.parentGroup.toString() : null;
    entity.manager = raw.manager ? raw.manager.toString() : null;
    entity.members = (raw.members || []).map((m: any) => m.toString());
    entity.permissions = raw.permissions || [];
    entity.isActive = raw.isActive;
    entity.color = raw.color ?? null;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(domain: Partial<Group>): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    if (domain.tenant !== undefined) doc.tenant = domain.tenant;
    if (domain.name !== undefined) doc.name = domain.name;
    if (domain.description !== undefined) doc.description = domain.description;
    if (domain.parentGroup !== undefined) doc.parentGroup = domain.parentGroup;
    if (domain.manager !== undefined) doc.manager = domain.manager;
    if (domain.members !== undefined) doc.members = domain.members;
    if (domain.permissions !== undefined) doc.permissions = domain.permissions;
    if (domain.isActive !== undefined) doc.isActive = domain.isActive;
    if (domain.color !== undefined) doc.color = domain.color;
    return doc;
  }
}
