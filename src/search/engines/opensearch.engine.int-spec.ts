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
): Promise<{
  data: any[];
  nextCursor: string | null;
  snapshotId?: string;
}> => searchAndCloseTerminal(query, overrides);

const searchAndCloseTerminal = async (
  query: string,
  overrides: Partial<EngineSearchRequest>,
) => {
  const response = await engine.search({
    module: 'contacts',
    query,
    limit: 10,
    scope: scope(),
    ...overrides,
  } as EngineSearchRequest);
  if (!response.nextCursor && response.snapshotId) {
    await engine.closeSnapshot(response.snapshotId);
  }
  return response;
};

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
  // Required by the strict mapping. Query-side fixtures do not exercise
  // reconciliation, so a deterministic sentinel fingerprint is sufficient.
  contentHash: '0'.repeat(64),
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
    // Custom-field values reach the index folded into `searchText` and are no
    // longer stored as an object — so `APAC` here is exactly what the mapper
    // produces, not a convenience of the fixture.
    searchText: 'Nguyễn Văn An an@example.com APAC',
    phoneSuffixes: ['5678', '345678', '912345678', '84912345678'],
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
  document('q6', 'Nguyen Van An Holdings', {
    ownerId: 'user-3',
    statusId: 'active',
    searchText: 'Nguyen Van An Holdings investment company',
  }),
  {
    ...document('q5', 'Other Tenant Secret'),
    tenantId: 'tenant-someone-else',
  },
  // Hidden-state fixtures. These exist to prove the safety invariants against
  // the real mapping rather than against a mock that cannot disagree with it.
  document('q7', 'Archived Holdings', {
    ownerId: 'user-1',
    statusId: 'active',
    searchText: 'Archived Holdings company',
    flags: ['archived'],
  }),
  document('q8', 'Empty Owner Record', {
    // MongoDB treats "" as present, so a scoped user does not see this row.
    // Indexing it as a present-but-empty keyword is what makes OpenSearch agree.
    ownerId: '',
    statusId: 'active',
    searchText: 'Empty Owner Record',
  }),
];

const reciprocalRank = (
  resultIds: string[],
  judgments: Readonly<Record<string, number>>,
): number => {
  const rank = resultIds.findIndex((id) => (judgments[id] ?? 0) > 0);
  return rank < 0 ? 0 : 1 / (rank + 1);
};

const ndcgAt = (
  resultIds: string[],
  judgments: Readonly<Record<string, number>>,
  k: number,
): number => {
  const dcg = (grades: number[]) =>
    grades.reduce(
      (sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2),
      0,
    );
  const actual = resultIds.slice(0, k).map((id) => judgments[id] ?? 0);
  const ideal = Object.values(judgments)
    .sort((left, right) => right - left)
    .slice(0, k);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 1 : dcg(actual) / idealDcg;
};

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

  it('should hide archived records the way every MongoDB list does', async () => {
    // Safety invariant against the real mapping. A record the product hid must
    // stay hidden on both engines: turning the gateway on used to bring
    // archived accounts back into search, which reads to a user as the product
    // ignoring something they deliberately put away.
    const found = await titles('Holdings');
    expect(found.join(' ')).toContain('Nguyen Van An Holdings');
    expect(found.join(' ')).not.toContain('Archived Holdings');
  });

  it('should treat an empty ownerId as owned, exactly as MongoDB does', async () => {
    // "" matches neither `{ownerId: null}` nor an `$in` list in MongoDB, so a
    // scoped user does not see the row. Dropping the field at index time made
    // it look unowned here, `must_not exists` matched, and OpenSearch revealed
    // a record MongoDB hides.
    const asScopedUser = await titles('Empty Owner Record', {
      scope: scope({
        visibleOwnerIds: ['user-1'],
        visibleOrgUnitIds: [],
        includeUnowned: true,
      }),
    });
    expect(asScopedUser.join(' ')).not.toContain('Empty Owner Record');
  });

  it('should return nothing at all when the resolved scope is empty', async () => {
    // An empty visibility set must compile to `match_none`, never to an empty
    // bool filter — which matches everything and would turn "sees nobody" into
    // "sees everyone".
    const nothing = await titles('Nguyễn', {
      scope: scope({
        visibleOwnerIds: [],
        visibleOrgUnitIds: [],
        includeUnowned: false,
      }),
    });
    expect(nothing).toEqual([]);
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

  it('should find a contact by the remembered phone suffix when the caller may unmask', async () => {
    expect(
      await titles('345678', { scope: scope({ canSearchSensitive: true }) }),
    ).toContain('Nguyễn Văn An');
  });

  it('should refuse caller-ID lookup to a caller who may not unmask', async () => {
    // Field masking hides a contact's phone number from a user without
    // `contacts:unmask`; searching for that number and being handed the name
    // reaches the same data through a different door. MongoDB gates this by
    // keeping the tokens in `searchKeysPii`, and the two engines have to agree
    // — a control that holds on one and not the other is worse than none,
    // because nobody thinks to check the other.
    expect(await titles('345678')).not.toContain('Nguyễn Văn An');
  });

  it('should not match every record that shares one term of a phrase', async () => {
    // A prefix boost used to bypass minimum_should_match, admitting a record
    // that shared only "Nguyễn". Correct ranking is not enough: the irrelevant
    // row must not leak into a later page either.
    const results = await titles('Nguyễn Văn An');
    expect(results[0]).toBe('Nguyễn Văn An');
    expect(results).not.toContain('Nguyễn Duy Cường');
  });

  it('should meet the graded relevance floor for an exact person query', async () => {
    // Explicit judgments: exact contact > longer organization-like title;
    // the other same-first-name contact is irrelevant to the full query.
    const judgments = { q1: 3, q6: 2, q4: 0 } as const;
    const ids = (await search('nguyen van an')).data.map((hit) => hit.id);

    expect(reciprocalRank(ids, judgments)).toBe(1);
    expect(ndcgAt(ids, judgments, 3)).toBeGreaterThanOrEqual(0.95);
    expect(ids).not.toContain('q4');
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

  it('should paginate a frozen PIT without repeats or late inserts', async () => {
    const first = await search('Nguyễn', { limit: 1 });
    expect(first.data).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));

    const late = document('q-late', 'Nguyễn Inserted After Page One');
    await os.post(
      '/_bulk',
      `${JSON.stringify({ index: { _index: ALIAS, _id: 'contacts:q-late' } })}\n${JSON.stringify(late)}\n`,
      { headers: { 'content-type': 'application/x-ndjson' } },
    );
    await os.post(`/${ALIAS}/_refresh`);

    const second = await search('Nguyễn', {
      limit: 1,
      cursor: first.nextCursor!,
      snapshotId: first.snapshotId,
    });
    expect(second.data[0]?.id).not.toBe(first.data[0].id);
    const seen = [...first.data, ...second.data];
    let cursor = second.nextCursor;
    let snapshotId = second.snapshotId;
    while (cursor) {
      const page = await search('Nguyễn', {
        limit: 1,
        cursor,
        snapshotId,
      });
      seen.push(...page.data);
      cursor = page.nextCursor;
      snapshotId = page.snapshotId;
    }
    expect(seen.map((hit) => hit.id)).not.toContain('q-late');
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
    await expect(engine.newestRecordAgeSeconds()).resolves.toEqual(
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
