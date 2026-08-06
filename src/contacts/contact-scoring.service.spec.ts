import { ContactScoringService } from './contact-scoring.service';

/**
 * ONE writer owns `contact.score`: the tenant's Lead Scoring rules.
 *
 * The nightly sweep used to carry a second, hard-coded formula
 * (recency + completeness) inside ContactRepository, applied to every contact in
 * every tenant. So each night at 02:00 the rules a tenant configured were
 * overwritten, and the rule engine only reapplied them the next time that one
 * contact was edited — meaning most contacts carried the hard-coded score
 * permanently, while `score` (a sortable, filterable, reportable field) meant
 * whichever writer ran last.
 */
const contact = (id: string, tenantId: string, score = 0) => ({
  _id: id,
  tenantId,
  score,
});

const build = (
  page: Array<Record<string, any>>,
  rulesByTenant: Record<string, Array<{ condition: any; points: number }>>,
) => {
  const applyScores = jest.fn().mockResolvedValue(0);
  const repository = {
    findPageForScoring: jest
      .fn()
      .mockResolvedValue({ contacts: page, nextCursor: null }),
    applyScores,
  };

  const leadScoring = {
    getActiveRules: jest.fn((tenantId: string) =>
      Promise.resolve(rulesByTenant[tenantId] ?? []),
    ),
    computeScore: jest.fn((rules: Array<{ points: number }>) =>
      rules.reduce((total, rule) => total + rule.points, 0),
    ),
  };

  const service = new ContactScoringService(
    repository as any,
    { acquire: jest.fn() } as any,
    { get: jest.fn(), set: jest.fn() } as any,
    leadScoring as any,
  );

  return { service, repository, leadScoring, applyScores };
};

describe('ContactScoringService — the tenant owns the formula', () => {
  it('should score each tenant with that tenant own rules', async () => {
    const { service, applyScores } = build(
      [contact('c1', 't1'), contact('c2', 't2')],
      {
        t1: [{ condition: {}, points: 10 }],
        t2: [{ condition: {}, points: 40 }],
      },
    );

    await (service as any).scorePage([
      contact('c1', 't1'),
      contact('c2', 't2'),
    ]);

    expect(applyScores).toHaveBeenCalledWith([
      { id: 'c1', tenantId: 't1', score: 10 },
      { id: 'c2', tenantId: 't2', score: 40 },
    ]);
  });

  it('should load a tenant rule set once per page, not once per contact', async () => {
    // A page is 5,000 documents and most tenants own a contiguous run of them.
    const page = Array.from({ length: 50 }, (_, index) =>
      contact(`c${index}`, 't1'),
    );
    const { service, leadScoring } = build(page, {
      t1: [{ condition: {}, points: 5 }],
    });

    await (service as any).scorePage(page);

    expect(leadScoring.getActiveRules).toHaveBeenCalledTimes(1);
  });

  it('should leave a tenant with no rules untouched', async () => {
    // Writing 0 would be the sweep inventing a score for a tenant that has not
    // configured one — the exact behaviour this job was changed to stop.
    const { service, applyScores } = build([contact('c1', 't1', 77)], {});

    await (service as any).scorePage([contact('c1', 't1', 77)]);

    expect(applyScores).toHaveBeenCalledWith([]);
  });

  it('should not rewrite a score that has not changed', async () => {
    const { service, applyScores } = build([contact('c1', 't1', 10)], {
      t1: [{ condition: {}, points: 10 }],
    });

    await (service as any).scorePage([contact('c1', 't1', 10)]);

    expect(applyScores).toHaveBeenCalledWith([]);
  });

  it('should carry the tenant on every write', async () => {
    // `bulkWrite` is not one of the tenant plugin hooked operations, so an
    // id-only filter would be an unguarded cross-tenant write path.
    const { service, applyScores } = build([contact('c1', 't1')], {
      t1: [{ condition: {}, points: 3 }],
    });

    await (service as any).scorePage([contact('c1', 't1')]);

    expect(applyScores.mock.calls[0][0][0]).toEqual(
      expect.objectContaining({ tenantId: 't1' }),
    );
  });
});
