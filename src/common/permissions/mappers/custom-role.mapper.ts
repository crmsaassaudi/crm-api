import { CustomRole } from '../domain/custom-role';

export class CustomRoleMapper {
  static toDomain(raw: any): CustomRole {
    const entity = new CustomRole();
    entity.id = raw._id?.toString() ?? raw.id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.name = raw.name;
    entity.description = raw.description ?? '';
    entity.permissions = raw.permissions ?? [];
    entity.dataScope = raw.dataScope ?? null;
    entity.isSystem = Boolean(raw.isSystem);
    entity.systemKey = raw.systemKey ?? null;
    entity.templateVersion = raw.templateVersion ?? null;
    entity.color = raw.color;
    entity.revision = raw.revision ?? 1;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toDomainList(raws: any[]): CustomRole[] {
    return (raws ?? []).map((raw) => CustomRoleMapper.toDomain(raw));
  }
}
