import { AutomationRule } from '../../../../domain/automation-rule';
import { AutomationRuleSchemaDocument } from '../entities/automation-rule.schema';

export class AutomationRuleMapper {
  static toDomain(doc: AutomationRuleSchemaDocument): AutomationRule {
    const entity = new AutomationRule();
    entity.id = doc._id.toString();
    entity.tenant = doc.tenant;
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
}
