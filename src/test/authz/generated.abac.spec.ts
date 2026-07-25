/**
 * ABAC evaluator matrix — operators × operand types × effects.
 *
 * Three groups of assertions:
 *
 *   1. TOTALITY   — the evaluator never throws and always returns a boolean,
 *                   for any operator against any operand shape.
 *   2. SEMANTICS  — AND-ing, deny-overrides, and the null "no opinion" result.
 *   3. H-05       — the comparison-operator fail-open, now remediated. These
 *                   were `it.failing` (red-by-intent) while the bug was open;
 *                   they became ordinary assertions when it was fixed.
 *
 * The truth-table snapshot at the end is a stability guard, not a correctness
 * one: any change to operand coercion shows up as a reviewable diff, which is
 * exactly the kind of change that must never happen accidentally in an
 * authorization path.
 */

import {
  evaluateCondition,
  evaluatePolicies,
  policyApplies,
  type AbacCondition,
  type AbacContext,
  type AbacOperator,
  type AbacPolicy,
} from '../../common/permissions/abac.evaluator';

const OPERATORS: AbacOperator[] = [
  'eq',
  'ne',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'exists',
];

const OWNER = '000000000000000000000002';
const OTHER = '000000000000000000000003';

const ctx = (overrides: Partial<AbacContext> = {}): AbacContext => ({
  subject: {
    id: OWNER,
    tenantId: 'tenant-a',
    groupIds: ['g1'],
    ...overrides.subject,
  },
  resource: {
    ownerId: OWNER,
    assigneeId: OTHER,
    stage: 'won',
    ...overrides.resource,
  },
  env: {
    now: new Date('2026-07-25T12:00:00Z'),
    ip: '10.0.0.1',
    ...overrides.env,
  },
});

const cond = (
  attribute: string,
  operator: AbacOperator,
  value?: unknown,
  valueAttribute?: string,
): AbacCondition => ({ attribute, operator, value, valueAttribute });

describe('ABAC evaluator — totality contract', () => {
  it('should never throw, for any operator against any operand shape', () => {
    const operands: unknown[] = [
      undefined,
      null,
      0,
      '',
      false,
      NaN,
      [],
      {},
      new Date(0),
      'string',
      -1,
      [1, 2],
    ];
    const paths = [
      'subject.id',
      'resource.ownerId',
      'resource.missing',
      'env.now',
      '',
      'a.b.c.d.e',
      'subject.__proto__',
      'subject.constructor',
    ];

    for (const operator of OPERATORS) {
      for (const value of operands) {
        for (const attribute of paths) {
          expect(() =>
            evaluateCondition(cond(attribute, operator, value), ctx()),
          ).not.toThrow();
        }
      }
    }
  });

  it('should return a strict boolean for every combination', () => {
    for (const operator of OPERATORS) {
      const result = evaluateCondition(
        cond('resource.ownerId', operator, OWNER),
        ctx(),
      );
      expect(typeof result).toBe('boolean');
    }
  });

  it('should resolve a missing path to undefined rather than throwing', () => {
    expect(
      evaluateCondition(cond('resource.nope.deeper', 'exists', true), ctx()),
    ).toBe(false);
  });

  it('should still resolve prototype-chain paths at evaluation time (L-02 closed at write time)', () => {
    // The evaluator itself stays permissive and total by design. The surface is
    // closed at the WRITE path instead: AccessPolicyService.validateConditions
    // now rejects any attribute whose root is not subject/resource/env, and any
    // segment named __proto__ / constructor / prototype (L-02). Asserted here so
    // the two halves of that decision stay visible together.
    const reachable = evaluateCondition(
      cond('subject.constructor', 'exists', true),
      ctx(),
    );
    expect(reachable).toBe(true);
  });
});

describe('ABAC evaluator — core semantics', () => {
  it('should compare eq / ne loosely across ObjectId-vs-string', () => {
    expect(
      evaluateCondition(
        cond('resource.ownerId', 'eq', undefined, 'subject.id'),
        ctx(),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        cond('resource.assigneeId', 'ne', undefined, 'subject.id'),
        ctx(),
      ),
    ).toBe(true);
  });

  it('should treat a policy with NO conditions as always applying', () => {
    expect(policyApplies({ effect: 'deny', conditions: [] }, ctx())).toBe(true);
  });

  it('should let an empty-condition DENY block everything — a real footgun', () => {
    expect(evaluatePolicies([{ effect: 'deny', conditions: [] }], ctx())).toBe(
      'deny',
    );
  });

  it('should AND conditions together; there is no OR', () => {
    const policy: AbacPolicy = {
      effect: 'allow',
      conditions: [
        cond('resource.ownerId', 'eq', undefined, 'subject.id'),
        cond('resource.stage', 'eq', 'lost'),
      ],
    };
    expect(policyApplies(policy, ctx())).toBe(false);
  });

  it('should apply deny-overrides: any applicable deny beats every allow', () => {
    const policies: AbacPolicy[] = [
      { effect: 'allow', conditions: [] },
      { effect: 'allow', conditions: [] },
      { effect: 'deny', conditions: [cond('resource.stage', 'eq', 'won')] },
    ];
    expect(evaluatePolicies(policies, ctx())).toBe('deny');
  });

  it('should return null when no policy applies (defer to RBAC), not allow', () => {
    expect(
      evaluatePolicies(
        [{ effect: 'allow', conditions: [cond('resource.stage', 'eq', 'x')] }],
        ctx(),
      ),
    ).toBeNull();
  });

  it('should require an array for in / nin right operand', () => {
    expect(
      evaluateCondition(cond('subject.id', 'in', [OWNER, OTHER]), ctx()),
    ).toBe(true);
    expect(evaluateCondition(cond('subject.id', 'in', OWNER), ctx())).toBe(
      false,
    );
  });

  it('should return TRUE for nin with a NON-array operand — a malformed nin deny blocks everyone', () => {
    // The mirror image of H-05: here the fail direction is closed, so a
    // misconfigured policy causes a total outage instead of a silent bypass.
    // Both directions are bugs; this one at least announces itself.
    expect(evaluateCondition(cond('subject.id', 'nin', 'oops'), ctx())).toBe(
      true,
    );
  });

  it('should substring-match contains on a string, so ids can collide (L-01)', () => {
    const context = ctx({ resource: { ownerId: 'abc000000000000000000123' } });
    expect(
      evaluateCondition(cond('resource.ownerId', 'contains', '0000'), context),
    ).toBe(true);
  });

  it('should distinguish absent from falsy in exists', () => {
    const context = ctx({ resource: { ownerId: null, stage: '' } });
    expect(
      evaluateCondition(cond('resource.ownerId', 'exists', true), context),
    ).toBe(false);
    expect(
      evaluateCondition(cond('resource.stage', 'exists', true), context),
    ).toBe(true);
  });
});

describe('ABAC comparison operators — H-05 REMEDIATED', () => {
  /**
   * These assertions were red-by-intent while H-05 was open; they are now the
   * contract. Two distinct bugs were fixed:
   *
   *   1. Comparisons used raw `typeof`, so `env.now` (a Date → epoch number)
   *      never compared against an ISO-string literal — the shape a date picker
   *      and a Mongo round-trip both produce. A time-boxed DENY silently did
   *      nothing.
   *   2. An un-evaluable condition returned `false`, which for a DENY means
   *      "restriction does not apply" — a silent bypass. Un-evaluable is now
   *      distinguished from false and fails closed per effect.
   */
  const timeDeny = (value: unknown): AbacPolicy => ({
    effect: 'deny',
    conditions: [cond('env.now', 'lt', value)],
  });

  it('should compare a Date attribute against an ISO-string literal', () => {
    expect(
      evaluateCondition(cond('env.now', 'lt', '2027-01-01T00:00:00Z'), ctx()),
    ).toBe(true);
  });

  it('should still work with epoch-millis operands', () => {
    const future = new Date('2027-01-01T00:00:00Z').getTime();
    expect(evaluatePolicies([timeDeny(future)], ctx())).toBe('deny');
  });

  it('should deny on an ISO-string time window', () => {
    expect(evaluatePolicies([timeDeny('2027-01-01T00:00:00Z')], ctx())).toBe(
      'deny',
    );
  });

  it('should still deny for a Date operand that round-tripped through JSON', () => {
    const persistedAsString = JSON.parse(
      JSON.stringify({ v: new Date('2027-01-01T00:00:00Z') }),
    ).v;
    expect(evaluatePolicies([timeDeny(persistedAsString)], ctx())).toBe('deny');
  });

  it('should compare numeric strings as numbers', () => {
    const context = ctx({ resource: { amount: '5000' } });
    expect(
      evaluateCondition(cond('resource.amount', 'gt', 1000), context),
    ).toBe(true);
    expect(
      evaluateCondition(cond('resource.amount', 'lt', 1000), context),
    ).toBe(false);
  });

  it('should keep incomparable kinds un-evaluable rather than comparing as text', () => {
    // "won" > 3 is lexicographically defined but meaningless. Returning a value
    // for a nonsensical policy is how fail-open bugs are written.
    expect(evaluateCondition(cond('resource.stage', 'gt', 3), ctx())).toBe(
      false,
    );
  });

  it('should FAIL CLOSED for an un-evaluable condition on a deny policy', () => {
    const policy: AbacPolicy = {
      effect: 'deny',
      conditions: [cond('resource.stage', 'gt', 3)],
    };
    expect(evaluatePolicies([policy], ctx())).toBe('deny');
  });

  it('should NOT grant for an un-evaluable condition on an allow policy', () => {
    const policy: AbacPolicy = {
      effect: 'allow',
      conditions: [cond('resource.stage', 'gt', 3)],
    };
    expect(evaluatePolicies([policy], ctx())).toBeNull();
  });

  it('should FAIL CLOSED for an unknown operator on a deny policy', () => {
    // validateConditions rejects unknown operators at write time, but a policy
    // predating an operator rename — or inserted by a migration, seeder, or
    // direct DB edit — must not silently stop denying.
    const policy = {
      effect: 'deny',
      conditions: [
        {
          attribute: 'resource.ownerId',
          operator: 'regex' as any,
          value: '.*',
        },
      ],
    } as AbacPolicy;
    expect(evaluatePolicies([policy], ctx())).toBe('deny');
  });

  it('should NOT grant for an unknown operator on an allow policy', () => {
    const policy = {
      effect: 'allow',
      conditions: [
        {
          attribute: 'resource.ownerId',
          operator: 'regex' as any,
          value: '.*',
        },
      ],
    } as AbacPolicy;
    expect(evaluatePolicies([policy], ctx())).toBeNull();
  });
});

describe('ABAC evaluator — operator × type truth table', () => {
  /**
   * Exhaustive snapshot of every operator against every operand-type pair.
   * Not asserting correctness here — asserting STABILITY. Any change to
   * coercion shows up as a diff in this table, which is exactly the kind of
   * change that must never happen by accident in an authorization path.
   */
  const typedOperands: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['numericString', '42'],
    ['string', 'abc'],
    ['emptyString', ''],
    ['boolTrue', true],
    ['boolFalse', false],
    ['date', new Date('2026-01-01T00:00:00Z')],
    ['isoString', '2026-01-01T00:00:00Z'],
    ['array', [42]],
  ];

  it('should match the recorded truth table', () => {
    const table: Record<string, boolean> = {};

    for (const operator of OPERATORS) {
      for (const [leftName, left] of typedOperands) {
        for (const [rightName, right] of typedOperands) {
          const context: AbacContext = { resource: { probe: left } };
          table[`${operator}(${leftName},${rightName})`] = evaluateCondition(
            cond('resource.probe', operator, right),
            context,
          );
        }
      }
    }

    expect(table).toMatchSnapshot();
  });
});
