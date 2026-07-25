/**
 * ABAC condition evaluator — a small, pure, deterministic policy engine that
 * layers attribute-based conditions on top of RBAC.
 *
 * It is intentionally NOT a general expression language: policies are lists of
 * simple `{attribute, operator, value|valueAttribute}` conditions combined with
 * AND. This keeps evaluation total (no thrown errors, no eval), auditable, and
 * safe to run on the hot path.
 *
 * Context shape (attributes are dot-paths into this object):
 *   {
 *     subject:  { id, tenantId, principalType, roleIds, groupIds, ... },
 *     resource: { ...the record being acted on... },
 *     env:      { now, ip, ... },
 *   }
 */

export type AbacOperator =
  | 'eq'
  | 'ne'
  | 'in'
  | 'nin'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains' // left (array or string) contains value
  | 'exists'; // value: boolean — attribute is (not) null/undefined

export type PolicyEffect = 'allow' | 'deny';

export interface AbacCondition {
  /** Dot-path into the context, e.g. "resource.stage" or "subject.id". */
  attribute: string;
  operator: AbacOperator;
  /** Literal comparison value. */
  value?: unknown;
  /** Alternatively compare against another context attribute (dot-path). */
  valueAttribute?: string;
}

export interface AbacPolicy {
  effect: PolicyEffect;
  /** ALL conditions must hold for the policy to apply (AND). Empty = always. */
  conditions: AbacCondition[];
}

export interface AbacContext {
  subject?: Record<string, unknown>;
  resource?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

/** Safe dot-path resolver — never throws, returns undefined on any miss. */
function getPath(ctx: AbacContext, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split('.');
  let cur: any = ctx;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function asComparable(v: unknown): number | string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v);
}

/**
 * Coerce a pair of operands to a comparable pair of the SAME type (H-05).
 *
 * The old code compared `typeof l !== typeof r` and bailed out with `false`.
 * That looks conservative but is a fail-open for deny policies: `env.now` is a
 * Date normalized to a number, while a policy value authored through a date
 * picker — or round-tripped through Mongo — is an ISO string. The comparison
 * silently never held, so a time-boxed DENY silently never applied.
 *
 * Coercion rules, in order:
 *   1. both numeric (number or numeric string)   → compare as numbers
 *   2. either side is date-like (Date | ISO/parseable date string) → epoch ms
 *   3. otherwise                                  → compare as strings
 *
 * Returns null only when an operand is genuinely absent, which is the one case
 * where "no opinion" is correct.
 */
/** What kind of value this is, for the purpose of ordering comparisons. */
type Ordinal = 'number' | 'date' | 'text';

function classify(
  value: unknown,
): { kind: Ordinal; value: number | string } | null {
  if (value == null) return null;

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : { kind: 'date', value: time };
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? { kind: 'number', value } : null;
  }

  if (typeof value !== 'string') return { kind: 'text', value: String(value) };

  const trimmed = value.trim();
  if (trimmed === '') return { kind: 'text', value: '' };

  // An ISO-ish date string. Checked BEFORE numbers so "2026-07-25" is a date
  // rather than the subtraction 2026-7-25. `Date.parse` alone is too permissive.
  if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(trimmed)) {
    const epoch = Date.parse(trimmed);
    if (!Number.isNaN(epoch)) return { kind: 'date', value: epoch };
  }

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return { kind: 'number', value: asNumber };

  return { kind: 'text', value };
}

/**
 * Coerce two operands into a comparable, same-kind pair, or null when the
 * comparison is not meaningful.
 *
 * The old implementation compared raw `typeof`, which made two correct-looking
 * policies silently un-evaluable (H-05):
 *   - `env.now` (a Date → number) vs an ISO-string literal from a date picker
 *   - a numeric field stored as a string vs a number literal
 * Both now compare correctly, because a Date and an ISO string are both `date`,
 * and 5000 and "5000" are both `number`.
 *
 * A genuinely mixed comparison — `resource.stage` ("won") vs `3` — stays
 * un-evaluable. Lexicographically "won" > "3" is *defined* but meaningless, and
 * silently returning a value for a nonsensical policy is how fail-open bugs get
 * written in the first place.
 */
function coercePair(
  left: unknown,
  right: unknown,
): [number, number] | [string, string] | null {
  const l = classify(left);
  const r = classify(right);
  if (l === null || r === null) return null;

  // A date and a number are interchangeable (epoch millis).
  const sameKind =
    l.kind === r.kind ||
    (l.kind === 'date' && r.kind === 'number') ||
    (l.kind === 'number' && r.kind === 'date');

  if (!sameKind) return null;

  return l.kind === 'text'
    ? [String(l.value), String(r.value)]
    : [Number(l.value), Number(r.value)];
}

function looseEquals(a: unknown, b: unknown): boolean {
  const ca = asComparable(a);
  const cb = asComparable(b);
  return ca === cb;
}

export function evaluateCondition(
  condition: AbacCondition,
  ctx: AbacContext,
): boolean {
  const left = getPath(ctx, condition.attribute);
  const right =
    condition.valueAttribute !== undefined
      ? getPath(ctx, condition.valueAttribute)
      : condition.value;

  switch (condition.operator) {
    case 'eq':
      return looseEquals(left, right);
    case 'ne':
      return !looseEquals(left, right);
    case 'in':
      return Array.isArray(right)
        ? right.some((r) => looseEquals(left, r))
        : false;
    case 'nin':
      return Array.isArray(right)
        ? !right.some((r) => looseEquals(left, r))
        : true;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const pair = coercePair(left, right);
      // Un-evaluable (absent operand, or incomparable kinds). `false` is the
      // right answer for an allow policy; policyApplies() inverts it for a deny.
      if (pair === null) return false;
      const [l, r] = pair as [any, any];
      if (condition.operator === 'gt') return l > r;
      if (condition.operator === 'gte') return l >= r;
      if (condition.operator === 'lt') return l < r;
      return l <= r;
    }
    case 'contains':
      if (Array.isArray(left)) return left.some((x) => looseEquals(x, right));
      if (typeof left === 'string') return left.includes(String(right));
      return false;
    case 'exists': {
      const present = left !== undefined && left !== null;
      return right === false ? !present : present;
    }
    default:
      // Unknown operator. Returning false here is only safe for an ALLOW
      // policy; for a DENY it would mean "this restriction does not apply",
      // i.e. a silent bypass. policyApplies() therefore inspects the operator
      // itself and never reaches this branch for a deny (H-05).
      return false;
  }
}

const KNOWN_OPERATORS = new Set<string>([
  'eq',
  'ne',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'exists',
]);

/**
 * A policy applies when ALL of its conditions hold (empty conditions = always).
 *
 * A condition whose operator is not recognised is UNEVALUABLE, which is a
 * different thing from false. For a deny policy an unevaluable condition must
 * be treated as holding — the restriction stays in force — otherwise a policy
 * that was written before an operator was renamed, or inserted by a migration
 * or direct DB edit, silently stops protecting anything.
 *
 * For an allow policy the opposite is correct: an unevaluable condition must not
 * grant. Both directions are "fail closed"; they just point opposite ways.
 */
export function policyApplies(policy: AbacPolicy, ctx: AbacContext): boolean {
  const failClosed = policy.effect === 'deny';

  return policy.conditions.every((condition) => {
    if (isUnevaluable(condition, ctx)) return failClosed;
    return evaluateCondition(condition, ctx);
  });
}

/**
 * A condition is UNEVALUABLE — as distinct from false — when the evaluator
 * cannot form an opinion at all:
 *   - the operator is not one it knows (renamed operator, migration, direct DB
 *     edit, a policy written against a newer schema);
 *   - an ordering comparison whose operands are of incomparable kinds.
 *
 * The distinction matters because "false" points in opposite directions for the
 * two effects: an allow that cannot be evaluated must not grant, and a deny that
 * cannot be evaluated must not stop restricting. Collapsing both into `false`
 * was the H-05 fail-open — a malformed DENY silently protected nothing.
 */
function isUnevaluable(condition: AbacCondition, ctx: AbacContext): boolean {
  if (!KNOWN_OPERATORS.has(condition.operator as string)) return true;

  if (['gt', 'gte', 'lt', 'lte'].includes(condition.operator)) {
    const left = getPath(ctx, condition.attribute);
    const right =
      condition.valueAttribute !== undefined
        ? getPath(ctx, condition.valueAttribute)
        : condition.value;
    return coercePair(left, right) === null;
  }

  return false;
}

/**
 * Combine matching policies with deny-overrides semantics:
 *   - any applicable DENY  → 'deny'
 *   - else any applicable ALLOW → 'allow'
 *   - else → null (no opinion; caller falls back to RBAC/ownership default)
 */
export function evaluatePolicies(
  policies: AbacPolicy[],
  ctx: AbacContext,
): PolicyEffect | null {
  let sawAllow = false;
  for (const policy of policies) {
    if (!policyApplies(policy, ctx)) continue;
    if (policy.effect === 'deny') return 'deny';
    sawAllow = true;
  }
  return sawAllow ? 'allow' : null;
}
