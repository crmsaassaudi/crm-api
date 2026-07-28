import { AccessPolicy } from '../domain/access-policy';

export class AccessPolicyMapper {
  static toDomain(raw: any): AccessPolicy {
    const entity = new AccessPolicy();
    entity.id = raw._id?.toString() ?? raw.id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.name = raw.name;
    entity.description = raw.description ?? '';
    entity.resource = raw.resource;
    entity.action = raw.action;
    entity.effect = raw.effect;
    entity.conditions = raw.conditions ?? [];
    entity.active = raw.active !== false;
    entity.priority = raw.priority ?? 100;
    entity.revision = raw.revision ?? 1;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toDomainList(raws: any[]): AccessPolicy[] {
    return (raws ?? []).map((raw) => AccessPolicyMapper.toDomain(raw));
  }
}
