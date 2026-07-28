import { ServiceUnavailableException } from '@nestjs/common';
import {
  AbacCondition,
  AbacContext,
  AbacPolicy,
  policyApplies,
} from './abac.evaluator';

export type AbacMongoFilter = Record<string, unknown>;

function readContextPath(context: AbacContext, path: string): unknown {
  const parts = path.split('.');
  let value: any = context;
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) {
      return undefined;
    }
    value = value[part];
  }
  return value;
}

function resourceField(path: string): string | null {
  return path.startsWith('resource.') ? path.slice('resource.'.length) : null;
}

function comparisonValue(
  condition: AbacCondition,
  context: AbacContext,
): unknown {
  if (!condition.valueAttribute) return condition.value;
  if (condition.valueAttribute.startsWith('resource.')) {
    throw new ServiceUnavailableException(
      `ABAC query cannot compile resource-to-resource comparison "${condition.valueAttribute}"`,
    );
  }
  return readContextPath(context, condition.valueAttribute);
}

function compileCondition(
  condition: AbacCondition,
  context: AbacContext,
): AbacMongoFilter {
  const field = resourceField(condition.attribute);
  if (!field) {
    throw new ServiceUnavailableException(
      `ABAC query received non-resource condition "${condition.attribute}"`,
    );
  }
  if (!field || field.split('.').some((part) => !part || part.startsWith('$'))) {
    throw new ServiceUnavailableException(
      `ABAC query received unsafe resource path "${condition.attribute}"`,
    );
  }

  const value = comparisonValue(condition, context);
  switch (condition.operator) {
    case 'eq':
      return { [field]: value };
    case 'ne':
      return { [field]: { $ne: value } };
    case 'in':
      return { [field]: { $in: value } };
    case 'nin':
      return { [field]: { $nin: value } };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return { [field]: { [`$${condition.operator}`]: value } };
    case 'contains':
      // Mongo equality against an array field means "array contains scalar".
      // String substring policies are intentionally not compiled because a
      // regex translation would change escaping/collation semantics.
      return { [field]: value };
    case 'exists':
      return { [field]: { $exists: Boolean(value) } };
    default:
      throw new ServiceUnavailableException(
        `ABAC query cannot compile operator "${String(condition.operator)}"`,
      );
  }
}

/**
 * Compile applicable resource-dependent DENY policies to a Mongo predicate.
 *
 * RBAC/data-scope remains the positive grant boundary; ABAC deny predicates
 * only subtract rows. ALLOW policies never widen a repository query because
 * doing so could bypass owner/org-unit/channel scope.
 */
export function compileAbacDenyFilter(
  policies: AbacPolicy[],
  context: AbacContext,
): AbacMongoFilter | null {
  const deniedShapes: AbacMongoFilter[] = [];

  for (const policy of policies) {
    if (policy.effect !== 'deny') continue;
    const resourceConditions = policy.conditions.filter((condition) =>
      condition.attribute.startsWith('resource.'),
    );
    if (resourceConditions.length === 0) continue;

    const staticConditions = policy.conditions.filter(
      (condition) => !condition.attribute.startsWith('resource.'),
    );
    if (
      staticConditions.length > 0 &&
      !policyApplies({ effect: 'deny', conditions: staticConditions }, context)
    ) {
      continue;
    }

    const clauses = resourceConditions.map((condition) =>
      compileCondition(condition, context),
    );
    deniedShapes.push(clauses.length === 1 ? clauses[0] : { $and: clauses });
  }

  return deniedShapes.length > 0 ? { $nor: deniedShapes } : null;
}
