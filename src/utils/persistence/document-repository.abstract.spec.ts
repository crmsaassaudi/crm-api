/**
 * BaseDocumentRepository — the query-shaping half of data visibility.
 *
 * Every scoped read in the CRM funnels through `applyTenantFilter`, so this is
 * the one place where a scope decision becomes a Mongo predicate. The tests read
 * the produced filter rather than mocking Mongo, because the bug class that
 * matters here is structural: a clause in the wrong position, an `$and` that
 * clobbers a caller predicate, or an empty `$in` that turns a widening clause
 * into a match-nothing one.
 *
 * The asymmetry to keep in mind throughout: on the owner/unit axes an
 * over-broad filter leaks data, while an over-narrow one merely hides it. Both
 * are asserted, but the leak direction is asserted more aggressively.
 */

import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from './document-repository.abstract';

interface Row {
  ownerId?: string | null;
  orgUnitId?: string | null;
}

class TestRepository extends BaseDocumentRepository<any, Row> {
  constructor(cls: ClsService) {
    super({} as any, cls);
  }
  protected mapToDomain(doc: any): Row {
    return doc;
  }
  protected toPersistence(domain: Row): any {
    return domain;
  }
  /** Exposed for assertion — the method itself is protected by design. */
  public filterFor(input: Record<string, unknown> = {}) {
    return this.applyTenantFilter(input as any);
  }
  public enrich(data: Partial<Row>) {
    return (this as any).enrichWithContext(data, true);
  }
}

class VisibilityDisabledRepository extends TestRepository {
  protected enableDataVisibility(): boolean {
    return false;
  }
}

class ContactRepository extends TestRepository {
  protected visibilityModule(): string {
    return 'Contact';
  }
}

const clsWith = (values: Record<string, unknown>): ClsService =>
  ({ get: (key: string) => values[key] }) as any;

/** The `$or` branch list the visibility layer appended, if any. */
const orClauses = (filter: any): any[] | undefined =>
  filter.$and?.find((clause: any) => clause.$or)?.$or;

describe('applyTenantFilter — compiled ABAC predicate', () => {
  it('intersects the matching resource predicate with caller and row scope', () => {
    const denyFilter = { $nor: [{ confidential: true }] };
    const repo = new ContactRepository(
      clsWith({
        visibleOwnerIds: ['u1'],
        abacResourceFilter: { resource: 'contacts', filter: denyFilter },
      }),
    );

    expect(repo.filterFor({ status: 'open' })).toEqual({
      status: 'open',
      $and: [
        { $or: [{ ownerId: { $in: ['u1'] } }] },
        denyFilter,
      ],
    });
  });

  it('never applies one endpoint resource policy to a related repository', () => {
    const repo = new ContactRepository(
      clsWith({
        abacResourceFilter: {
          resource: 'tickets',
          filter: { $nor: [{ priority: 'high' }] },
        },
      }),
    );
    expect(repo.filterFor({ status: 'open' })).toEqual({ status: 'open' });
  });
});

describe('applyTenantFilter — owner axis', () => {
  it('should add no clause at all when visibility was never evaluated', () => {
    const repo = new TestRepository(clsWith({}));
    expect(repo.filterFor({ status: 'open' })).toEqual({ status: 'open' });
  });

  it('should add no clause for the admin bypass (null)', () => {
    const repo = new TestRepository(clsWith({ visibleOwnerIds: null }));
    expect(repo.filterFor({ status: 'open' })).toEqual({ status: 'open' });
  });

  it('should restrict to the visible owners', () => {
    const repo = new TestRepository(clsWith({ visibleOwnerIds: ['u1', 'u2'] }));
    expect(orClauses(repo.filterFor())).toEqual([
      { ownerId: { $in: ['u1', 'u2'] } },
    ]);
  });

  it('should MATCH NOTHING for an empty owner list', () => {
    // The fail-closed case: the visibility layer sets [] when it cannot resolve
    // a scope. `$in: []` matching no rows is the correct, intended outcome here —
    // in contrast to the org-unit axis below, where [] means "adds nothing".
    const repo = new TestRepository(clsWith({ visibleOwnerIds: [] }));
    expect(orClauses(repo.filterFor())).toEqual([{ ownerId: { $in: [] } }]);
  });

  it('should HIDE unowned records by default (C3)', () => {
    const repo = new TestRepository(clsWith({ visibleOwnerIds: ['u1'] }));
    expect(orClauses(repo.filterFor())).not.toContainEqual({ ownerId: null });
  });

  it('should include unowned records only when the tenant opts in', () => {
    const repo = new TestRepository(
      clsWith({ visibleOwnerIds: ['u1'], includeUnownedInScope: true }),
    );
    expect(orClauses(repo.filterFor())).toContainEqual({ ownerId: null });
  });

  it('should require a strict boolean true to open the unowned pool', () => {
    // A truthy-but-not-true value (a stray "false" string, a 1 from a JSON
    // round-trip) must not silently expose the unassigned queue.
    for (const value of ['true', 1, {}, 'false']) {
      const repo = new TestRepository(
        clsWith({ visibleOwnerIds: ['u1'], includeUnownedInScope: value }),
      );
      expect(orClauses(repo.filterFor())).not.toContainEqual({ ownerId: null });
    }
  });

  it('should skip the whole visibility layer when a subclass disables it', () => {
    const repo = new VisibilityDisabledRepository(
      clsWith({ visibleOwnerIds: ['u1'], visibleOrgUnitIds: ['unit_b'] }),
    );
    expect(repo.filterFor({ email: 'a@b.c' })).toEqual({ email: 'a@b.c' });
  });
});

describe('applyTenantFilter — org-unit axis (H-07)', () => {
  it('should UNION the unit clause with the owner clause, not intersect it', () => {
    // ORG_UNIT means "my records AND my unit's records". Intersecting would make
    // a wider scope return fewer rows — the surprise that makes a scope model
    // untrustworthy — and would hide a subordinate who sits in another unit.
    const repo = new TestRepository(
      clsWith({ visibleOwnerIds: ['u1'], visibleOrgUnitIds: ['unit_b'] }),
    );
    const clauses = orClauses(repo.filterFor())!;

    expect(clauses).toEqual([
      { ownerId: { $in: ['u1'] } },
      { orgUnitId: { $in: ['unit_b'] } },
    ]);
    // One $or, not two $and-ed conditions.
    expect(repo.filterFor().$and).toHaveLength(1);
  });

  it('should carry the whole subtree when several units are visible', () => {
    const repo = new TestRepository(
      clsWith({
        visibleOwnerIds: ['u1'],
        visibleOrgUnitIds: ['unit_b', 'unit_t'],
      }),
    );
    expect(orClauses(repo.filterFor())).toContainEqual({
      orgUnitId: { $in: ['unit_b', 'unit_t'] },
    });
  });

  it('should add NOTHING for an empty unit list rather than an empty $in', () => {
    // The bug this pins down: `orgUnitId: { $in: [] }` inside the same $or is
    // harmless, but writing it as a separate $and clause — or letting it replace
    // the owner clause — would erase the very filter it was meant to widen. An
    // unassigned user, and every SELF/SUBORDINATES scope, produces [].
    const repo = new TestRepository(
      clsWith({ visibleOwnerIds: ['u1'], visibleOrgUnitIds: [] }),
    );
    expect(orClauses(repo.filterFor())).toEqual([{ ownerId: { $in: ['u1'] } }]);
  });

  it('should add nothing when the unit axis is null (admin) or unset', () => {
    for (const value of [null, undefined]) {
      const repo = new TestRepository(
        clsWith({ visibleOwnerIds: ['u1'], visibleOrgUnitIds: value }),
      );
      expect(orClauses(repo.filterFor())).toEqual([
        { ownerId: { $in: ['u1'] } },
      ]);
    }
  });

  it('should NOT apply the unit axis while the owner axis is bypassed', () => {
    // visibleOwnerIds === null is the admin/TENANT-scope path. Adding a unit
    // restriction on top would NARROW an admin — the opposite of the intent.
    const repo = new TestRepository(
      clsWith({ visibleOwnerIds: null, visibleOrgUnitIds: ['unit_b'] }),
    );
    expect(repo.filterFor({ status: 'open' })).toEqual({ status: 'open' });
  });

  it('should ignore a non-array unit value rather than build a broken clause', () => {
    const repo = new TestRepository(
      clsWith({ visibleOwnerIds: ['u1'], visibleOrgUnitIds: 'unit_b' }),
    );
    expect(orClauses(repo.filterFor())).toEqual([{ ownerId: { $in: ['u1'] } }]);
  });
});

describe('applyTenantFilter — composition with caller predicates', () => {
  it('should PRESERVE a caller-supplied $and instead of replacing it', () => {
    const repo = new TestRepository(clsWith({ visibleOwnerIds: ['u1'] }));
    const filter = repo.filterFor({
      $and: [{ stage: 'won' }],
    });
    expect(filter.$and).toHaveLength(2);
    expect(filter.$and).toContainEqual({ stage: 'won' });
  });

  it('should not let a caller $or swallow the visibility $or', () => {
    // A caller `$or` stays at the top level while the visibility `$or` is nested
    // inside `$and`, so the two are ANDed. If the visibility clause were merged
    // into the caller's `$or`, any caller filter would widen its own scope.
    const repo = new TestRepository(clsWith({ visibleOwnerIds: ['u1'] }));
    const filter: any = repo.filterFor({
      $or: [{ stage: 'won' }, { stage: 'lost' }],
    });
    expect(filter.$or).toEqual([{ stage: 'won' }, { stage: 'lost' }]);
    expect(orClauses(filter)).toEqual([{ ownerId: { $in: ['u1'] } }]);
  });

  it('should leave the input filter object untouched', () => {
    const repo = new TestRepository(clsWith({ visibleOwnerIds: ['u1'] }));
    const input = { status: 'open' };
    repo.filterFor(input);
    expect(input).toEqual({ status: 'open' });
  });
});

describe('enrichWithContext — stamping orgUnitId on create (H-07)', () => {
  it('should stamp the creator org unit so unit scopes have something to match', () => {
    const repo = new TestRepository(
      clsWith({ tenantId: 't1', userId: 'u1', userOrgUnitId: 'unit_b' }),
    );
    expect(repo.enrich({})).toMatchObject({
      tenantId: 't1',
      ownerId: 'u1',
      orgUnitId: 'unit_b',
    });
  });

  it('should NOT overwrite an explicitly supplied unit', () => {
    // Importers and transfer flows legitimately file a record in another unit.
    // Rewriting that to the acting user's unit would move data between scopes as
    // a side effect of merely touching it.
    const repo = new TestRepository(
      clsWith({ tenantId: 't1', userId: 'u1', userOrgUnitId: 'unit_b' }),
    );
    expect(repo.enrich({ orgUnitId: 'unit_other' }).orgUnitId).toBe(
      'unit_other',
    );
  });

  it('should leave the record unstamped when the creator has no unit', () => {
    // Fail-closed: the record stays visible through ownerId only rather than
    // landing in an arbitrary unit.
    const repo = new TestRepository(
      clsWith({ tenantId: 't1', userId: 'u1', userOrgUnitId: null }),
    );
    expect(repo.enrich({})).not.toHaveProperty('orgUnitId');
  });
});
