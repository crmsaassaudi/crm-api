import { EscalationPolicy } from '../../../../domain/escalation-policy';
import { EscalationPolicySchemaDocument } from '../entities/escalation-policy.schema';

export class EscalationPolicyMapper {
  static toDomain(doc: EscalationPolicySchemaDocument): EscalationPolicy {
    const entity = new EscalationPolicy();
    entity.id = doc._id.toString();
    entity.tenantId = doc.tenantId?.toString();
    entity.name = doc.name;
    entity.slaId = doc.slaId?.toString();
    entity.breachType = doc.breachType;
    entity.escalateAfter = doc.escalateAfter;
    entity.escalateUnit = doc.escalateUnit;
    entity.actions =
      doc.actions?.map((a) => ({
        type: a.type,
        value: a.value,
      })) ?? [];
    entity.enabled = doc.enabled;
    entity.createdAt = doc.createdAt;
    entity.updatedAt = doc.updatedAt;
    return entity;
  }
}
