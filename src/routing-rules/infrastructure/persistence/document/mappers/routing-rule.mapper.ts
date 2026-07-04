import { RoutingRule } from '../../../../domain/routing-rule';
import {
  RoutingRuleSchemaDocument,
  RoutingRuleSchemaClass,
} from '../entities/routing-rule.schema';

export class RoutingRuleMapper {
  static toDomain(doc: RoutingRuleSchemaDocument): RoutingRule {
    const entity = new RoutingRule();
    entity.id = doc._id.toString();
    entity.tenantId = doc.tenantId?.toString();
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

  static toPersistence(entity: RoutingRule): Partial<RoutingRuleSchemaClass> {
    const p: any = {};
    if (entity.id) p._id = entity.id;
    p.tenantId = entity.tenantId;
    p.name = entity.name;
    p.priority = entity.priority;
    p.matchType = entity.matchType;
    p.conditions = entity.conditions;
    p.actions = entity.actions;
    p.enabled = entity.enabled ?? true;
    return p;
  }
}
