import {
  AssignmentObjectType,
  AssignmentStrategy,
  ConditionOperator,
  MatchType,
  normalizeStrategy,
} from './assignment.types';

export interface AssignmentCondition {
  field: string;
  operator: ConditionOperator;
  value: string;
}

/**
 * What a rule does when it matches. Precedence when several are set:
 *   1. `userId`   — pin one person; no strategy runs
 *   2. `groupIds` — ordered escalation chain; the first tier with someone
 *                   available takes it
 *
 * There is exactly ONE way to name teams. The old `routing_rules.actions` had
 * both `groupId` and `groupIds` and left every caller to reconcile them, which
 * is how one of the two kept getting ignored.
 */
export interface AssignmentRuleActions {
  userId: string | null;
  groupIds: string[];
  strategy: AssignmentStrategy | null;
  requiredSkills: string[];
}

export interface AssignmentRule {
  id: string;
  tenantId: string;
  objectType: AssignmentObjectType;
  name: string;
  description?: string | null;
  priority: number;
  matchType: MatchType;
  conditions: AssignmentCondition[];
  actions: AssignmentRuleActions;
  enabled: boolean;
}

/**
 * The subset of a matched rule the decision pipeline consumes.
 */
export interface RuleMatch {
  ruleId: string;
  ruleName: string;
  userId: string | null;
  groupIds: string[];
  strategy: AssignmentStrategy | null;
  requiredSkills: string[];
}

/**
 * Collapse every legacy shape of `actions` into the canonical one.
 *
 * Handles, in one place:
 *   - `routing_rules`: `{ groupId, groupIds[], userId, strategy, sticky }`
 *   - `assignment_rules`: `{ assignToUserId, assignToGroupId, strategy }`
 *   - snake_case strategy spellings
 *
 * Migration writes canonical documents; this stays as the read-path guard so a
 * half-migrated database degrades to correct behaviour rather than to a rule
 * whose team is silently dropped.
 */
export function normalizeRuleActions(raw: any): AssignmentRuleActions {
  const actions = raw ?? {};

  const chain = [
    actions.groupId,
    actions.assignToGroupId,
    ...(Array.isArray(actions.groupIds) ? actions.groupIds : []),
  ]
    .filter((id: unknown): id is string => Boolean(id))
    .map((id) => String(id));

  const userId = actions.userId ?? actions.assignToUserId ?? null;

  return {
    userId: userId ? String(userId) : null,
    groupIds: [...new Set(chain)],
    strategy: actions.strategy
      ? normalizeStrategy(String(actions.strategy))
      : null,
    requiredSkills: Array.isArray(actions.requiredSkills)
      ? actions.requiredSkills.map((s: unknown) => String(s))
      : [],
  };
}

export function ruleMatchOf(rule: AssignmentRule): RuleMatch {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    userId: rule.actions.userId,
    groupIds: rule.actions.groupIds,
    strategy: rule.actions.strategy,
    requiredSkills: rule.actions.requiredSkills,
  };
}
