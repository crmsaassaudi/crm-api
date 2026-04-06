import { Group } from '../../../../domain/group';
import { GroupSchemaClass } from '../entities/group.schema';

export class GroupMapper {
  static toDomain(raw: GroupSchemaClass): Group {
    const entity = new Group();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.name = raw.name;
    entity.description = raw.description ?? undefined;
    entity.parentGroupId = raw.parentGroupId
      ? raw.parentGroupId.toString()
      : null;
    entity.managerId = raw.managerId ? raw.managerId.toString() : null;
    entity.memberIds = (raw.memberIds || []).map((m: any) => m.toString());
    entity.permissions = raw.permissions || [];
    entity.isActive = raw.isActive;
    entity.color = raw.color ?? null;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(domain: Partial<Group>): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    if (domain.tenantId !== undefined) doc.tenantId = domain.tenantId;
    if (domain.name !== undefined) doc.name = domain.name;
    if (domain.description !== undefined) doc.description = domain.description;
    if (domain.parentGroupId !== undefined)
      doc.parentGroupId = domain.parentGroupId;
    if (domain.managerId !== undefined) doc.managerId = domain.managerId;
    if (domain.memberIds !== undefined) doc.memberIds = domain.memberIds;
    if (domain.permissions !== undefined) doc.permissions = domain.permissions;
    if (domain.isActive !== undefined) doc.isActive = domain.isActive;
    if (domain.color !== undefined) doc.color = domain.color;
    return doc;
  }
}
