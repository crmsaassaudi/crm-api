import { ActivityLog } from '../../../../domain/activity-log';
import { ActivityLogSchemaClass } from '../entities/activity-log.schema';

export class ActivityLogMapper {
  static toDomain(raw: ActivityLogSchemaClass): ActivityLog {
    const entity = new ActivityLog();
    entity.id = raw._id.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.targetType = raw.targetType;
    entity.targetId = raw.targetId?.toString();
    entity.event = raw.event;
    entity.actorId = raw.actorId?.toString();
    entity.payload = raw.payload;
    entity.occurredAt = raw.occurredAt;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(entity: ActivityLog): ActivityLogSchemaClass {
    const persistence = new ActivityLogSchemaClass();
    if (entity.id) {
      persistence._id = entity.id;
    }
    persistence.tenantId = entity.tenantId;
    persistence.targetType = entity.targetType;
    persistence.targetId = entity.targetId;
    persistence.event = entity.event;
    persistence.actorId = entity.actorId;
    persistence.payload = entity.payload;
    persistence.occurredAt = entity.occurredAt;
    return persistence;
  }
}
