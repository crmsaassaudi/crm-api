/**
 * DataScope algebra — exhaustive, not sampled.
 *
 * `maxScope` sits on the read path of every scoped query, and the release bar
 * for this system is 100% on the permission-merge and conflict logic. The set is
 * small enough that "exhaustive" is literally achievable, so nothing here picks
 * representative cases: every value, and every ordered pair of values, is
 * asserted.
 *
 * The properties matter more than the examples. `maxScope` must be a
 * commutative, associative, idempotent join over a total order with SELF as the
 * identity — that is what makes "a user's scope is the widest of their roles'
 * scopes" well-defined regardless of the order roles happen to load in. A
 * regression in any of those laws would make visibility depend on query order,
 * which is the kind of bug that reproduces once a week and never in a test.
 */

import {
  DATA_SCOPE_ORDER,
  DataScope,
  isDataScope,
  maxScope,
  scopeAtLeast,
} from './data-scope.enum';

const ALL = DATA_SCOPE_ORDER;

describe('DataScope — the ordered set itself', () => {
  it('should list every enum member exactly once, narrowest first', () => {
    expect([...ALL]).toEqual([
      DataScope.SELF,
      DataScope.SUBORDINATES,
      DataScope.ORG_UNIT,
      DataScope.ORG_UNIT_SUBTREE,
      DataScope.TENANT,
    ]);
    // Guards against a member being added to the enum but not to the order
    // array, which would make it invisible to maxScope and silently narrow.
    expect(new Set(ALL).size).toBe(ALL.length);
    expect(new Set(Object.values(DataScope))).toEqual(new Set(ALL));
  });

  it('should start at SELF, the fail-closed floor', () => {
    expect(ALL[0]).toBe(DataScope.SELF);
  });

  it('should end at TENANT, the widest scope that exists inside a tenant', () => {
    expect(ALL[ALL.length - 1]).toBe(DataScope.TENANT);
  });
});

describe('isDataScope', () => {
  it.each([...ALL])('should accept %s', (scope) => {
    expect(isDataScope(scope)).toBe(true);
  });

  it.each([
    ['a near-miss typo', 'org-unit'],
    ['a plausible legacy name', 'department'],
    ['the removed Organization level', 'organization'],
    ['upper case', 'TENANT'],
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 3],
    ['an object', { scope: 'tenant' }],
    ['an array', ['tenant']],
  ])('should reject %s', (_label, value) => {
    expect(isDataScope(value)).toBe(false);
  });
});

describe('maxScope — the join operation', () => {
  it('should return SELF for no input at all', () => {
    // The fail-closed direction. A role catalogue that fails to load yields an
    // empty list, and that must narrow to SELF rather than widen to TENANT.
    expect(maxScope([])).toBe(DataScope.SELF);
  });

  it.each([...ALL])('should be idempotent on %s', (scope) => {
    expect(maxScope([scope])).toBe(scope);
    expect(maxScope([scope, scope, scope])).toBe(scope);
  });

  it('should pick the wider of every ordered pair, exhaustively', () => {
    for (const left of ALL) {
      for (const right of ALL) {
        const expected =
          DATA_SCOPE_ORDER.indexOf(left) >= DATA_SCOPE_ORDER.indexOf(right)
            ? left
            : right;
        expect(maxScope([left, right])).toBe(expected);
      }
    }
  });

  it('should be commutative over every ordered pair', () => {
    for (const left of ALL) {
      for (const right of ALL) {
        expect(maxScope([left, right])).toBe(maxScope([right, left]));
      }
    }
  });

  it('should be associative over every ordered triple', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        for (const c of ALL) {
          expect(maxScope([maxScope([a, b]), c])).toBe(
            maxScope([a, maxScope([b, c])]),
          );
        }
      }
    }
  });

  it('should treat SELF as the identity element', () => {
    for (const scope of ALL) {
      expect(maxScope([DataScope.SELF, scope])).toBe(scope);
    }
  });

  it('should be absorbed by TENANT', () => {
    for (const scope of ALL) {
      expect(maxScope([DataScope.TENANT, scope])).toBe(DataScope.TENANT);
    }
  });

  it('should IGNORE invalid values rather than let them widen or narrow', () => {
    // A typo'd scope string must not become tenant-wide access, and must not
    // erase a valid scope sitting beside it either.
    expect(maxScope(['organization', DataScope.ORG_UNIT])).toBe(
      DataScope.ORG_UNIT,
    );
    expect(maxScope([undefined, null, '', DataScope.SUBORDINATES])).toBe(
      DataScope.SUBORDINATES,
    );
    expect(maxScope(['nonsense', 42, {}, []])).toBe(DataScope.SELF);
  });

  it('should never widen when a role contributes null — "no opinion" is not TENANT', () => {
    // A role with dataScope unset must contribute nothing. If null were read as
    // "unrestricted", every legacy role in every tenant would become a
    // tenant-wide read grant the moment this shipped.
    expect(maxScope([null, null])).toBe(DataScope.SELF);
    expect(maxScope([DataScope.SELF, null])).toBe(DataScope.SELF);
  });

  it('should accept any iterable, not just arrays', () => {
    expect(maxScope(new Set([DataScope.SELF, DataScope.ORG_UNIT]))).toBe(
      DataScope.ORG_UNIT,
    );
  });
});

describe('scopeAtLeast — the comparison used by the anti-escalation guard', () => {
  it('should agree with the declared order on every ordered pair', () => {
    for (const scope of ALL) {
      for (const minimum of ALL) {
        const expected =
          DATA_SCOPE_ORDER.indexOf(scope) >= DATA_SCOPE_ORDER.indexOf(minimum);
        expect(scopeAtLeast(scope, minimum)).toBe(expected);
      }
    }
  });

  it.each([...ALL])('should be reflexive on %s', (scope) => {
    expect(scopeAtLeast(scope, scope)).toBe(true);
  });

  it('should be transitive over every ordered triple', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        for (const c of ALL) {
          if (scopeAtLeast(a, b) && scopeAtLeast(b, c)) {
            expect(scopeAtLeast(a, c)).toBe(true);
          }
        }
      }
    }
  });

  it('should be antisymmetric — mutual >= implies equality', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        if (scopeAtLeast(a, b) && scopeAtLeast(b, a)) {
          expect(a).toBe(b);
        }
      }
    }
  });

  it('should REFUSE every widening step, which is what blocks scope escalation', () => {
    // Reading the guard's contract directly: for adjacent scopes, the narrower
    // one must never satisfy a requirement for the wider one. An ORG_UNIT
    // manager authoring a TENANT-scoped role is the exploit this prevents.
    for (let i = 0; i < ALL.length - 1; i++) {
      expect(scopeAtLeast(ALL[i], ALL[i + 1])).toBe(false);
      expect(scopeAtLeast(ALL[i + 1], ALL[i])).toBe(true);
    }
  });

  it('should agree with maxScope — the join never exceeds what both sides allow', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        const joined = maxScope([a, b]);
        expect(scopeAtLeast(joined, a)).toBe(true);
        expect(scopeAtLeast(joined, b)).toBe(true);
      }
    }
  });
});
