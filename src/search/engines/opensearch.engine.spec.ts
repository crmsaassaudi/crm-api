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

  it('should round-trip the search_after cursor', () => {
    const sort = [1.25, '2026-07-31T00:00:00.000Z', 'record-1'];
    const cursor = Buffer.from(JSON.stringify(sort)).toString('base64url');
    expect((engine as any).decodeCursor(cursor)).toEqual(sort);
  });

  it('should query prefix and phrase clauses so type-ahead works', () => {
    const clauses = (engine as any).matchClauses('ngu');
    expect(clauses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          match: { 'title.prefix': { query: 'ngu', boost: 3 } },
        }),
        expect.objectContaining({
          match_bool_prefix: { searchText: { query: 'ngu', boost: 1 } },
        }),
      ]),
    );
    expect(clauses[0]).toMatchObject({
      multi_match: { minimum_should_match: '2<70%' },
    });
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
    (engineWithClient as any).client = {
      post: jest.fn(() =>
        Promise.resolve({
          data: {
            hits: {
              hits: [
                {
                  _score: 42,
                  sort: [42, '2026-07-31T00:00:00.000Z', 'c1'],
                  _source: {
                    recordId: 'c1',
                    module: 'contacts',
                    title: 'Acme',
                  },
                },
              ],
            },
          },
        }),
      ),
    };

    const response = await engineWithClient.search({
      module: 'contacts',
      query: 'acme',
      limit: 5,
      scope: { ...scope, abacFilter: null },
    } as never);

    expect(response.data[0].score).toBeGreaterThan(0);
    expect(response.data[0].score).toBeLessThanOrEqual(1);
  });
});
