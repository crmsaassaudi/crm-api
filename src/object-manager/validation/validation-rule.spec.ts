import {
  ValidationRule,
  evaluateRule,
  isUnsafePattern,
  parseRange,
} from './validation-rule';

const rule = (over: Partial<ValidationRule>): ValidationRule => ({
  id: 'r1',
  name: 'Rule',
  field: 'emails',
  operator: 'not_empty',
  errorMessage: 'Nope',
  isActive: true,
  ...over,
});

describe('parseRange', () => {
  it.each([
    ['1-10', 1, 10],
    ['0-100', 0, 100],
    ['5-', 5, Number.POSITIVE_INFINITY],
    ['', Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
  ])('should parse %s', (raw, min, max) => {
    expect(parseRange(raw)).toEqual({ min, max });
  });

  it('should keep a negative lower bound', () => {
    // `'-10-5'.split('-')` yields ['', '10', '5'], which the browser
    // implementation read as min=0 — so it accepted -3 for a range of -10..5 and
    // rejected nothing below zero.
    expect(parseRange('-10-5')).toEqual({ min: -10, max: 5 });
  });

  it('should keep two negative bounds', () => {
    expect(parseRange('-20--5')).toEqual({ min: -20, max: -5 });
  });

  it('should be unbounded rather than wrong for an unparseable range', () => {
    expect(parseRange('abc')).toEqual({
      min: Number.NEGATIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
    });
  });
});

describe('isUnsafePattern', () => {
  it('should reject an empty pattern', () => {
    expect(isUnsafePattern('')).toBe(true);
    expect(isUnsafePattern(undefined)).toBe(true);
  });

  it('should reject an over-long pattern', () => {
    expect(isUnsafePattern('a'.repeat(201))).toBe(true);
  });

  it('should reject a nested quantifier', () => {
    // (a+)+ against a non-matching subject is the textbook backtracking bomb.
    expect(isUnsafePattern('(a+)+$')).toBe(true);
  });

  it('should accept an ordinary email pattern', () => {
    expect(isUnsafePattern('^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$')).toBe(false);
  });
});

describe('evaluateRule', () => {
  describe('not_empty', () => {
    it.each([undefined, null, '', '   '])('should reject %p', (value) => {
      expect(evaluateRule(rule({ operator: 'not_empty' }), value)).toBe('Nope');
    });

    it('should accept a value', () => {
      expect(evaluateRule(rule({ operator: 'not_empty' }), 'x')).toBeNull();
    });

    it('should accept zero', () => {
      expect(evaluateRule(rule({ operator: 'not_empty' }), 0)).toBeNull();
    });
  });

  describe('regex', () => {
    const emailRule = rule({
      operator: 'regex',
      value: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    });

    it('should accept a matching value', () => {
      expect(evaluateRule(emailRule, 'a@b.co')).toBeNull();
    });

    it('should reject a non-matching value', () => {
      expect(evaluateRule(emailRule, 'not-an-email')).toBe('Nope');
    });

    it('should leave an empty value to the not_empty rule', () => {
      // A format rule must not silently make an optional field mandatory.
      expect(evaluateRule(emailRule, '')).toBeNull();
      expect(evaluateRule(emailRule, undefined)).toBeNull();
    });

    it('should pass rather than blocking when the pattern is unsafe', () => {
      // A broken rule is an admin's mistake to fix; turning it into a hard block
      // would let one settings row stop every create in the module.
      expect(
        evaluateRule(rule({ operator: 'regex', value: '(a+)+$' }), 'aaaa!'),
      ).toBeNull();
    });

    it('should pass rather than throwing when the pattern does not compile', () => {
      expect(
        evaluateRule(rule({ operator: 'regex', value: '([unclosed' }), 'x'),
      ).toBeNull();
    });

    it('should not hang on a long subject', () => {
      const started = Date.now();
      evaluateRule(
        rule({ operator: 'regex', value: '^[a-z]+$' }),
        'a'.repeat(100_000),
      );
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  describe('range', () => {
    const scoreRule = rule({
      operator: 'range',
      value: '1-10',
      field: 'score',
    });

    it('should accept a value inside the range', () => {
      expect(evaluateRule(scoreRule, 5)).toBeNull();
    });

    it('should accept the bounds', () => {
      expect(evaluateRule(scoreRule, 1)).toBeNull();
      expect(evaluateRule(scoreRule, 10)).toBeNull();
    });

    it('should reject a value outside the range', () => {
      expect(evaluateRule(scoreRule, 11)).toBe('Nope');
      expect(evaluateRule(scoreRule, 0)).toBe('Nope');
    });

    it('should reject a value below a negative lower bound', () => {
      const negative = rule({ operator: 'range', value: '-10-5' });
      expect(evaluateRule(negative, -11)).toBe('Nope');
      expect(evaluateRule(negative, -3)).toBeNull();
    });

    it('should reject a non-numeric value', () => {
      expect(evaluateRule(scoreRule, 'abc')).toBe('Nope');
    });

    it('should skip an absent value', () => {
      expect(evaluateRule(scoreRule, undefined)).toBeNull();
      expect(evaluateRule(scoreRule, null)).toBeNull();
    });
  });

  it('should pass an unrecognised operator through', () => {
    expect(
      evaluateRule(rule({ operator: 'unknown' as any }), 'anything'),
    ).toBeNull();
  });
});
