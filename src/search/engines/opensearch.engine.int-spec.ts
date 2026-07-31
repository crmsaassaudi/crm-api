import axios from 'axios';
import { AuthorizationFilterException } from './opensearch-filter';
import { OpenSearchEngine } from './opensearch.engine';
import { EngineSearchRequest } from './search-engine';

/**
 * Query-side integration test. Runs against the same throwaway cluster as the
 * indexer suite in `crm-opensearch/test/docker-compose.test.yml`, and reuses
 * the index that suite builds so the mapping under test is the real one rather
 * than a copy that can drift.
 *
 *   cd crm-opensearch && npm run test:it:up && npm run test:it
 *   cd crm-api && npm run test:search:it
 */
const NODE = process.env.IT_OPENSEARCH_NODE ?? 'http://127.0.0.1:9251';
const PREFIX = 'it';
const ALIAS = `${PREFIX}-global-search`;
const TENANT = 'tenant-query-it';

jest.setTimeout(120_000);

const os = axios.create({ baseURL: NODE, timeout: 20_000 });

const engine = new OpenSearchEngine({
  getOrThrow: jest.fn(() => ({
    node: NODE,
    indexPrefix: PREFIX,
    requestTimeoutMs: 10_000,
  })),
} as never);

const scope = (overrides: Partial<EngineSearchRequest['scope']> = {}) => ({
  tenantId: TENANT,
  userId: 'user-1',
  visibleOwnerIds: null,
  visibleOrgUnitIds: null,
  includeUnowned: false,
  abacFilter: null,
  ...overrides,
});

const search = (
  query: string,
  overrides: Partial<EngineSearchRequest> = {},
): Promise<{ data: any[]; nextCursor: string | null }> =>
  engine.search({
    module: 'contacts',
    query,
    limit: 10,
    scope: scope(),
    ...overrides,
  } as EngineSearchRequest);

const titles = async (query: string, overrides = {}): Promise<string[]> =>
  (await search(query, overrides)).data.map((hit) => hit.title);

const document = (
  recordId: string,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  tenantId: TENANT,
  module: 'contacts',
  recordId,
  title,
  searchText: title,
  customFields: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const FIXTURES = [
  document('q1', 'Nguyễn Văn An', {
    ownerId: 'user-1',
    orgUnitId: 'org-1',
    statusId: 'active',
    tags: ['vip'],
    searchText: 'Nguyễn Văn An an@example.com APAC',
    customFields: { region: 'APAC' },
  }),
  document('q2', 'Trần Thị Bình', {
    ownerId: 'user-2',
    orgUnitId: 'org-2',
    statusId: 'archived',
    searchText: 'Trần Thị Bình binh@example.com',
  }),
  document('q3', 'Unowned Record', {
    statusId: 'active',
    searchText: 'Unowned Record',
  }),
  document('q4', 'Nguyễn Duy Cường', {
    ownerId: 'user-1',
    statusId: 'active',
    searchText: 'Nguyễn Duy Cường',
  }),
  {
    ...document('q5', 'Other Tenant Secret'),
    tenantId: 'tenant-someone-else',
  },
];

beforeAll(async () => {
  const alias = await os.get(`/_alias/${ALIAS}`).catch(() => null);
  if (!alias) {
    throw new Error(
      `${ALIAS} is missing. Run the crm-opensearch integration suite first: ` +
        'cd crm-opensearch && npm run test:it:up && npm run test:it',
    );
  }

  const body = FIXTURES.flatMap((fixture) => [
    JSON.stringify({
      index: { _index: ALIAS, _id: `contacts:${fixture.recordId}` },
    }),
    JSON.stringify(fixture),
  ]).join('\n');
  await os.post('/_bulk', `${body}\n`, {
    headers: { 'content-type': 'application/x-ndjson' },
  });
  await os.post(`/${ALIAS}/_refresh`);
});

afterAll(async () => {
  await os
    .post(`/${ALIAS}/_delete_by_query?refresh=true`, {
      query: {
        terms: { tenantId: [TENANT, 'tenant-someone-else'] },
      },
    })
    .catch(() => undefined);
});

describe('OpenSearchEngine against a live cluster', () => {
  it('should never return another tenant’s records', async () => {
    const all = await titles('tenant');
    expect(all.join(' ')).not.toContain('Other Tenant Secret');
  });

  it('should match a partial word so the search box works while typing', async () => {
    expect((await titles('ngu')).join(' ')).toContain('Nguyễn');
  });

  it('should fold diacritics both ways', async () => {
    expect((await titles('nguyen')).join(' ')).toContain('Nguyễn');
    expect((await titles('Nguyễn')).join(' ')).toContain('Nguyễn');
  });

  it('should find a record by e-mail and by custom field value', async () => {
    expect(await titles('an@example.com')).toContain('Nguyễn Văn An');
    expect(await titles('APAC')).toContain('Nguyễn Văn An');
  });

  it('should not match every record that shares one term of a phrase', async () => {
    // "Nguyễn Duy Cường" must not surface for a query about a different person
    // just because both share "Nguyễn".
    const results = await titles('Trần Thị Bình');
    expect(results[0]).toBe('Trần Thị Bình');
  });

  it('should apply the owner scope', async () => {
    const results = await titles('e', {
      scope: scope({ visibleOwnerIds: ['user-1'] }),
    });
    expect(results).not.toContain('Trần Thị Bình');
    expect(results).not.toContain('Unowned Record');
  });

  it('should include unowned records only when the tenant opts in', async () => {
    const withoutOptIn = await titles('unowned', {
      scope: scope({ visibleOwnerIds: ['user-1'] }),
    });
    expect(withoutOptIn).not.toContain('Unowned Record');

    const withOptIn = await titles('unowned', {
      scope: scope({ visibleOwnerIds: ['user-1'], includeUnowned: true }),
    });
    expect(withOptIn).toContain('Unowned Record');
  });

  it('should union the org-unit axis with the owner axis', async () => {
    const results = await titles('e', {
      scope: scope({
        visibleOwnerIds: ['user-1'],
        visibleOrgUnitIds: ['org-2'],
      }),
    });
    expect(results).toContain('Trần Thị Bình');
  });

  it('should narrow to the caller when restrict_own_contacts is on', async () => {
    const results = await titles('e', {
      scope: scope({ restrictToOwnerUserId: 'user-2' }),
    });
    expect(results).toEqual(['Trần Thị Bình']);
  });

  it('should enforce an ABAC deny predicate it can express', async () => {
    const results = await titles('e', {
      scope: scope({ abacFilter: { $nor: [{ statusId: 'archived' }] } }),
    });
    expect(results).not.toContain('Trần Thị Bình');
    expect(results.length).toBeGreaterThan(0);
  });

  // The critical finding: `must_not` over a field the index does not store
  // matches every document, so translating it would turn DENY into ALLOW.
  it('should refuse a deny predicate over a field the index does not store', async () => {
    await expect(
      search('e', {
        scope: scope({ abacFilter: { $nor: [{ accountId: 'acc-1' }] } }),
      }),
    ).rejects.toThrow(AuthorizationFilterException);
  });

  it('should keep scores inside the 0..1 range the MongoDB engine uses', async () => {
    const response = await search('Nguyễn');
    expect(response.data.length).toBeGreaterThan(0);
    for (const hit of response.data) {
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });

  it('should paginate with search_after without repeating a record', async () => {
    const first = await search('Nguyễn', { limit: 1 });
    expect(first.data).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await search('Nguyễn', {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.data[0]?.id).not.toBe(first.data[0].id);
  });

  it('should reject a corrupted cursor instead of ignoring it', async () => {
    await expect(search('Nguyễn', { cursor: 'not-a-cursor' })).rejects.toThrow(
      /Invalid or stale search cursor/,
    );
  });

  it('should scope results to the requested module', async () => {
    const response = await search('Nguyễn', { module: 'deals' });
    expect(response.data).toEqual([]);
  });

  it('should report reachability and index freshness', async () => {
    await expect(engine.ping()).resolves.toBeGreaterThanOrEqual(0);
    await expect(engine.freshnessAgeSeconds()).resolves.toEqual(
      expect.any(Number),
    );
  });

  it('should surface an unreachable cluster as a distinguishable reason', async () => {
    const dead = new OpenSearchEngine({
      getOrThrow: jest.fn(() => ({
        node: 'http://127.0.0.1:9', // discard port
        indexPrefix: PREFIX,
        requestTimeoutMs: 1_000,
      })),
    } as never);

    await expect(
      dead.search({
        module: 'contacts',
        query: 'anything',
        limit: 5,
        scope: scope(),
      } as EngineSearchRequest),
    ).rejects.toMatchObject({
      reason: expect.stringMatching(/unreachable|timeout/),
    });
  });
});
