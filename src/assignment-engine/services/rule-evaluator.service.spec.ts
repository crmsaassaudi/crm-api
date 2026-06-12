import { RuleEvaluatorService } from './rule-evaluator.service';

describe('RuleEvaluatorService', () => {
  let svc: RuleEvaluatorService;

  beforeEach(() => {
    svc = new RuleEvaluatorService();
  });

  describe('evaluateRule', () => {
    it('treats a rule with no conditions as a catch-all', () => {
      expect(svc.evaluateRule({ conditions: [] }, {})).toBe(true);
      expect(svc.evaluateRule({}, {})).toBe(true);
    });

    it("ANDs conditions by default ('all')", () => {
      const rule = {
        conditions: [
          { field: 'priority', operator: 'eq', value: 'high' },
          { field: 'channel', operator: 'eq', value: 'email' },
        ],
      };
      expect(svc.evaluateRule(rule, { priority: 'high', channel: 'email' })).toBe(true);
      expect(svc.evaluateRule(rule, { priority: 'high', channel: 'chat' })).toBe(false);
    });

    it("ORs conditions when matchType is 'any'", () => {
      const rule = {
        matchType: 'any',
        conditions: [
          { field: 'priority', operator: 'eq', value: 'high' },
          { field: 'channel', operator: 'eq', value: 'email' },
        ],
      };
      expect(svc.evaluateRule(rule, { priority: 'low', channel: 'email' })).toBe(true);
      expect(svc.evaluateRule(rule, { priority: 'low', channel: 'chat' })).toBe(false);
    });
  });

  describe('evaluateCondition operators', () => {
    const cond = (operator: string, value: string, field = 'f') => ({
      field,
      operator,
      value,
    });

    it('returns false when condition value is empty/undefined', () => {
      expect(svc.evaluateCondition(cond('eq', ''), { f: 'x' })).toBe(false);
    });

    it('returns false when the attribute is missing/null', () => {
      expect(svc.evaluateCondition(cond('eq', 'x'), {})).toBe(false);
      expect(svc.evaluateCondition(cond('eq', 'x'), { f: null })).toBe(false);
    });

    it('eq / neq are case-insensitive', () => {
      expect(svc.evaluateCondition(cond('eq', 'High'), { f: 'high' })).toBe(true);
      expect(svc.evaluateCondition(cond('neq', 'High'), { f: 'low' })).toBe(true);
    });

    it('contains', () => {
      expect(svc.evaluateCondition(cond('contains', 'urgent'), { f: 'super urgent ticket' })).toBe(true);
      expect(svc.evaluateCondition(cond('contains', 'urgent'), { f: 'calm' })).toBe(false);
    });

    it('in (comma list)', () => {
      expect(svc.evaluateCondition(cond('in', 'a, b, c'), { f: 'b' })).toBe(true);
      expect(svc.evaluateCondition(cond('in', 'a, b, c'), { f: 'd' })).toBe(false);
    });

    it('gt / lt (numeric)', () => {
      expect(svc.evaluateCondition(cond('gt', '5'), { f: 10 })).toBe(true);
      expect(svc.evaluateCondition(cond('gt', '5'), { f: 3 })).toBe(false);
      expect(svc.evaluateCondition(cond('lt', '5'), { f: 3 })).toBe(true);
    });

    it('between (inclusive)', () => {
      expect(svc.evaluateCondition(cond('between', '5,10'), { f: 7 })).toBe(true);
      expect(svc.evaluateCondition(cond('between', '5,10'), { f: 5 })).toBe(true);
      expect(svc.evaluateCondition(cond('between', '5,10'), { f: 11 })).toBe(false);
    });

    it('returns false for an unknown operator', () => {
      expect(svc.evaluateCondition(cond('regex', 'x'), { f: 'x' })).toBe(false);
    });
  });
});
