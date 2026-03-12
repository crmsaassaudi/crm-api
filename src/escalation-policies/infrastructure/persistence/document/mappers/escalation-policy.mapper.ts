import { EscalationPolicy } from '../../../../domain/escalation-policy';
import { EscalationPolicySchemaDocument } from '../entities/escalation-policy.schema';

export class EscalationPolicyMapper {
  static toDomain(doc: EscalationPolicySchemaDocument): EscalationPolicy {
    const entity = new EscalationPolicy();
    entity.id = doc._id.toString();
    entity.tenant = doc.tenant;
    entity.name = doc.name;
    entity.slaId = doc.slaId?.toString();
    entity.breachType = doc.breachType;
    entity.thresholdPercentage = doc.thresholdPercentage;
    entity.actions = doc.actions;
    entity.enabled = doc.enabled;
    entity.createdAt = doc.createdAt;
    entity.updatedAt = doc.updatedAt;
    return entity;
  }
}
