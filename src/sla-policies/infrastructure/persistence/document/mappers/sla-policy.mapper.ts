import { SlaPolicy } from '../../../../domain/sla-policy';
import { SlaPolicySchemaClass } from '../entities/sla-policy.schema';

export class SlaPolicyMapper {
  static toDomain(raw: SlaPolicySchemaClass): SlaPolicy {
    const entity = new SlaPolicy();
    entity.id = raw._id?.toString();
    entity.tenant = raw.tenant;
    entity.name = raw.name;
    entity.type = raw.type;
    entity.targets = raw.targets;
    entity.enabled = raw.enabled;
    entity.priority = raw.priority;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }
}
