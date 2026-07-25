import { AuthzAuditLog } from '../domain/authz-audit-log';

export class AuthzAuditLogMapper {
  static toDomain(raw: any): AuthzAuditLog {
    const entity = new AuthzAuditLog();
    entity.id = raw._id?.toString() ?? raw.id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.actorId = raw.actorId?.toString();
    entity.actorEmail = raw.actorEmail ?? null;
    entity.actorType = raw.actorType ?? 'user';
    entity.category = raw.category;
    entity.action = raw.action;
    entity.targetType = raw.targetType;
    entity.targetId = raw.targetId?.toString();
    entity.summary = raw.summary ?? null;
    entity.before = raw.before ?? null;
    entity.after = raw.after ?? null;
    entity.ip = raw.ip ?? null;
    entity.t = raw.t;
    return entity;
  }

  static toDomainList(raws: any[]): AuthzAuditLog[] {
    return (raws ?? []).map((raw) => AuthzAuditLogMapper.toDomain(raw));
  }
}
