/**
 * Canonical vocabulary for the assignment core.
 *
 * Before consolidation there were two engines with two incompatible vocabularies:
 * `assignment_rules` used kebab-case strategies and the operator set
 * `eq/neq/contains/in/gt/lt/between`, while `routing_rules` used both snake_ and
 * kebab-case strategies and the disjoint set `eq/contains/in/starts_with`. A
 * `normalizeStrategy()` mapper papered over the first half of the mismatch and
 * nothing covered the second.
 *
 * This file is the single source of truth. Everything downstream — schemas,
 * DTOs, evaluator, UI contract — derives from these constants.
 */

// ── Object type ────────────────────────────────────────────────────────────
//
// Named `objectType`, not `module`: "module" already means a NestJS module and,
// separately, a custom-fields module. The value names the kind of record being
// assigned.

export const ASSIGNMENT_OBJECT_TYPES = [
  'Lead',
  'Contact',
  'Account',
  'Ticket',
  'Task',
  'Deal',
  'Conversation',
] as const;

export type AssignmentObjectType = (typeof ASSIGNMENT_OBJECT_TYPES)[number];

export function isAssignmentObjectType(
  value: unknown,
): value is AssignmentObjectType {
  return (
    typeof value === 'string' &&
    (ASSIGNMENT_OBJECT_TYPES as readonly string[]).includes(value)
  );
}

// ── Strategy ───────────────────────────────────────────────────────────────
//
// Kebab-case only. `sticky` is NOT a strategy here: sticky is a *preference*
// (see AssignRequest.preferred) that runs before the strategy and falls through
// to one. Keeping it in the strategy enum is what forced the old
// `strategy === 'sticky' ? fallbackStrategy : strategy` dance at two call sites.

export const ASSIGNMENT_STRATEGIES = [
  'round-robin',
  'least-busy',
  'capacity-based',
  'manual',
] as const;

export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGIES)[number];

/**
 * Accept legacy spellings from stored documents and from callers that still
 * pass the old vocabulary, and map them onto the canonical enum.
 *
 * This exists for *reading old data and old call sites*, not as a permanent
 * seam: DTOs validate against ASSIGNMENT_STRATEGIES, so nothing new can be
 * written in a legacy spelling.
 */
export function normalizeStrategy(
  value: string | null | undefined,
  fallback: AssignmentStrategy = 'round-robin',
): AssignmentStrategy {
  if (!value) return fallback;
  const legacy: Record<string, AssignmentStrategy> = {
    round_robin: 'round-robin',
    roundrobin: 'round-robin',
    least_busy: 'least-busy',
    leastbusy: 'least-busy',
    capacity_based: 'capacity-based',
    capacitybased: 'capacity-based',
    // 'sticky' used to be a strategy. A stored rule that still says so means
    // "prefer the previous assignee, then fall through" — the preference is
    // expressed separately now, so the strategy collapses to the fallback.
    sticky: fallback,
  };
  const lowered = value.toLowerCase();
  if ((ASSIGNMENT_STRATEGIES as readonly string[]).includes(lowered)) {
    return lowered as AssignmentStrategy;
  }
  return legacy[lowered] ?? fallback;
}

// ── Condition operators ────────────────────────────────────────────────────
//
// The union of both legacy sets, so no existing rule loses expressiveness and
// every objectType gains the operators the other engine had.

export const CONDITION_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'starts_with',
  'ends_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_empty',
  'is_not_empty',
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/**
 * Operators that are meaningful when the field is absent. Every other operator
 * must not match a missing field.
 *
 * The old `RuleEvaluatorService` returned false for *all* operators when the
 * attribute was null, which made `neq` wrong: "priority ≠ low" skipped every
 * record that had no priority at all.
 */
export const OPERATORS_MATCHING_ABSENT_FIELD: readonly ConditionOperator[] = [
  'neq',
  'not_contains',
  'not_in',
  'is_empty',
];

/** Operators that carry no `value` — the UI must not ask for one. */
export const VALUELESS_OPERATORS: readonly ConditionOperator[] = [
  'is_empty',
  'is_not_empty',
];

export const MATCH_TYPES = ['all', 'any'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

// ── Outcome & reason keys ──────────────────────────────────────────────────

export const ASSIGNMENT_OUTCOMES = [
  /** An assignee was selected, reserved and persisted. */
  'assigned',
  /** No assignee; the record sits in a queue (optionally owned by a group). */
  'queued',
  /** A preferred assignee was busy and the caller will retry later. */
  'deferred',
  /** Auto-assignment is off for this objectType/scope — nothing was attempted. */
  'skipped',
  /** The decision itself failed (infrastructure error). */
  'failed',
] as const;

export type AssignmentOutcome = (typeof ASSIGNMENT_OUTCOMES)[number];

/**
 * i18n keys for *why* a decision came out the way it did. The frontend
 * translates `assignment.reason.<key>` with `reasonParams`; `reason` is kept as
 * a human-readable fallback for logs and legacy rows.
 */
export const ASSIGNMENT_REASON_KEYS = [
  'assigned',
  'directUserAssign',
  'manualOverride',
  'preferredAssignee',
  'preferredWait',
  'fallbackOwner',
  'noAgentsQueued',
  'allAtCapacity',
  'emptyPool',
  'autoAssignDisabled',
  'manualStrategy',
  'groupNotEligible',
  'commitRaceLost',
  'externalDirectAssign',
  'replyAutoAssign',
  'manualAssigned',
  'manualReassigned',
  'manualUnassigned',
  'stickyMatch',
  'stickyWait',
  'bypassed',
] as const;

export type AssignmentReasonKey = (typeof ASSIGNMENT_REASON_KEYS)[number];

/** Source that triggered the decision — for audit filtering. */
export const ASSIGNMENT_SOURCES = [
  'inbound',
  'automation',
  'manual',
  'api',
  'retry',
  'fallback',
  'reply',
  'system',
] as const;

export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];
