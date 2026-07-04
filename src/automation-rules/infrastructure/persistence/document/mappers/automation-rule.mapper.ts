import { AutomationRule } from '../../../../domain/automation-rule';
import {
  AutomationRuleSchemaDocument,
  AutomationRuleSchemaClass,
} from '../entities/automation-rule.schema';

export class AutomationRuleMapper {
  static toDomain(doc: AutomationRuleSchemaDocument): AutomationRule {
    const entity = new AutomationRule();
    entity.id = doc._id.toString();
    entity.tenantId = doc.tenantId?.toString();
    entity.name = doc.name;
    entity.trigger = doc.trigger;
    entity.actions = doc.actions;
    entity.enabled = doc.enabled;
    entity.executionCount = doc.executionCount;
    entity.lastExecutedAt = doc.lastExecutedAt;
    entity.createdAt = doc.createdAt;
    entity.updatedAt = doc.updatedAt;
    return entity;
  }

  static toPersistence(
    entity: AutomationRule,
  ): Partial<AutomationRuleSchemaClass> {
    const p: any = {};
    if (entity.id) p._id = entity.id;
    p.tenantId = entity.tenantId;
    p.name = entity.name;
    p.trigger = entity.trigger;
    p.actions = entity.actions;
    p.enabled = entity.enabled ?? true;
    p.executionCount = entity.executionCount ?? 0;
    p.lastExecutedAt = entity.lastExecutedAt;
    return p;
  }
}
