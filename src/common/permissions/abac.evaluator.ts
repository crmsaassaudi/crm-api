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
      const l = asComparable(left);
      const r = asComparable(right);
      if (l == null || r == null || typeof l !== typeof r) return false;
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
      // Unknown operator → fail closed for allow, open for deny is handled by
      // the caller. Here a condition simply does not hold.
      return false;
  }
}

/** A policy applies when ALL of its conditions hold (empty conditions = always). */
export function policyApplies(policy: AbacPolicy, ctx: AbacContext): boolean {
  return policy.conditions.every((c) => evaluateCondition(c, ctx));
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
