import { OpenSearchEngine } from './opensearch.engine';

describe('OpenSearchEngine', () => {
  const engine = new OpenSearchEngine({
    getOrThrow: jest.fn(() => ({
      node: 'http://localhost:9200',
      indexPrefix: 'crm',
      requestTimeoutMs: 1000,
    })),
  } as never);

  it('should always build tenant, module, owner, org-unit and ABAC filters server-side', () => {
    const filters = (engine as any).securityFilter({
      module: 'contacts',
      query: 'acme',
      limit: 5,
      scope: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        visibleOwnerIds: ['user-1'],
        visibleOrgUnitIds: ['org-1'],
        includeUnowned: false,
        abacFilter: { statusId: { $ne: 'private' } },
      },
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

  it('should round-trip the search_after cursor', () => {
    const sort = [1.25, '2026-07-31T00:00:00.000Z', 'record-1'];
    const cursor = Buffer.from(JSON.stringify(sort)).toString('base64url');
    expect((engine as any).decodeCursor(cursor)).toEqual(sort);
  });
});
