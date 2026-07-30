import { ContactGrowthRollupReader } from './contact-growth-rollup.reader';

const TENANT = '60d0fe4f5311236168a109ca';

function makeHarness(
  options: {
    latestDay?: string | null;
    rows?: any[];
    cls?: Record<string, unknown>;
  } = {},
) {
  const pipelines: any[][] = [];

  const aggregate = jest.fn((pipeline: any[]) => {
    pipelines.push(pipeline);
    const chain: any = {
      read: () => chain,
      option: () => chain,
      exec: () => Promise.resolve(options.rows ?? []),
    };
    return chain;
  });

  const findOne = jest.fn(() => {
    const chain: any = {
      sort: () => chain,
      lean: () => chain,
      exec: () =>
        Promise.resolve(
          options.latestDay === null || options.latestDay === undefined
            ? null
            : { day: options.latestDay },
        ),
    };
    return chain;
  });

  const clsValues: Record<string, unknown> = {
    visibleOwnerIds: null,
    ...options.cls,
  };

  const reader = new ContactGrowthRollupReader(
    { aggregate, findOne } as any,
    { get: (key: string) => clsValues[key] } as any,
  );

  return { reader, pipelines, aggregate, findOne };
}

const params = (overrides: Record<string, unknown> = {}) =>
  ({
    tenantId: TENANT,
    request: {},
    from: new Date('2026-07-01T00:00:00Z'),
    to: new Date('2026-07-28T23:59:59Z'),
    timezone: 'UTC',
    granularity: 'day' as const,
    ...overrides,
  }) as any;

describe('ContactGrowthRollupReader — when it declines', () => {
  const original = process.env.REPORT_ROLLUP_TIMEZONE;
  afterEach(() => {
    if (original === undefined) delete process.env.REPORT_ROLLUP_TIMEZONE;
    else process.env.REPORT_ROLLUP_TIMEZONE = original;
  });

  it('should decline when the request timezone differs from the rollup timezone', async () => {
    // Day boundaries depend on the zone: a contact created at 23:30 UTC lands on a
    // different day in Asia/Ho_Chi_Minh. Serving it would produce plausible totals
    // attributed to the wrong days.
    const { reader, aggregate } = makeHarness({ latestDay: '2026-07-28' });
    const result = await reader.tryRead(
      params({ timezone: 'Asia/Ho_Chi_Minh' }),
    );
    expect(result).toBeNull();
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('should decline when the rollup has no rows at all', async () => {
    // An un-backfilled deployment must fall back to the live query, not report zeros.
    const { reader, aggregate } = makeHarness({ latestDay: null });
    expect(await reader.tryRead(params())).toBeNull();
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('should decline when the range extends past the last computed day', async () => {
    const { reader } = makeHarness({ latestDay: '2026-07-10' });
    expect(await reader.tryRead(params())).toBeNull();
  });

  it('should decline an unsupported filter', async () => {
    const { reader } = makeHarness({ latestDay: '2026-07-28' });
    expect(
      await reader.tryRead(params({ request: { isVIP: true } })),
    ).toBeNull();
  });

  it('should decline when an ABAC predicate applies', async () => {
    const { reader } = makeHarness({
      latestDay: '2026-07-28',
      cls: { abacResourceFilter: { resource: 'contacts', filter: { x: 1 } } },
    });
    expect(await reader.tryRead(params())).toBeNull();
  });

  it('should decline when the kill switch is set', async () => {
    process.env.REPORT_ROLLUP_ENABLED = 'false';
    try {
      const { reader } = makeHarness({ latestDay: '2026-07-28' });
      expect(await reader.tryRead(params())).toBeNull();
    } finally {
      delete process.env.REPORT_ROLLUP_ENABLED;
    }
  });
});

describe('ContactGrowthRollupReader — when it serves', () => {
  it('should return created and deleted series in the live query shape', async () => {
    const { reader } = makeHarness({
      latestDay: '2026-07-28',
      rows: [
        { _id: '2026-07-01', created: 5, deleted: 1 },
        { _id: '2026-07-02', created: 3, deleted: 0 },
      ],
    });

    const result = await reader.tryRead(params());

    expect(result?.created).toEqual([
      { _id: '2026-07-01', count: 5 },
      { _id: '2026-07-02', count: 3 },
    ]);
    // Zero buckets are dropped: the live path omits empty buckets and the caller
    // fills the gaps, so emitting them here would differ from the shape it replaces.
    expect(result?.deleted).toEqual([{ _id: '2026-07-01', count: 1 }]);
  });

  it('should scope the query to the tenant, timezone and day range', async () => {
    const { reader, pipelines } = makeHarness({ latestDay: '2026-07-28' });
    await reader.tryRead(params());

    const match = pipelines[0][0].$match;
    expect(match.timezone).toBe('UTC');
    expect(match.day).toEqual({ $gte: '2026-07-01', $lte: '2026-07-28' });
    expect(match.tenantId).toBeDefined();
  });

  it('should apply the owner ∪ orgUnit visibility union to the dimensions', async () => {
    // Each contact contributes to exactly one (owner, orgUnit) bucket, so this yields
    // the same answer as the equivalent predicate on the contacts collection.
    const { reader, pipelines } = makeHarness({
      latestDay: '2026-07-28',
      cls: {
        visibleOwnerIds: ['60d0fe4f5311236168a109cb'],
        visibleOrgUnitIds: ['60d0fe4f5311236168a109cc'],
      },
    });
    await reader.tryRead(params());

    const or = pipelines[0][0].$match.$or;
    expect(or).toHaveLength(2);
    expect(or[0].ownerId.$in).toHaveLength(1);
    expect(or[1].orgUnitId.$in).toHaveLength(1);
  });

  it('should include unowned buckets only when the tenant opted in', async () => {
    const { reader, pipelines } = makeHarness({
      latestDay: '2026-07-28',
      cls: {
        visibleOwnerIds: ['60d0fe4f5311236168a109cb'],
        includeUnownedInScope: true,
      },
    });
    await reader.tryRead(params());

    const or = pipelines[0][0].$match.$or;
    expect(or).toEqual(
      expect.arrayContaining([expect.objectContaining({ ownerId: null })]),
    );
  });

  it('should add no visibility predicate for an unrestricted caller', async () => {
    const { reader, pipelines } = makeHarness({ latestDay: '2026-07-28' });
    await reader.tryRead(params());
    expect(pipelines[0][0].$match.$or).toBeUndefined();
  });

  it('should roll days up to months by truncating the day string', async () => {
    // Month boundaries align with day boundaries in the same timezone, which is why
    // the rollup is stored per-day and summed rather than stored per-granularity.
    const { reader, pipelines } = makeHarness({
      latestDay: '2026-07-28',
      rows: [],
    });
    await reader.tryRead(params({ granularity: 'month' }));
    expect(pipelines[0][1].$group._id).toEqual({
      $substrBytes: ['$day', 0, 7],
    });
  });

  it('should group by the raw day at day granularity', async () => {
    const { reader, pipelines } = makeHarness({ latestDay: '2026-07-28' });
    await reader.tryRead(params({ granularity: 'day' }));
    expect(pipelines[0][1].$group._id).toBe('$day');
  });
});
