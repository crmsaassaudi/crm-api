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
 * The mapped fields on which authorization filtering is intentionally
 * supported. Search-only fields such as title, phoneSuffixes and contentHash
 * are deliberately absent from this allowlist. Any other policy field is not
 * safely queryable here, and absence is not neutral: a DENY policy
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

/** Custom fields remain identifiable so we can return an actionable fallback. */
const CUSTOM_FIELD_PREFIX = 'customFields.';

const isCustomField = (field: string): boolean =>
  field.startsWith(CUSTOM_FIELD_PREFIX) &&
  field.length > CUSTOM_FIELD_PREFIX.length;

const isQueryableField = (field: string): boolean =>
  INDEXED_FILTER_FIELDS.has(field);

const INDEXED_DATE_FIELDS: ReadonlySet<string> = new Set([
  'createdAt',
  'updatedAt',
]);

const objectIdHex = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const toHexString = (value as { toHexString?: unknown }).toHexString;
  if (typeof toHexString !== 'function') return null;
  try {
    const rendered = String(toHexString.call(value));
    return /^[0-9a-f]{24}$/i.test(rendered) ? rendered.toLowerCase() : null;
  } catch {
    return null;
  }
};

/**
 * `flat_object` stores every leaf as the string the indexer serialised, and a
 * `date` field parses ISO-8601. `String(new Date())` produces neither — it
 * produces "Thu Jul 31 2026 19:00:00 GMT+0700 (…)", which matches nothing, and a
 * `must_not` that matches nothing matches every document. That is the same
 * fail-open shape the field allowlist exists to prevent, reached through operand
 * coercion instead of through the field name.
 */
const scalar = (value: unknown): string | number | boolean | null => {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new AuthorizationFilterException('a numeric operand must be finite');
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new AuthorizationFilterException('a date operand must be valid');
    }
    return value.toISOString();
  }
  if (value instanceof RegExp || typeof value === 'bigint') {
    throw new IndexFilterUnsupportedException(
      'the operand type cannot be represented faithfully by the index',
    );
  }
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

const fieldScalar = (
  field: string,
  value: unknown,
): string | number | boolean | null => {
  if (INDEXED_DATE_FIELDS.has(field)) {
    if (!(value instanceof Date)) {
      throw new IndexFilterUnsupportedException(
        `"${field}" requires a BSON Date operand`,
      );
    }
    return scalar(value);
  }
  if (typeof value === 'string') return value;
  const objectId = objectIdHex(value);
  if (objectId) return objectId;
  throw new IndexFilterUnsupportedException(
    `"${field}" requires a string or ObjectId operand to preserve BSON type semantics`,
  );
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
    if (isCustomField(field)) {
      // flat_object avoids mapping explosion, but its subfields are not
      // indexed for efficient lookup. A leaf lookup can require a full index
      // scan, which is not an acceptable ABAC path at CRM scale.
      throw new IndexFilterUnsupportedException(
        `"${field}" is a flat_object subfield and is not safe for indexed authorization filtering`,
      );
    }
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
    return { term: { [field]: fieldScalar(field, value) } };
  }

  const operators = value as Record<string, unknown>;
  const clauses = Object.entries(operators).map(([operator, operand]) => {
    switch (operator) {
      case '$in': {
        if (!Array.isArray(operand)) {
          throw new AuthorizationFilterException('$in requires an array');
        }
        if (operand.length === 0) return { match_none: {} };
        if (operand.includes(null)) {
          throw new IndexFilterUnsupportedException(
            '$in containing null requires MongoDB missing-field semantics',
          );
        }
        return {
          terms: { [field]: operand.map((entry) => fieldScalar(field, entry)) },
        };
      }
      case '$nin': {
        if (!Array.isArray(operand)) {
          throw new AuthorizationFilterException('$nin requires an array');
        }
        if (operand.length === 0) return { match_all: {} };
        if (operand.includes(null)) {
          throw new IndexFilterUnsupportedException(
            '$nin containing null requires MongoDB missing-field semantics',
          );
        }
        return {
          bool: {
            must_not: [
              {
                terms: {
                  [field]: operand.map((entry) => fieldScalar(field, entry)),
                },
              },
            ],
          },
        };
      }
      case '$ne':
        if (operand === null) {
          throw new IndexFilterUnsupportedException(
            '$ne null requires MongoDB null and missing-field semantics',
          );
        }
        return {
          bool: {
            must_not: [{ term: { [field]: fieldScalar(field, operand) } }],
          },
        };
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte': {
        // MongoDB comparison predicates use BSON type bracketing (and have
        // distinct array semantics). OpenSearch would instead parse a string
        // passed to a date field or compare a keyword lexicographically. Only
        // a BSON Date against one of our mapped date fields is equivalent.
        if (!INDEXED_DATE_FIELDS.has(field) || !(operand instanceof Date)) {
          throw new IndexFilterUnsupportedException(
            'range predicates require a Date operand on createdAt or updatedAt',
          );
        }
        return {
          range: { [field]: { [operator.slice(1)]: scalar(operand) } },
        };
      }
      case '$exists':
        if (typeof operand !== 'boolean') {
          throw new AuthorizationFilterException('$exists requires a boolean');
        }
        // MongoDB considers an explicitly-null field present; OpenSearch does
        // not index null and cannot distinguish it from a missing field.
        // Translating `$exists:false` would widen an authorization scope.
        throw new IndexFilterUnsupportedException(
          '$exists requires MongoDB null-versus-missing semantics',
        );
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
      assertBooleanOperands(field, value);
      return {
        bool: {
          filter: (value as Query[]).map(mongoAuthorizationFilterToDsl),
        },
      };
    }
    if (field === '$or') {
      assertBooleanOperands(field, value);
      return {
        bool: {
          should: (value as Query[]).map(mongoAuthorizationFilterToDsl),
          minimum_should_match: 1,
        },
      };
    }
    if (field === '$nor') {
      assertBooleanOperands(field, value);
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

function assertBooleanOperands(
  operator: string,
  value: unknown,
): asserts value is Query[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (clause) =>
        typeof clause !== 'object' || clause === null || Array.isArray(clause),
    )
  ) {
    throw new AuthorizationFilterException(
      `${operator} requires a non-empty array of predicates`,
    );
  }
}
