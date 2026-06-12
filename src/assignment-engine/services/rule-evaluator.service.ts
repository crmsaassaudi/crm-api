import { Injectable, Logger } from '@nestjs/common';

/**
 * RuleEvaluatorService — evaluates assignment rules against an attribute map.
 *
 * Extracted from AssignmentEngineService (HIGH-01) so the matching logic is a
 * small, independently-testable unit instead of being buried inside the
 * 650-line engine. Behaviour is intentionally identical to the previous inline
 * implementation.
 */
@Injectable()
export class RuleEvaluatorService {
  private readonly logger = new Logger(RuleEvaluatorService.name);

  /**
   * Returns true if the rule matches the given attributes. A rule with no
   * conditions is a catch-all. `matchType: 'any'` ORs the conditions; anything
   * else (default 'all') ANDs them.
   */
  evaluateRule(rule: any, attributes: Record<string, any>): boolean {
    if (!rule.conditions || rule.conditions.length === 0) {
      return true; // Catch-all rule
    }

    const results = rule.conditions.map((cond: any) =>
      this.evaluateCondition(cond, attributes),
    );

    if (rule.matchType === 'any') {
      return results.some(Boolean);
    }
    return results.every(Boolean); // 'all' (default)
  }

  evaluateCondition(
    condition: { field: string; operator: string; value: string },
    attributes: Record<string, any>,
  ): boolean {
    const attrValue = attributes[condition.field];
    const condValue = condition.value;

    if (condValue === '' || condValue === undefined) return false;
    if (attrValue === undefined || attrValue === null) return false;

    const av = String(attrValue).toLowerCase();
    const cv = condValue.toLowerCase();

    switch (condition.operator) {
      case 'eq':
        return av === cv;
      case 'neq':
        return av !== cv;
      case 'contains':
        return av.includes(cv);
      case 'in': {
        const items = cv.split(',').map((s) => s.trim());
        return items.includes(av);
      }
      case 'gt':
        return parseFloat(attrValue) > parseFloat(condValue);
      case 'lt':
        return parseFloat(attrValue) < parseFloat(condValue);
      case 'between': {
        const [min, max] = condValue
          .split(',')
          .map((s) => parseFloat(s.trim()));
        const val = parseFloat(attrValue);
        return val >= min && val <= max;
      }
      default:
        this.logger.warn(`Unknown operator: ${condition.operator}`);
        return false;
    }
  }
}
