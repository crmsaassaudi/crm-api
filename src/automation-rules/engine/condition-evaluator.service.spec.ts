import { ConditionEvaluatorService } from './condition-evaluator.service';
import { ConditionGroup } from './condition-evaluator.service';

describe('ConditionEvaluatorService', () => {
  let service: ConditionEvaluatorService;

  beforeEach(() => {
    service = new ConditionEvaluatorService();
  });

  // ── Empty / No Conditions ───────────────────────────────────────────────

  it('should return true for empty rules (pass-through)', () => {
    const group: ConditionGroup = { logic: 'AND', rules: [] };
    expect(service.evaluate(group, { status: 'New' })).toBe(true);
  });

  // ── AND logic ──────────────────────────────────────────────────────────

  it('should return true when AND: all conditions match', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [
        { field: 'status', operator: 'eq', value: 'New' },
        { field: 'source', operator: 'eq', value: 'Website' },
      ],
    };
    expect(service.evaluate(group, { status: 'New', source: 'Website' })).toBe(
      true,
    );
  });

  it('should return false when AND: one condition fails', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [
        { field: 'status', operator: 'eq', value: 'New' },
        { field: 'source', operator: 'eq', value: 'Website' },
      ],
    };
    expect(service.evaluate(group, { status: 'New', source: 'Facebook' })).toBe(
      false,
    );
  });

  // ── OR logic ───────────────────────────────────────────────────────────

  it('should return true when OR: one condition matches', () => {
    const group: ConditionGroup = {
      logic: 'OR',
      rules: [
        { field: 'status', operator: 'eq', value: 'New' },
        { field: 'status', operator: 'eq', value: 'Open' },
      ],
    };
    expect(service.evaluate(group, { status: 'Open' })).toBe(true);
  });

  it('should return false when OR: no conditions match', () => {
    const group: ConditionGroup = {
      logic: 'OR',
      rules: [
        { field: 'status', operator: 'eq', value: 'New' },
        { field: 'status', operator: 'eq', value: 'Open' },
      ],
    };
    expect(service.evaluate(group, { status: 'Closed' })).toBe(false);
  });

  // ── Nested groups ──────────────────────────────────────────────────────

  it('should return true for Nested AND([status=New, OR([source=Web, source=FB])])', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [
        { field: 'status', operator: 'eq', value: 'New' },
        {
          logic: 'OR',
          rules: [
            { field: 'source', operator: 'eq', value: 'Website' },
            { field: 'source', operator: 'eq', value: 'Facebook' },
          ],
        },
      ],
    };
    expect(service.evaluate(group, { status: 'New', source: 'Facebook' })).toBe(
      true,
    );
  });

  it('should return false for Nested AND with source=Zalo', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [
        { field: 'status', operator: 'eq', value: 'New' },
        {
          logic: 'OR',
          rules: [
            { field: 'source', operator: 'eq', value: 'Website' },
            { field: 'source', operator: 'eq', value: 'Facebook' },
          ],
        },
      ],
    };
    expect(service.evaluate(group, { status: 'New', source: 'Zalo' })).toBe(
      false,
    );
  });

  // ── Numeric operators ──────────────────────────────────────────────────

  it('should return true when gt: amount > 1000 and amount=1500', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'amount', operator: 'gt', value: 1000 }],
    };
    expect(service.evaluate(group, { amount: 1500 })).toBe(true);
  });

  it('should return false when gt: amount > 1000 and amount=500', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'amount', operator: 'gt', value: 1000 }],
    };
    expect(service.evaluate(group, { amount: 500 })).toBe(false);
  });

  it('should return true when lt: priority < 3 and priority=1', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'priority', operator: 'lt', value: 3 }],
    };
    expect(service.evaluate(group, { priority: 1 })).toBe(true);
  });

  it('should return true when gte: score >= 80 and score=80', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'score', operator: 'gte', value: 80 }],
    };
    expect(service.evaluate(group, { score: 80 })).toBe(true);
  });

  it('should return false when lte: score <= 80 and score=90', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'score', operator: 'lte', value: 80 }],
    };
    expect(service.evaluate(group, { score: 90 })).toBe(false);
  });

  // ── String operators ───────────────────────────────────────────────────

  it('should match case-insensitively when contains: name contains Nguyen', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'name', operator: 'contains', value: 'nguyen' }],
    };
    expect(service.evaluate(group, { name: 'Nguyen Van A' })).toBe(true);
  });

  it('should return true when not_contains: name not_contains xyz', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'name', operator: 'not_contains', value: 'xyz' }],
    };
    expect(service.evaluate(group, { name: 'Nguyen Van A' })).toBe(true);
  });

  it('should return true when neq: status != Closed and status=Open', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'status', operator: 'neq', value: 'Closed' }],
    };
    expect(service.evaluate(group, { status: 'Open' })).toBe(true);
  });

  // ── Null / Empty operators ─────────────────────────────────────────────

  it('should return true when is_empty and field is null', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'email', operator: 'is_empty', value: '' }],
    };
    expect(service.evaluate(group, { email: null })).toBe(true);
  });

  it('should return true when is_empty and field is undefined', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'email', operator: 'is_empty', value: '' }],
    };
    expect(service.evaluate(group, {})).toBe(true);
  });

  it('should return true when is_empty and field is empty string', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'email', operator: 'is_empty', value: '' }],
    };
    expect(service.evaluate(group, { email: '  ' })).toBe(true);
  });

  it('should return true when is_not_empty and field has value', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'email', operator: 'is_not_empty', value: '' }],
    };
    expect(service.evaluate(group, { email: 'test@example.com' })).toBe(true);
  });

  // ── Null field with comparison operators → false ────────────────────────

  it('should return false when eq and field is null', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'status', operator: 'eq', value: 'New' }],
    };
    expect(service.evaluate(group, { status: null })).toBe(false);
  });

  // ── Type mismatch on numeric operators → false ─────────────────────────

  it('should return false when gt with text field and numeric operator', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'name', operator: 'gt', value: 100 }],
    };
    expect(service.evaluate(group, { name: 'not-a-number' })).toBe(false);
  });

  // ── Validation ─────────────────────────────────────────────────────────

  it('should be invalid when validate depth > 3', () => {
    // 5 levels of nesting: depth 0 → 1 → 2 → 3 → 4 (exceeds max 3)
    const deepGroup: ConditionGroup = {
      logic: 'AND',
      rules: [
        {
          logic: 'OR',
          rules: [
            {
              logic: 'AND',
              rules: [
                {
                  logic: 'OR',
                  rules: [
                    {
                      logic: 'AND',
                      rules: [{ field: 'x', operator: 'eq', value: '1' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = service.validate(deepGroup);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exceeds maximum');
  });

  it('should be valid when validate depth = 3', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [
        {
          logic: 'OR',
          rules: [
            {
              logic: 'AND',
              rules: [{ field: 'x', operator: 'eq', value: '1' }],
            },
          ],
        },
      ],
    };
    const result = service.validate(group);
    expect(result.valid).toBe(true);
  });

  // ── String numeric coercion (eq with string numbers) ───────────────────

  it('should coerce numeric strings: "100" eq 100 returns true', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      rules: [{ field: 'amount', operator: 'eq', value: 100 }],
    };
    expect(service.evaluate(group, { amount: '100' })).toBe(true);
  });
});
