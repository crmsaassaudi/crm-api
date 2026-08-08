import { Injectable, Logger } from '@nestjs/common';

/**
 * A single condition rule: compare a field against a value using an operator.
 */
export interface ConditionRule {
  field: string;
  operator: string;
  value: string | number;
}

/**
 * A group of rules joined by AND/OR logic, which can contain nested groups.
 */
export interface ConditionGroup {
  logic: 'AND' | 'OR';
  rules: Array<ConditionRule | ConditionGroup>;
}

/** Type guard to distinguish nested groups from leaf rules */
function isConditionGroup(
  rule: ConditionRule | ConditionGroup,
): rule is ConditionGroup {
  return 'logic' in rule && 'rules' in rule;
}

const MAX_NESTING_DEPTH = 3;

function strictNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed === '') return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return String(parsed) === trimmed ? parsed : null;
}

@Injectable()
export class ConditionEvaluatorService {
  private readonly logger = new Logger(ConditionEvaluatorService.name);

  /**
   * Evaluate a condition group tree against record data.
   *
   * @param group  - The root condition group (AND/OR with nested rules)
   * @param data   - Flat key-value record data to evaluate against
   * @returns true if the record satisfies the conditions
   */
  evaluate(group: ConditionGroup, data: Record<string, any>): boolean {
    return this.evaluateGroup(group, data, 0);
  }

  /**
   * Validate that a condition group structure is well-formed.
   * Throws if nesting exceeds MAX_NESTING_DEPTH.
   */
  validate(group: ConditionGroup): { valid: boolean; error?: string } {
    try {
      this.checkDepth(group, 0);
      return { valid: true };
    } catch (e: any) {
      return { valid: false, error: e.message };
    }
  }

  private evaluateGroup(
    group: ConditionGroup,
    data: Record<string, any>,
    depth: number,
  ): boolean {
    if (depth > MAX_NESTING_DEPTH) {
      this.logger.warn(
        `Condition nesting depth ${depth} exceeds max ${MAX_NESTING_DEPTH} — treating as false`,
      );
      return false;
    }

    if (!group.rules || group.rules.length === 0) {
      this.logger.warn(
        'Condition group has no rules — treating as NOT matched. A filter with ' +
          'nothing to filter on cannot be assumed to mean "everything".',
      );
      return false;
    }

    const results = group.rules.map((rule) => {
      if (isConditionGroup(rule)) {
        return this.evaluateGroup(rule, data, depth + 1);
      }
      return this.evaluateRule(rule, data);
    });

    if (group.logic === 'OR') {
      return results.some(Boolean);
    }
    // Default: AND
    return results.every(Boolean);
  }

  private evaluateRule(
    rule: ConditionRule,
    data: Record<string, any>,
  ): boolean {
    // Support dot-notation nested paths: "address.city", "customFields.budget"
    const fieldValue = this.resolvePath(data, rule.field);
    const conditionValue = rule.value;

    // Special operators that work on null/undefined
    if (rule.operator === 'is_empty') {
      return this.isEmpty(fieldValue);
    }
    if (rule.operator === 'is_not_empty') {
      return !this.isEmpty(fieldValue);
    }

    // For all other operators, null field = false
    if (fieldValue === undefined || fieldValue === null) {
      return false;
    }

    // Condition value must be defined for comparison operators
    if (conditionValue === '' || conditionValue === undefined) {
      return false;
    }

    return this.applyOperator(fieldValue, rule.operator, conditionValue);
  }

  private applyOperator(
    fieldValue: any,
    operator: string,
    conditionValue: string | number,
  ): boolean {
    switch (operator) {
      case 'eq':
        return this.compareEqual(fieldValue, conditionValue);

      case 'neq':
        return !this.compareEqual(fieldValue, conditionValue);

      case 'gt':
        return this.compareNumeric(fieldValue, conditionValue, (a, b) => a > b);

      case 'lt':
        return this.compareNumeric(fieldValue, conditionValue, (a, b) => a < b);

      case 'gte':
        return this.compareNumeric(
          fieldValue,
          conditionValue,
          (a, b) => a >= b,
        );

      case 'lte':
        return this.compareNumeric(
          fieldValue,
          conditionValue,
          (a, b) => a <= b,
        );

      case 'contains':
        return String(fieldValue)
          .toLowerCase()
          .includes(String(conditionValue).toLowerCase());

      case 'not_contains':
        return !String(fieldValue)
          .toLowerCase()
          .includes(String(conditionValue).toLowerCase());

      default:
        this.logger.warn(`Unknown condition operator: ${operator}`);
        return false;
    }
  }

  private compareEqual(
    fieldValue: any,
    conditionValue: string | number,
  ): boolean {
    const fNum = strictNumber(fieldValue);
    const cNum = strictNumber(conditionValue);
    if (fNum !== null && cNum !== null) return fNum === cNum;

    return (
      String(fieldValue).trim().toLowerCase() ===
      String(conditionValue).trim().toLowerCase()
    );
  }

  private compareNumeric(
    fieldValue: any,
    conditionValue: string | number,
    comparator: (a: number, b: number) => boolean,
  ): boolean {
    const fNum = strictNumber(fieldValue);
    const cNum = strictNumber(conditionValue);

    if (fNum === null || cNum === null) {
      this.logger.debug(
        `Type mismatch in numeric comparison: field=${fieldValue}, condition=${conditionValue}`,
      );
      return false; // Type mismatch → false
    }

    return comparator(fNum, cNum);
  }

  private isEmpty(value: any): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
  }

  private checkDepth(group: ConditionGroup, depth: number): void {
    if (depth > MAX_NESTING_DEPTH) {
      throw new Error(
        `Condition nesting depth ${depth} exceeds maximum of ${MAX_NESTING_DEPTH}`,
      );
    }
    for (const rule of group.rules) {
      if (isConditionGroup(rule)) {
        this.checkDepth(rule, depth + 1);
      }
    }
  }

  private resolvePath(data: Record<string, any>, path: string): any {
    // Fast path: no dots → flat lookup (most common case)
    if (!path.includes('.')) return data[path];

    const keys = path.split('.');
    let value: any = data;
    for (const key of keys) {
      if (value === undefined || value === null) return undefined;
      // SECURITY: Block prototype pollution vectors
      if (key === '__proto__' || key === 'constructor' || key === 'prototype')
        return undefined;
      value = value[key];
    }
    return value;
  }
}
