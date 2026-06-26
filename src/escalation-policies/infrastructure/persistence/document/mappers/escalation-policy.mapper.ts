import { EscalationPolicy } from '../../../../domain/escalation-policy';
import { EscalationPolicySchemaDocument, EscalationPolicySchemaClass } from '../entities/escalation-policy.schema';

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

  static toPersistence(entity: EscalationPolicy): Partial<EscalationPolicySchemaClass> {
    const p: any = {};
    if (entity.id) p._id = entity.id;
    p.tenantId = entity.tenantId;
    p.name = entity.name;
    p.slaId = entity.slaId;
    p.breachType = entity.breachType;
    p.escalateAfter = entity.escalateAfter;
    p.escalateUnit = entity.escalateUnit;
    p.actions = entity.actions;
    p.enabled = entity.enabled ?? true;
    return p;
  }
}