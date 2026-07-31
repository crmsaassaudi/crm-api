import { ForbiddenException } from '@nestjs/common';

type Query = Record<string, unknown>;

export class AuthorizationFilterException extends ForbiddenException {
  constructor(detail?: string) {
    super(
      detail
        ? `Authorization scope cannot be applied: ${detail}`
        : 'Authorization scope cannot be applied',
    );
  }
}

/**
 * The predicate is legitimate but the search index cannot express it faithfully
 * — an unmapped field, an operator OpenSearch has no equivalent for, a range
 * over `flat_object`. MongoDB holds every field and enforces the same predicate
 * correctly, so the honest answer is to serve that module from MongoDB rather
 * than to translate the predicate loosely (which turns a DENY into an ALLOW) or
 * to refuse a search the user is entitled to.
 *
 * It stays a subclass so that a deployment with `OPENSEARCH_FALLBACK_TO_MONGODB`
 * turned off still fails closed with a 403 instead of widening visibility.
 */
export class IndexFilterUnsupportedException extends AuthorizationFilterException {}

/**
 * Exactly the fields `crm-opensearch` puts in the mapping. Anything else is
 * absent from every document, and absence is not neutral: a DENY policy
 * compiles to `must_not`, and a `must_not` over an unknown field matches every
 * document. Translating such a predicate would silently turn "deny these rows"
 * into "allow everything", so an unmapped field has to be refused instead.
 *
 * Keep in step with `crm-opensearch/src/index/index-definition.ts`.
 */
export const INDEXED_FILTER_FIELDS: ReadonlySet<string> = new Set([
  'tenantId',
  'module',
  'recordId',
  'ownerId',
  'orgUnitId',
  'statusId',
  'tags',
  'createdAt',
  'updatedAt',
]);

/** `customFields.<key>` is queryable through the flat_object mapping. */
const CUSTOM_FIELD_PREFIX = 'customFields.';

const isCustomField = (field: string): boolean =>
  field.startsWith(CUSTOM_FIELD_PREFIX) &&
  field.length > CUSTOM_FIELD_PREFIX.length;

const isQueryableField = (field: string): boolean =>
  INDEXED_FILTER_FIELDS.has(field) || isCustomField(field);

/**
 * `flat_object` stores every leaf as the string the indexer serialised, and a
 * `date` field parses ISO-8601. `String(new Date())` produces neither — it
 * produces "Thu Jul 31 2026 19:00:00 GMT+0700 (…)", which matches nothing, and a
 * `must_not` that matches nothing matches every document. That is the same
 * fail-open shape the field allowlist exists to prevent, reached through operand
 * coercion instead of through the field name.
 */
const scalar = (value: unknown): string | number | boolean | null => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  const rendered = String(value);
  if (rendered === '[object Object]' || rendered === '[object Array]') {
    // An object operand cannot be compared as a term; guessing would be the
    // fail-open move.
    throw new IndexFilterUnsupportedException(
      'a non-scalar operand cannot be matched against the index',
    );
  }
  return rendered;
};

/**
 * `{ $ne: 'x' }` is a set of operators; `new Date(…)` and `ObjectId(…)` are
 * values that merely happen to be objects. Treating the latter as the former
 * enumerated no `$` keys and produced `{bool:{filter:[]}}` — a match-all, which
 * widens a positive clause and empties a negated one. Neither is the predicate
 * that was written.
 */
const isOperatorMap = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
};

function fieldClause(field: string, value: unknown): Query {
  if (
    !field ||
    field.split('.').some((part) => !part || part.startsWith('$'))
  ) {
    throw new AuthorizationFilterException('unsafe field path');
  }
  if (!isQueryableField(field)) {
    // Never translated loosely: MongoDB answers this module instead, and if
    // fallback is disabled the caller gets a 403 rather than a result set the
    // policy did not sanction.
    throw new IndexFilterUnsupportedException(
      `"${field}" is not part of the search index`,
    );
  }
  if (value === null) {
    return { bool: { must_not: [{ exists: { field } }] } };
  }
  if (!isOperatorMap(value)) {
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
        if (isCustomField(field)) {
          // `flat_object` indexes its leaves as keywords with no numeric or date
          // doc values, so OpenSearch rejects a range over one. The rejection
          // used to arrive as a bare 400 that looked exactly like an outage.
          throw new IndexFilterUnsupportedException(
            `a range over "${field}" is not supported by the flat_object mapping`,
          );
        }
        return {
          range: { [field]: { [operator.slice(1)]: scalar(operand) } },
        };
      case '$exists':
        return Boolean(operand)
          ? { exists: { field } }
          : { bool: { must_not: [{ exists: { field } }] } };
      default:
        throw new IndexFilterUnsupportedException(
          `operator "${operator}" is not supported`,
        );
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
      throw new AuthorizationFilterException(
        `operator "${field}" is not supported`,
      );
    }
    return fieldClause(field, value);
  });
  return clauses.length === 1 ? clauses[0] : { bool: { filter: clauses } };
}
