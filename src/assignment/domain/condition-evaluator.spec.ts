import { evaluateCondition, evaluateRule } from './condition-evaluator';
import { ConditionOperator } from './assignment.types';

/**
 * These tests cover the union of the two legacy operator sets. Both engines'
 * behaviour is preserved where it was correct, and the two places where it was
 * wrong — `neq` on an absent field, and negative operators over arrays — are
 * pinned to the corrected semantics.
 */
describe('evaluateCondition', () => {
  const check = (
    field: string,
    operator: ConditionOperator,
    value: string,
    attributes: Record<string, unknown>,
  ) => evaluateCondition({ field, operator, value }, attributes).matched;

  describe('text operators', () => {
    it('should match eq case-insensitively', () => {
      expect(check('priority', 'eq', 'HIGH', { priority: 'high' })).toBe(true);
      expect(check('priority', 'eq', 'low', { priority: 'high' })).toBe(false);
    });

    it('should support contains / not_contains', () => {
      expect(
        check('content', 'contains', 'refund', {
          content: 'I want a REFUND now',
        }),
      ).toBe(true);
      expect(
        check('content', 'not_contains', 'refund', { content: 'hello' }),
      ).toBe(true);
    });

    it('should support in / not_in over a comma-separated list', () => {
      expect(
        check('priority', 'in', 'high, urgent', { priority: 'urgent' }),
      ).toBe(true);
      expect(
        check('priority', 'not_in', 'high, urgent', { priority: 'low' }),
      ).toBe(true);
      expect(check('priority', 'in', 'high, urgent', { priority: 'low' })).toBe(
        false,
      );
    });

    it('should support starts_with and ends_with', () => {
      expect(check('name', 'starts_with', 'acme', { name: 'ACME Corp' })).toBe(
        true,
      );
      expect(
        check('email', 'ends_with', '@vip.com', { email: 'a@VIP.com' }),
      ).toBe(true);
    });
  });

  describe('numeric operators', () => {
    it('should compare numerically, not lexically', () => {
      // '9' > '100' lexically; the whole point of gt is that it is not.
      expect(check('amount', 'gt', '100', { amount: 9 })).toBe(false);
      expect(check('amount', 'gt', '100', { amount: 900 })).toBe(true);
      expect(check('amount', 'gte', '100', { amount: 100 })).toBe(true);
      expect(check('amount', 'lte', '100', { amount: 100 })).toBe(true);
    });

    it('should handle between inclusively', () => {
      expect(check('amount', 'between', '10, 20', { amount: 10 })).toBe(true);
      expect(check('amount', 'between', '10, 20', { amount: 20 })).toBe(true);
      expect(check('amount', 'between', '10, 20', { amount: 21 })).toBe(false);
    });

    it('should not match when either side is not a number', () => {
      expect(check('amount', 'gt', 'many', { amount: 5 })).toBe(false);
      expect(check('amount', 'gt', '1', { amount: 'lots' })).toBe(false);
    });

    it('should compare dates by timestamp', () => {
      const past = new Date('2020-01-01T00:00:00Z');
      expect(check('closeDate', 'gt', '0', { closeDate: past })).toBe(true);
    });
  });

  describe('absent fields', () => {
    // The old record-engine evaluator returned false for EVERY operator when the
    // attribute was missing, which made `neq` wrong: "priority ≠ low" skipped
    // every record that had no priority set at all.
    it('should match neq when the field is absent', () => {
      expect(check('priority', 'neq', 'low', {})).toBe(true);
      expect(check('priority', 'neq', 'low', { priority: null })).toBe(true);
    });

    it('should match not_contains and not_in when the field is absent', () => {
      expect(check('tag', 'not_contains', 'vip', {})).toBe(true);
      expect(check('tag', 'not_in', 'vip', {})).toBe(true);
    });

    it('should not match positive operators when the field is absent', () => {
      expect(check('priority', 'eq', 'low', {})).toBe(false);
      expect(check('priority', 'contains', 'lo', {})).toBe(false);
      expect(check('amount', 'gt', '1', {})).toBe(false);
    });

    it('should treat an empty string and an empty array as absent', () => {
      expect(check('priority', 'eq', 'low', { priority: '' })).toBe(false);
      expect(check('tag', 'in', 'vip', { tag: [] })).toBe(false);
    });
  });

  describe('is_empty / is_not_empty', () => {
    it('should need no comparison value', () => {
      expect(
        evaluateCondition(
          { field: 'ownerId', operator: 'is_empty', value: '' },
          {},
        ).matched,
      ).toBe(true);
      expect(
        evaluateCondition(
          { field: 'ownerId', operator: 'is_not_empty', value: '' },
          { ownerId: 'abc' },
        ).matched,
      ).toBe(true);
    });
  });

  describe('array fields', () => {
    it('should match a positive operator when ANY element satisfies it', () => {
      expect(check('tag', 'eq', 'vip', { tag: ['normal', 'VIP'] })).toBe(true);
      expect(check('tag', 'contains', 'ip', { tag: ['normal', 'VIP'] })).toBe(
        true,
      );
      expect(check('tag', 'in', 'vip,gold', { tag: ['normal', 'VIP'] })).toBe(
        true,
      );
    });

    // The omni evaluator used `some` for negatives too, so "tag not_in VIP" was
    // true for a conversation tagged [VIP, urgent] — the opposite of the intent.
    it('should require a negative operator to hold for EVERY element', () => {
      expect(check('tag', 'not_in', 'vip', { tag: ['VIP', 'urgent'] })).toBe(
        false,
      );
      expect(check('tag', 'not_in', 'vip', { tag: ['normal', 'urgent'] })).toBe(
        true,
      );
      expect(check('tag', 'neq', 'vip', { tag: ['VIP', 'urgent'] })).toBe(
        false,
      );
    });

    it('should compare each element rather than the joined string', () => {
      // A joined comparison would match 'normal,VIP' for contains 'l,v'.
      expect(check('tag', 'contains', 'l,v', { tag: ['normal', 'VIP'] })).toBe(
        false,
      );
    });
  });

  describe('misconfiguration', () => {
    it('should not match when a value-taking operator has no value', () => {
      expect(
        evaluateCondition(
          { field: 'priority', operator: 'eq', value: '' },
          { priority: 'high' },
        ).matched,
      ).toBe(false);
    });
  });
});

describe('evaluateRule', () => {
  const rule = (
    matchType: 'all' | 'any',
    conditions: Array<{
      field: string;
      operator: ConditionOperator;
      value: string;
    }>,
  ) => ({ id: 'r1', name: 'Rule', matchType, conditions });

  it('should ANDs conditions for matchType all', () => {
    const r = rule('all', [
      { field: 'priority', operator: 'eq', value: 'high' },
      { field: 'channel', operator: 'eq', value: 'facebook' },
    ]);
    expect(
      evaluateRule(r, { priority: 'high', channel: 'facebook' }).matched,
    ).toBe(true);
    expect(evaluateRule(r, { priority: 'high', channel: 'zalo' }).matched).toBe(
      false,
    );
  });

  it('should ORs conditions for matchType any', () => {
    const r = rule('any', [
      { field: 'priority', operator: 'eq', value: 'high' },
      { field: 'channel', operator: 'eq', value: 'facebook' },
    ]);
    expect(
      evaluateRule(r, { priority: 'low', channel: 'facebook' }).matched,
    ).toBe(true);
    expect(evaluateRule(r, { priority: 'low', channel: 'zalo' }).matched).toBe(
      false,
    );
  });

  it('should treat a rule with no conditions as a catch-all', () => {
    expect(evaluateRule(rule('all', []), {}).matched).toBe(true);
  });

  it('should report a trace for every condition so a dry run can explain itself', () => {
    const trace = evaluateRule(
      rule('all', [
        { field: 'priority', operator: 'eq', value: 'high' },
        { field: 'amount', operator: 'gt', value: '100' },
      ]),
      { priority: 'low', amount: 500 },
    );
    expect(trace.matched).toBe(false);
    expect(trace.conditions).toHaveLength(2);
    expect(trace.conditions[0]).toMatchObject({
      field: 'priority',
      matched: false,
      actual: 'low',
    });
    expect(trace.conditions[1]).toMatchObject({
      field: 'amount',
      matched: true,
      actual: '500',
    });
  });
});
