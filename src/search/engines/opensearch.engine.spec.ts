import { AuthorizationFilterException } from './opensearch-filter';
import {
  OpenSearchEngine,
  OpenSearchQueryException,
} from './opensearch.engine';

const buildEngine = () =>
  new OpenSearchEngine({
    getOrThrow: jest.fn(() => ({
      node: 'http://localhost:9200',
      indexPrefix: 'crm',
      requestTimeoutMs: 1000,
    })),
  } as never);

const scope = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  visibleOwnerIds: ['user-1'],
  visibleOrgUnitIds: ['org-1'],
  includeUnowned: false,
};

describe('OpenSearchEngine', () => {
  const engine = buildEngine();

  it('should reject a half-configured basic-auth identity', () => {
    expect(
      () =>
        new OpenSearchEngine({
          getOrThrow: jest.fn(() => ({
            node: 'https://opensearch:9200',
            indexPrefix: 'crm',
            requestTimeoutMs: 1000,
            username: 'api',
          })),
        } as never),
    ).toThrow(/username and password must either both be set/);
  });

  it('should report newest business-record age without calling it replication lag', async () => {
    const local = buildEngine();
    (local as any).client = {
      post: jest.fn().mockResolvedValue({
        data: { aggregations: { latest_update: { value: 1_000_000 } } },
      }),
    };
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_007_900);
    try {
      await expect(local.newestRecordAgeSeconds()).resolves.toBe(7);
    } finally {
      now.mockRestore();
    }
  });

  it('should always build tenant, module, owner, org-unit and ABAC filters server-side', () => {
    const filters = (engine as any).securityFilter({
      module: 'contacts',
      query: 'acme',
      limit: 5,
      scope: { ...scope, abacFilter: { statusId: { $ne: 'private' } } },
    });
    expect(filters).toEqual(
      expect.arrayContaining([
        { term: { tenantId: 'tenant-1' } },
        { term: { module: 'contacts' } },
        {
          bool: {
            should: [
              { terms: { ownerId: ['user-1'] } },
              { terms: { orgUnitId: ['org-1'] } },
            ],
            minimum_should_match: 1,
          },
        },
        {
          bool: {
            must_not: [{ term: { statusId: 'private' } }],
          },
        },
      ]),
    );
  });

  it('should hide archived records the way every MongoDB list does', () => {
    // Safety invariant, not a quality preference: a record the product hid
    // must be hidden by both engines, always. Turning the gateway on used to
    // bring archived accounts back into search.
    const filters = (engine as any).securityFilter({
      module: 'accounts',
      query: 'acme',
      limit: 5,
      scope,
    });
    expect(filters).toContainEqual({
      bool: { must_not: [{ term: { flags: 'archived' } }] },
    });
  });

  it('should refuse to search rather than ignore a deny rule it cannot express', () => {
    expect(() =>
      (engine as any).securityFilter({
        module: 'deals',
        query: 'acme',
        limit: 5,
        scope: { ...scope, abacFilter: { $nor: [{ accountId: 'acc-1' }] } },
      }),
    ).toThrow(AuthorizationFilterException);
  });

  it('should deny all rows when the resolved visibility set is empty', () => {
    const filters = (engine as any).securityFilter({
      module: 'contacts',
      query: 'acme',
      limit: 5,
      scope: {
        ...scope,
        visibleOwnerIds: [],
        visibleOrgUnitIds: [],
        includeUnowned: false,
      },
    });
    expect(filters).toContainEqual({ match_none: {} });
    expect(JSON.stringify(filters)).not.toContain('"terms":{"ownerId":[]}');
  });

  it('should round-trip the PIT and search_after cursor', () => {
    const sort = [1.25, '2026-07-31T00:00:00.000Z', 'record-1'];
    const state = { version: 2, sort };
    const cursor = Buffer.from(JSON.stringify(state)).toString('base64url');
    expect((engine as any).decodeCursor(cursor)).toEqual(state);
  });

  it('should query prefix and phrase clauses so type-ahead works', () => {
    const clauses = (engine as any).matchClauses('ngu');
    expect(clauses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          match: {
            'title.prefix': {
              query: 'ngu',
              boost: 3,
              minimum_should_match: '2<70%',
            },
          },
        }),
        expect.objectContaining({
          match_bool_prefix: {
            searchText: {
              query: 'ngu',
              boost: 1,
              minimum_should_match: '2<70%',
            },
          },
        }),
      ]),
    );
    expect(clauses[0]).toMatchObject({
      multi_match: { minimum_should_match: '2<70%' },
    });
    for (const clause of clauses.filter((entry: any) => !entry.match_phrase)) {
      expect(JSON.stringify(clause)).toContain('minimum_should_match');
    }
  });

  it('should use a bounded exact suffix field for phone-number queries', () => {
    const clauses = (engine as any).matchClauses('+84 912 345-678');
    expect(clauses).toContainEqual({
      term: {
        phoneSuffixes: { value: '84912345678', boost: 4 },
      },
    });
    expect((engine as any).matchClauses('deal 345678')).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ term: expect.anything() }),
      ]),
    );
  });

  it('should map a rejected query and an unreachable cluster to distinct reasons', () => {
    expect(
      (engine as any).toEngineError({ response: { status: 400, data: {} } }),
    ).toMatchObject({ reason: 'rejected_400' });
    expect(
      (engine as any).toEngineError({ response: { status: 503, data: {} } }),
    ).toMatchObject({ reason: 'unavailable_503' });
    expect(
      (engine as any).toEngineError({ code: 'ECONNABORTED' }),
    ).toMatchObject({ reason: 'timeout' });
    expect((engine as any).toEngineError(new Error('boom'))).toBeInstanceOf(
      OpenSearchQueryException,
    );
  });

  it('should emit a bounded score comparable with the MongoDB engine', async () => {
    const engineWithClient = buildEngine();
    const post = jest
      .fn()
      .mockResolvedValueOnce({ data: { pit_id: 'pit-1' } })
      .mockResolvedValueOnce({
        data: {
          pit_id: 'pit-2',
          hits: {
            hits: [
              {
                _score: 42,
                sort: [42, '2026-07-31T00:00:00.000Z', 'c1'],
                _source: {
                  recordId: 'c1',
                  module: 'contacts',
                  title: 'Fuzzy candidate',
                },
              },
              {
                _score: 41,
                sort: [41, '2026-07-30T00:00:00.000Z', 'c2'],
                _source: {
                  recordId: 'c2',
                  module: 'contacts',
                  title: 'Acme',
                },
              },
            ],
          },
        },
      });
    (engineWithClient as any).client = {
      post,
      delete: jest.fn(() => Promise.resolve({})),
    };

    const response = await engineWithClient.search({
      module: 'contacts',
      query: 'acme',
      limit: 5,
      scope: { ...scope, abacFilter: null },
    } as never);

    expect(response.data[0].score).toBeGreaterThan(0);
    expect(response.data[0].score).toBeLessThanOrEqual(1);
    expect(response.data[0].score).toBeGreaterThan(response.data[1].score);
    expect(post).toHaveBeenNthCalledWith(
      1,
      '/crm-global-search/_search/point_in_time',
      undefined,
      { params: { keep_alive: '2m' } },
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      '/_search',
      expect.objectContaining({ pit: { id: 'pit-1', keep_alive: '2m' } }),
    );
    expect(response.snapshotId).toBe('pit-2');
    expect((engineWithClient as any).client.delete).not.toHaveBeenCalled();
  });

  it('should continue the frozen PIT and carry its latest id forward', async () => {
    const engineWithClient = buildEngine();
    const sort = [9, '2026-07-31T00:00:00.000Z', 'c1'];
    const cursor = Buffer.from(JSON.stringify({ version: 2, sort })).toString(
      'base64url',
    );
    const post = jest.fn(() =>
      Promise.resolve({
        data: {
          pit_id: 'pit-2',
          hits: {
            hits: [
              {
                _score: 8,
                sort: [8, '2026-07-30T00:00:00.000Z', 'c2'],
                _source: {
                  recordId: 'c2',
                  module: 'contacts',
                  title: 'Acme Two',
                },
              },
            ],
          },
        },
      }),
    );
    (engineWithClient as any).client = {
      post,
      delete: jest.fn(() => Promise.resolve({})),
    };

    const response = await engineWithClient.search({
      module: 'contacts',
      query: 'acme',
      limit: 1,
      cursor,
      snapshotId: 'pit-1',
      scope: { ...scope, abacFilter: null },
    } as never);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      '/_search',
      expect.objectContaining({
        pit: { id: 'pit-1', keep_alive: '2m' },
        search_after: sort,
      }),
    );
    expect((engineWithClient as any).decodeCursor(response.nextCursor)).toEqual(
      {
        version: 2,
        sort: [8, '2026-07-30T00:00:00.000Z', 'c2'],
      },
    );
    expect(response.snapshotId).toBe('pit-2');
    expect((engineWithClient as any).client.delete).not.toHaveBeenCalled();
  });

  it('should close a shared PIT when the gateway is done with it', async () => {
    const engineWithClient = buildEngine();
    const remove = jest.fn(() => Promise.resolve({}));
    (engineWithClient as any).client = { delete: remove };

    await engineWithClient.closeSnapshot('pit-final');

    expect(remove).toHaveBeenCalledWith('/_search/point_in_time', {
      data: { pit_id: ['pit-final'] },
    });
  });
});
