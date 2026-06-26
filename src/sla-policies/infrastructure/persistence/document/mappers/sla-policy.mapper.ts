import { SlaPolicy } from '../../../../domain/sla-policy';
import { SlaPolicySchemaClass } from '../entities/sla-policy.schema';

export class SlaPolicyMapper {
  static toDomain(raw: SlaPolicySchemaClass): SlaPolicy {
    const entity = new SlaPolicy();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.name = raw.name;
    entity.type = raw.type;
    entity.targets =
      raw.targets?.map((t) => ({
        segment: t.segment,
        timeValue: t.timeValue,
        timeUnit: t.timeUnit,
      })) ?? [];
    entity.enabled = raw.enabled;
    entity.priority = raw.priority;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(entity: SlaPolicy): Partial<SlaPolicySchemaClass> {
    const p: any = {};
    if (entity.id) p._id = entity.id;
    p.tenantId = entity.tenantId;
    p.name = entity.name;
    p.type = entity.type;
    p.targets = entity.targets;
    p.enabled = entity.enabled ?? true;
    p.priority = entity.priority;
    return p;
  }
}