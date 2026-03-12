import { RoutingRule } from '../../../../domain/routing-rule';
import { RoutingRuleSchemaDocument } from '../entities/routing-rule.schema';

export class RoutingRuleMapper {
  static toDomain(doc: RoutingRuleSchemaDocument): RoutingRule {
    const entity = new RoutingRule();
    entity.id = doc._id.toString();
    entity.tenant = doc.tenant;
    entity.name = doc.name;
    entity.priority = doc.priority;
    entity.matchType = doc.matchType;
    entity.conditions = doc.conditions;
    entity.actions = doc.actions;
    entity.enabled = doc.enabled;
    entity.createdAt = doc.createdAt;
    entity.updatedAt = doc.updatedAt;
    return entity;
  }
}
