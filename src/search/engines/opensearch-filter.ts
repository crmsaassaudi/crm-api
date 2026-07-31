import { ForbiddenException } from '@nestjs/common';

type Query = Record<string, unknown>;

export class AuthorizationFilterException extends ForbiddenException {
  constructor() {
    super('Authorization scope cannot be applied');
  }
}

const scalar = (value: unknown): string | number | boolean | null => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return String(value);
};

function fieldClause(field: string, value: unknown): Query {
  if (
    !field ||
    field.split('.').some((part) => !part || part.startsWith('$'))
  ) {
    throw new AuthorizationFilterException();
  }
  if (value === null) {
    return { bool: { must_not: [{ exists: { field } }] } };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { term: { [field]: scalar(value) } };
  }

  const operators = value as Record<string, unknown>;
  const clauses = Object.entries(operators).map(([operator, operand]) => {
    switch (operator) {
      case '$in':
        return { terms: { [field]: (operand as unknown[]).map(scalar) } };
      case '$nin':
        return {
          bool: {
            must_not: [
              { terms: { [field]: (operand as unknown[]).map(scalar) } },
            ],
          },
        };
      case '$ne':
        return { bool: { must_not: [{ term: { [field]: scalar(operand) } }] } };
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        return { range: { [field]: { [operator.slice(1)]: operand } } };
      case '$exists':
        return Boolean(operand)
          ? { exists: { field } }
          : { bool: { must_not: [{ exists: { field } }] } };
      default:
        throw new AuthorizationFilterException();
    }
  });
  return clauses.length === 1 ? clauses[0] : { bool: { filter: clauses } };
}

export function mongoAuthorizationFilterToDsl(filter: Query): Query {
  const clauses = Object.entries(filter).map(([field, value]) => {
    if (field === '$and') {
      return {
        bool: {
          filter: (value as Query[]).map(mongoAuthorizationFilterToDsl),
        },
      };
    }
    if (field === '$or') {
      return {
        bool: {
          should: (value as Query[]).map(mongoAuthorizationFilterToDsl),
          minimum_should_match: 1,
        },
      };
    }
    if (field === '$nor') {
      return {
        bool: {
          must_not: (value as Query[]).map(mongoAuthorizationFilterToDsl),
        },
      };
    }
    if (field.startsWith('$')) {
      throw new AuthorizationFilterException();
    }
    return fieldClause(field, value);
  });
  return clauses.length === 1 ? clauses[0] : { bool: { filter: clauses } };
}
