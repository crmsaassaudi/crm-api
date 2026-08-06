import { BadRequestException } from '@nestjs/common';
import { FilterQuery } from 'mongoose';
import { Types } from 'mongoose';

/**
 * The contact filter compiler — one translation from a user-supplied condition
 * tree to a Mongo predicate, shared by the list view, export and segments.
 *
 * Four invariants, each pinned by a case in `contact-filter.spec.ts`:
 *   - every condition lands in `$and`/`$or`, never on a shared key, so two
 *     conditions on one field intersect instead of overwriting;
 *   - a falsy value is a value: `isVIP = false` and `score <= 0` are conditions;
 *   - operators are typed, so `contains` cannot be applied to a date;
 *   - an unknown field or operator is REFUSED. Quietly widening a result set is
 *     how someone emails the wrong segment.
 */

export type FilterFieldType =
  | 'text'
  | 'identity'
  | 'reference'
  | 'multi'
  | 'boolean'
  | 'number'
  | 'date';

export const FILTER_OPERATORS = [
  'eq',
  'ne',
  'in',
  'nin',
  'contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_empty',
  'is_not_empty',
  'in_last_days',
  'not_in_last_days',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface FilterGroup {
  match: 'all' | 'any';
  conditions: Array<FilterCondition | FilterGroup>;
}

const isGroup = (node: FilterCondition | FilterGroup): node is FilterGroup =>
  Array.isArray((node as FilterGroup).conditions);

interface FieldSpec {
  /** Document path. Differs from the public name for owner-style references. */
  column: string;
  type: FilterFieldType;
}

/**
 * Filterable contact fields, by the name a client uses.
 *
 * `owner`/`createdBy`/`updatedBy` keep their UI-facing names and map onto the
 * `*Id` columns, because that is what every saved view and every list-view
 * column definition in the product already calls them.
 */
const FIELDS: Record<string, FieldSpec> = {
  firstName: { column: 'firstName', type: 'text' },
  lastName: { column: 'lastName', type: 'text' },
  companyName: { column: 'companyName', type: 'text' },
  title: { column: 'title', type: 'text' },
  role: { column: 'role', type: 'text' },
  address: { column: 'address', type: 'text' },
  city: { column: 'city', type: 'text' },
  country: { column: 'country', type: 'reference' },
  externalId: { column: 'externalId', type: 'reference' },
  externalSource: { column: 'externalSource', type: 'reference' },

  emails: { column: 'emails', type: 'identity' },
  phones: { column: 'phones', type: 'identity' },

  lifecycleStageId: { column: 'lifecycleStageId', type: 'reference' },
  statusId: { column: 'statusId', type: 'reference' },
  sourceId: { column: 'sourceId', type: 'reference' },
  accountId: { column: 'accountId', type: 'reference' },
  owner: { column: 'ownerId', type: 'reference' },
  createdBy: { column: 'createdById', type: 'reference' },
  updatedBy: { column: 'updatedById', type: 'reference' },
  orgUnitId: { column: 'orgUnitId', type: 'reference' },

  tags: { column: 'tags', type: 'multi' },

  isVIP: { column: 'isVIP', type: 'boolean' },
  isShadow: { column: 'isShadow', type: 'boolean' },
  emailOptIn: { column: 'emailOptIn', type: 'boolean' },
  smsOptIn: { column: 'smsOptIn', type: 'boolean' },
  doNotCall: { column: 'doNotCall', type: 'boolean' },

  score: { column: 'score', type: 'number' },
  totalRevenue: { column: 'totalRevenue', type: 'number' },
  dealsCount: { column: 'dealsCount', type: 'number' },
  wonDealsCount: { column: 'wonDealsCount', type: 'number' },

  createdAt: { column: 'createdAt', type: 'date' },
  updatedAt: { column: 'updatedAt', type: 'date' },
  lastActivityAt: { column: 'lastActivityAt', type: 'date' },
  lastPurchaseAt: { column: 'lastPurchaseAt', type: 'date' },
  birthday: { column: 'birthday', type: 'date' },
};

/** Which operators make sense for which type. Enforced, not documented. */
const OPERATORS_BY_TYPE: Record<
  FilterFieldType,
  ReadonlySet<FilterOperator>
> = {
  text: new Set([
    'eq',
    'ne',
    'contains',
    'starts_with',
    'in',
    'nin',
    'is_empty',
    'is_not_empty',
  ]),
  identity: new Set([
    'eq',
    'ne',
    'contains',
    'starts_with',
    'in',
    'is_empty',
    'is_not_empty',
  ]),
  reference: new Set(['eq', 'ne', 'in', 'nin', 'is_empty', 'is_not_empty']),
  multi: new Set(['in', 'nin', 'eq', 'is_empty', 'is_not_empty']),
  boolean: new Set(['eq']),
  number: new Set([
    'eq',
    'ne',
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'is_empty',
    'is_not_empty',
  ]),
  date: new Set([
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'in_last_days',
    'not_in_last_days',
    'is_empty',
    'is_not_empty',
  ]),
};

/** Operators that carry no value — anything else must supply one. */
const VALUELESS: ReadonlySet<FilterOperator> = new Set([
  'is_empty',
  'is_not_empty',
]);

export const FILTERABLE_CONTACT_FIELDS = Object.keys(FIELDS);

const CUSTOM_FIELD_PREFIX = 'customFields.';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function toNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException(`Filter "${field}" expects a number`);
  }
  return parsed;
}

function toDate(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Filter "${field}" expects a date`);
  }
  return parsed;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/**
 * `is_empty` for an array field means "no elements"; for a scalar it means null,
 * missing or empty string. Both are expressed without `$exists`, so a value
 * explicitly written as `null` and a field never written behave identically.
 */
function emptyPredicate(spec: FieldSpec, negate: boolean): unknown {
  const isArrayField = spec.type === 'multi' || spec.type === 'identity';
  if (isArrayField) {
    return negate ? { $exists: true, $ne: [] } : { $in: [null, []] };
  }
  return negate ? { $nin: [null, ''] } : { $in: [null, ''] };
}

function compileCondition(
  condition: FilterCondition,
  allowedCustomFieldKeys?: ReadonlySet<string>,
): Record<string, unknown> {
  const { field, operator } = condition;

  if (!FILTER_OPERATORS.includes(operator)) {
    throw new BadRequestException(`Unsupported filter operator "${operator}"`);
  }

  const spec = resolveField(field, allowedCustomFieldKeys);

  if (!OPERATORS_BY_TYPE[spec.type].has(operator)) {
    throw new BadRequestException(
      `Operator "${operator}" cannot be applied to "${field}"`,
    );
  }

  if (!VALUELESS.has(operator) && condition.value === undefined) {
    throw new BadRequestException(`Filter "${field}" requires a value`);
  }

  return { [spec.column]: buildPredicate(spec, condition) };
}

function resolveField(
  field: string,
  allowedCustomFieldKeys?: ReadonlySet<string>,
): FieldSpec {
  if (field.startsWith(CUSTOM_FIELD_PREFIX)) {
    const key = field.slice(CUSTOM_FIELD_PREFIX.length);
    // A custom-field filter is only honoured for a key the tenant declared. An
    // arbitrary dotted path here would reopen the field-injection hole the
    // whitelist exists to close.
    if (!key || !allowedCustomFieldKeys?.has(key)) {
      throw new BadRequestException(`Unknown filter field "${field}"`);
    }
    return { column: `customFields.${key}`, type: 'text' };
  }

  // An own-property check, not `FIELDS[field]`: a plain object literal inherits
  // from Object.prototype, so `FIELDS['__proto__']` returns the prototype itself
  // — truthy, with no `type`, which throws in the operator lookup instead of
  // being refused as the unknown field it is. 'constructor' and 'toString' have
  // the same shape.
  if (!Object.prototype.hasOwnProperty.call(FIELDS, field)) {
    throw new BadRequestException(`Unknown filter field "${field}"`);
  }
  return FIELDS[field];
}

function buildPredicate(spec: FieldSpec, condition: FilterCondition): unknown {
  const { field, operator, value } = condition;

  switch (operator) {
    case 'is_empty':
      return emptyPredicate(spec, false);
    case 'is_not_empty':
      return emptyPredicate(spec, true);

    case 'eq':
      return spec.type === 'boolean'
        ? coerceBoolean(value)
        : coerce(spec, value);
    case 'ne':
      return { $ne: coerce(spec, value) };

    case 'in':
      return { $in: asArray(value).map((item) => coerce(spec, item)) };
    case 'nin':
      return { $nin: asArray(value).map((item) => coerce(spec, item)) };

    // Case-insensitive substring. Only offered on text/identity: an unanchored
    // regex is a collection scan, and offering it on an indexed reference field
    // would turn a cheap equality into one by accident.
    case 'contains':
      return { $regex: escapeRegex(String(value)), $options: 'i' };
    // Anchored and case-SENSITIVE so Mongo can use the index — stored identities
    // are already normalised, so there is no case left to be insensitive about.
    case 'starts_with':
      return { $regex: `^${escapeRegex(String(value))}` };

    case 'gt':
      return { $gt: coerceOrdinal(spec, value, field) };
    case 'gte':
      return { $gte: coerceOrdinal(spec, value, field) };
    case 'lt':
      return { $lt: coerceOrdinal(spec, value, field) };
    case 'lte':
      return { $lte: coerceOrdinal(spec, value, field) };

    case 'between': {
      const [from, to] = asArray(value);
      if (from === undefined || to === undefined) {
        throw new BadRequestException(
          `Filter "${field}" with "between" expects [from, to]`,
        );
      }
      return {
        $gte: coerceOrdinal(spec, from, field),
        $lte: coerceOrdinal(spec, to, field),
      };
    }

    // "Active in the last N days" and its complement. The complement includes
    // records that have NEVER been active — a contact with no activity at all is
    // the most dormant kind there is, and excluding it is what makes a
    // re-engagement segment miss the people it exists to find.
    case 'in_last_days':
      return { $gte: daysAgo(toNumber(value, field)) };
    case 'not_in_last_days':
      return { $not: { $gte: daysAgo(toNumber(value, field)) } };
  }
}

function coerceBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function coerce(spec: FieldSpec, value: unknown): unknown {
  switch (spec.type) {
    case 'boolean':
      return coerceBoolean(value);
    case 'number':
      return toNumber(value, spec.column);
    case 'date':
      return toDate(value, spec.column);
    case 'reference':
      // Reference columns hold ObjectIds; a string never matches one. Values that
      // are not ObjectIds (a lifecycle stage apiName, a country code) stay as
      // supplied.
      return Types.ObjectId.isValid(String(value)) &&
        String(new Types.ObjectId(String(value))) === String(value)
        ? new Types.ObjectId(String(value))
        : value;
    default:
      return value;
  }
}

function coerceOrdinal(
  spec: FieldSpec,
  value: unknown,
  field: string,
): unknown {
  return spec.type === 'date' ? toDate(value, field) : toNumber(value, field);
}

/**
 * Compile a condition tree into a Mongo predicate.
 *
 * Always returns clauses inside `$and` / `$or` arrays rather than as top-level
 * keys, so no two conditions can collide on the same field name.
 */
export function compileContactFilter(
  node: FilterGroup,
  allowedCustomFieldKeys?: ReadonlySet<string>,
): FilterQuery<any> | null {
  const compiled = node.conditions
    .map((child) =>
      isGroup(child)
        ? compileContactFilter(child, allowedCustomFieldKeys)
        : compileCondition(child, allowedCustomFieldKeys),
    )
    .filter((clause): clause is Record<string, unknown> => clause !== null);

  if (compiled.length === 0) return null;
  return node.match === 'any' ? { $or: compiled } : { $and: compiled };
}

/**
 * Accept both the condition tree and the flat `[{id, value}]` list the contact
 * list has always sent, so the UI can migrate one screen at a time.
 *
 * The legacy form is interpreted exactly as before — array means `in`, string
 * means `contains` — except that it no longer discards falsy values or unknown
 * fields.
 */
export function parseContactFilter(raw: unknown): FilterGroup | null {
  const parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (!parsed) return null;

  if (Array.isArray(parsed)) {
    const conditions = parsed
      .map(toCondition)
      .filter((condition): condition is FilterCondition => condition !== null);
    return conditions.length ? { match: 'all', conditions } : null;
  }

  const group = parsed as FilterGroup;
  if (Array.isArray(group.conditions)) {
    return {
      match: group.match === 'any' ? 'any' : 'all',
      conditions: group.conditions,
    };
  }

  throw new BadRequestException('Malformed filter expression');
}

function toCondition(entry: any): FilterCondition | null {
  if (!entry || typeof entry !== 'object') return null;

  const field = entry.field ?? entry.id;
  if (typeof field !== 'string' || !field) return null;

  if (entry.operator) {
    return { field, operator: entry.operator, value: entry.value };
  }

  // Legacy shape. An explicitly empty value is a no-op filter, not a condition —
  // the UI sends one while the user is still choosing a value.
  if (
    entry.value === undefined ||
    entry.value === null ||
    entry.value === '' ||
    (Array.isArray(entry.value) && entry.value.length === 0)
  ) {
    return null;
  }

  return {
    field,
    operator: Array.isArray(entry.value) ? 'in' : legacyScalarOperator(field),
    value: entry.value,
  };
}

/**
 * What a bare string used to mean, per field.
 *
 * Identity and reference fields matched exactly; free text matched as a
 * substring. Preserved so an existing saved view keeps returning what it did.
 */
function legacyScalarOperator(field: string): FilterOperator {
  const spec = FIELDS[field];
  if (!spec) return 'eq';
  return spec.type === 'text' ? 'contains' : 'eq';
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestException('Malformed filter expression');
  }
}
