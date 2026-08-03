import { AssignmentCondition, AssignmentRule } from './assignment-rule';
import {
  ConditionOperator,
  MatchType,
  OPERATORS_MATCHING_ABSENT_FIELD,
  VALUELESS_OPERATORS,
} from './assignment.types';

/**
 * The attribute bag a rule is matched against.
 *
 * Values are whatever the domain produced — string, number, Date, string[].
 * Normalisation happens here, once, instead of in each caller.
 */
export type AssignmentAttributes = Record<string, unknown>;

/** Result of comparing one condition — kept for the dry-run explain output. */
export interface ConditionTrace {
  field: string;
  operator: ConditionOperator;
  value: string;
  actual: string | null;
  matched: boolean;
}

export interface RuleTrace {
  ruleId: string;
  ruleName: string;
  matchType: MatchType;
  matched: boolean;
  conditions: ConditionTrace[];
}

// Value coercion

function isAbsent(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * Flatten a raw attribute to the list of strings a comparison runs over.
 *
 * An array field (tags, skills) compares element-wise with "any element
 * satisfies the operator" semantics; a scalar becomes a one-element list. This
 * removes the special-cased `if (field === 'tag')` branch the omni evaluator
 * had, which meant every *other* array field silently compared against
 * `String(['a','b'])`.
 */
function toComparableList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v) => v !== null && v !== undefined).map(asText);
  }
  return [asText(value)];
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // ObjectId and friends — their toString is the hex id, which is what rules
    // that compare ids expect.
    return String(value);
  }
  return String(value);
}

function asNumber(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return parseFloat(asText(value));
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

// Single-operator comparison

/**
 * Compare one already-coerced pair. Case-insensitive for text operators,
 * numeric for the ordering ones.
 */
function compareOne(
  actual: string,
  operator: ConditionOperator,
  expected: string,
  rawActual: unknown,
): boolean {
  const a = actual.toLowerCase();
  const b = expected.toLowerCase();

  switch (operator) {
    case 'eq':
      return a === b;
    case 'neq':
      return a !== b;
    case 'contains':
      return a.includes(b);
    case 'not_contains':
      return !a.includes(b);
    case 'in':
      return splitList(expected).includes(a);
    case 'not_in':
      return !splitList(expected).includes(a);
    case 'starts_with':
      return a.startsWith(b);
    case 'ends_with':
      return a.endsWith(b);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = asNumber(rawActual);
      const right = parseFloat(expected);
      if (Number.isNaN(left) || Number.isNaN(right)) return false;
      if (operator === 'gt') return left > right;
      if (operator === 'gte') return left >= right;
      if (operator === 'lt') return left < right;
      return left <= right;
    }
    case 'between': {
      const [minRaw, maxRaw] = expected.split(',');
      const min = parseFloat((minRaw ?? '').trim());
      const max = parseFloat((maxRaw ?? '').trim());
      const left = asNumber(rawActual);
      if (Number.isNaN(min) || Number.isNaN(max) || Number.isNaN(left)) {
        return false;
      }
      return left >= min && left <= max;
    }
    case 'is_empty':
      return false; // handled by the absent-field branch
    case 'is_not_empty':
      return true; // reaching here means the field is present
    default:
      return false;
  }
}

/**
 * Evaluate one condition against the attribute bag.
 *
 * Absent-field handling is explicit: only the operators in
 * OPERATORS_MATCHING_ABSENT_FIELD may match a field that is not there. Every
 * other operator returns false, which is what "the data does not say so" means.
 */
export function evaluateCondition(
  condition: AssignmentCondition,
  attributes: AssignmentAttributes,
): ConditionTrace {
  const operator = condition.operator;
  const raw = attributes[condition.field];
  const absent = isAbsent(raw);
  const needsValue = !VALUELESS_OPERATORS.includes(operator);

  const trace: ConditionTrace = {
    field: condition.field,
    operator,
    value: condition.value ?? '',
    actual: absent ? null : toComparableList(raw).join(', '),
    matched: false,
  };

  // A condition with no comparison value is a configuration mistake, not a
  // catch-all. Matching it would hand the rule to everyone.
  if (needsValue && (condition.value === undefined || condition.value === '')) {
    return trace;
  }

  if (absent) {
    trace.matched = OPERATORS_MATCHING_ABSENT_FIELD.includes(operator);
    return trace;
  }

  if (operator === 'is_empty') {
    trace.matched = false;
    return trace;
  }
  if (operator === 'is_not_empty') {
    trace.matched = true;
    return trace;
  }

  const candidates = toComparableList(raw);
  const rawList = Array.isArray(raw) ? raw : [raw];

  // Negative operators over an array must hold for EVERY element ("none of the
  // tags is VIP"), positive ones for ANY element. Using `some` for both is how
  // "tag not_in VIP" ends up true for a conversation tagged [VIP, urgent].
  const negative =
    operator === 'neq' || operator === 'not_contains' || operator === 'not_in';

  trace.matched = negative
    ? candidates.every((text, i) =>
        compareOne(text, operator, condition.value, rawList[i]),
      )
    : candidates.some((text, i) =>
        compareOne(text, operator, condition.value, rawList[i]),
      );

  return trace;
}

/**
 * Evaluate a rule. No conditions = catch-all (matches everything), which is how
 * a default rule is expressed.
 */
export function evaluateRule(
  rule: Pick<AssignmentRule, 'id' | 'name' | 'matchType' | 'conditions'>,
  attributes: AssignmentAttributes,
): RuleTrace {
  const conditions = (rule.conditions ?? []).map((c) =>
    evaluateCondition(c, attributes),
  );

  const matched =
    conditions.length === 0
      ? true
      : rule.matchType === 'any'
        ? conditions.some((c) => c.matched)
        : conditions.every((c) => c.matched);

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    matchType: rule.matchType,
    matched,
    conditions,
  };
}
