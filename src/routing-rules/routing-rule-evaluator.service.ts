import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { RoutingRuleRepository } from './infrastructure/persistence/document/repositories/routing-rule.repository';
import { RoutingRule } from './domain/routing-rule';

/**
 * Context that the evaluator uses to match routing rule conditions.
 * Populated from the inbound message payload at assignment time.
 */
export interface RoutingContext {
  /** lowercase channel type: 'facebook', 'zalo', 'whatsapp', ... */
  channel?: string;
  /** conversation tags */
  tags?: string[];
  /** customer display name */
  customerName?: string;
  /** message text content */
  content?: string;
  /** ISO hour string "HH:mm" in tenant timezone */
  time?: string;
  /** customer segment (e.g. 'VIP', 'Normal') */
  segment?: string;
}

/**
 * Result when a routing rule matches — carries the action instructions
 * so the AssignmentService can apply the right team/strategy/skills.
 */
export interface RoutingRuleMatch {
  ruleId: string;
  ruleName: string;
  teamId: string;
  strategy: string;
  sticky: boolean;
  requiredSkills: string[];
}

/**
 * RoutingRuleEvaluatorService — evaluates routing rules against an
 * inbound message context and returns the first matching rule's actions.
 *
 * Rules are evaluated in priority order (ascending). The first rule
 * whose conditions match wins. Disabled rules are skipped.
 *
 * Performance:
 *   Rules are cached in-memory per tenant with a 60s TTL. Since rules
 *   are admin-edited (few times/day) but evaluated per-message (thousands/min),
 *   this eliminates ~99.99% of DB reads with minimal staleness risk.
 *   Cache is also explicitly invalidated on CRUD operations via invalidateCache().
 *
 * Condition operators:
 *   - eq: exact match (case-insensitive)
 *   - contains: substring match (case-insensitive)
 *   - in: comma-separated list check (case-insensitive)
 *   - starts_with: prefix match (case-insensitive)
 *
 * Match types:
 *   - all: ALL conditions must match (AND)
 *   - any: at least ONE condition must match (OR)
 */
@Injectable()
export class RoutingRuleEvaluatorService {
  private readonly logger = new Logger(RoutingRuleEvaluatorService.name);

  /** In-memory cache: tenantId → { rules, expiresAt } */
  private readonly ruleCache = new Map<
    string,
    { rules: RoutingRule[]; expiresAt: number }
  >();

  /** Cache TTL in milliseconds (60 seconds) */
  private readonly CACHE_TTL_MS = 60_000;

  constructor(
    private readonly repository: RoutingRuleRepository,
    private readonly cls: ClsService,
  ) {}

  /**
   * Invalidate the cached rules for a specific tenant.
   * Called by RoutingRulesService on create/update/delete/reorder.
   */
  invalidateCache(tenantId: string): void {
    this.ruleCache.delete(tenantId);
    this.logger.debug(`Routing rules cache invalidated for tenant ${tenantId}`);
  }

  /**
   * Evaluate all enabled routing rules for the current tenant
   * against the given context. Returns the first matching rule's
   * actions, or null if no rule matches.
   */
  async evaluate(context: RoutingContext): Promise<RoutingRuleMatch | null> {
    const tenantId = this.cls.get('tenantId');
    return this.evaluateForTenant(tenantId, context);
  }

  /**
   * Evaluate rules for a specific tenant (used by AssignmentService
   * which already has tenantId from its own context).
   */
  async evaluateForTenant(
    tenantId: string,
    context: RoutingContext,
  ): Promise<RoutingRuleMatch | null> {
    const rules = await this.getEnabledRulesCached(tenantId);

    for (const rule of rules) {
      if (this.matchesRule(rule, context)) {
        this.logger.log(
          `Routing rule matched: "${rule.name}" (id=${rule.id}, priority=${rule.priority}) for tenant ${tenantId}`,
        );
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          teamId: rule.actions.teamId,
          strategy: rule.actions.strategy,
          sticky: rule.actions.sticky,
          requiredSkills: rule.actions.requiredSkills ?? [],
        };
      }
    }

    this.logger.debug(
      `No routing rule matched for tenant ${tenantId} — using default routing`,
    );
    return null;
  }

  /**
   * Get enabled rules with in-memory caching.
   * Returns cached rules if still within TTL, otherwise fetches from DB.
   */
  private async getEnabledRulesCached(
    tenantId: string,
  ): Promise<RoutingRule[]> {
    const now = Date.now();
    const cached = this.ruleCache.get(tenantId);

    if (cached && cached.expiresAt > now) {
      return cached.rules;
    }

    const rules = await this.repository.findEnabledByTenant(tenantId);
    this.ruleCache.set(tenantId, {
      rules,
      expiresAt: now + this.CACHE_TTL_MS,
    });

    return rules;
  }

  /**
   * Check if a single rule matches the given context.
   */
  private matchesRule(rule: RoutingRule, context: RoutingContext): boolean {
    if (rule.conditions.length === 0) {
      // A rule with no conditions always matches (catch-all)
      return true;
    }

    const results = rule.conditions.map((cond) =>
      this.evaluateCondition(cond, context),
    );

    if (rule.matchType === 'any') {
      return results.some(Boolean);
    }
    // matchType === 'all' (default)
    return results.every(Boolean);
  }

  /**
   * Evaluate a single condition against the context.
   */
  private evaluateCondition(
    condition: { field: string; operator: string; value: string },
    context: RoutingContext,
  ): boolean {
    const contextValue = this.getFieldValue(condition.field, context);
    const conditionValue = condition.value;

    if (conditionValue === '' || conditionValue === undefined) {
      // Empty condition value — skip (treat as not matching)
      return false;
    }

    // For array fields like 'tag', check if any element matches
    if (condition.field === 'tag' && Array.isArray(context.tags)) {
      return this.evaluateArrayField(
        context.tags,
        condition.operator,
        conditionValue,
      );
    }

    if (contextValue === undefined || contextValue === null) {
      return false;
    }

    return this.applyOperator(
      String(contextValue),
      condition.operator,
      conditionValue,
    );
  }

  /**
   * Extract the value for a field from the context.
   */
  private getFieldValue(
    field: string,
    context: RoutingContext,
  ): string | undefined {
    switch (field) {
      case 'channel':
        return context.channel;
      case 'tag':
        // Tags are handled separately in evaluateCondition
        return context.tags?.join(',');
      case 'customer_name':
        return context.customerName;
      case 'content':
        return context.content;
      case 'time':
        return context.time;
      case 'segment':
        return context.segment;
      default:
        return undefined;
    }
  }

  /**
   * Apply an operator to compare contextValue against conditionValue.
   */
  private applyOperator(
    contextValue: string,
    operator: string,
    conditionValue: string,
  ): boolean {
    const cv = contextValue.toLowerCase();
    const target = conditionValue.toLowerCase();

    switch (operator) {
      case 'eq':
        return cv === target;

      case 'contains':
        return cv.includes(target);

      case 'in': {
        // conditionValue is comma-separated list, check if contextValue is in it
        const items = target.split(',').map((s) => s.trim());
        return items.includes(cv);
      }

      case 'starts_with':
        return cv.startsWith(target);

      default:
        this.logger.warn(`Unknown routing condition operator: ${operator}`);
        return false;
    }
  }

  /**
   * For array fields (e.g. tags), check if any element in the array
   * satisfies the operator against the condition value.
   */
  private evaluateArrayField(
    values: string[],
    operator: string,
    conditionValue: string,
  ): boolean {
    switch (operator) {
      case 'eq':
        return values.some(
          (v) => v.toLowerCase() === conditionValue.toLowerCase(),
        );

      case 'contains':
        return values.some((v) =>
          v.toLowerCase().includes(conditionValue.toLowerCase()),
        );

      case 'in': {
        const items = conditionValue
          .toLowerCase()
          .split(',')
          .map((s) => s.trim());
        return values.some((v) => items.includes(v.toLowerCase()));
      }

      case 'starts_with':
        return values.some((v) =>
          v.toLowerCase().startsWith(conditionValue.toLowerCase()),
        );

      default:
        return false;
    }
  }
}
