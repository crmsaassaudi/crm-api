import { MongoSearchEngine } from './mongo-search.engine';
import { EngineSearchRequest } from './search-engine';

/**
 * The defect these tests pin: the engine did not rank.
 *
 * `findAll` sorts by `createdAt` descending. Asking it for five rows and then
 * scoring those five means the answer to "Ahmed" was "the five most recently
 * created contacts that matched" — a contact named exactly Ahmed, created two
 * years ago, was unreachable through the search box no matter how well it
 * matched. Every engine test passed, because each engine was consistent with
 * itself.
 */
const contact = (id: string, firstName: string) => ({
  id,
  firstName,
  lastName: '',
  companyName: '',
});

const request = (
  overrides: Partial<EngineSearchRequest> = {},
): EngineSearchRequest => ({
  capability: 'global_search',
  module: 'contacts',
  query: 'ahmed',
  limit: 5,
  scope: {
    tenantId: 't1',
    userId: 'u1',
    visibleOwnerIds: null,
    visibleOrgUnitIds: null,
    includeUnowned: false,
  },
  ...overrides,
});

/** A repository page of `data`, reporting whether more windows exist. */
const engineOver = (data: any[], hasNextPage = false) => {
  const findAll = jest.fn(() => Promise.resolve({ data, hasNextPage }));
  const engine = new MongoSearchEngine(
    { findAll } as any,
    { findAll } as any,
    { findAll } as any,
    { findAll } as any,
    { findAll } as any,
    {
      findPaginated: jest.fn(() => Promise.resolve({ data, hasNextPage })),
    } as any,
  );
  return { engine, findAll };
};

describe('MongoSearchEngine', () => {
  it('should put the best match first, not the newest', async () => {
    // The repository yields newest-first; the exact match is last.
    const { engine } = engineOver([
      contact('c1', 'Ahmedov'),
      contact('c2', 'Ahmediyya'),
      contact('c3', 'Ahmed'),
    ]);

    const result = await engine.search(request());

    expect(result.data.map((row) => row.id)).toEqual(['c3', 'c1', 'c2']);
  });

  it('should over-fetch so a good match outside the first page can surface', async () => {
    const { engine, findAll } = engineOver([]);

    await engine.search(request({ limit: 5 }));

    // Whatever the caller asked for, the repository is asked for more —
    // otherwise ranking can only reorder rows that were already the newest,
    // which is the bug rather than the fix.
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, page: 1 }),
    );
  });

  it('should page within the candidate window instead of skipping rows', async () => {
    // The naive fix — fetch four times as much, return a quarter — drops three
    // quarters of every window: page 2 would fetch the NEXT window and those
    // rows would never be shown to anyone.
    const window = Array.from({ length: 20 }, (_, index) =>
      contact(`c${String(index).padStart(2, '0')}`, `Ahmed${index}`),
    );
    const { engine } = engineOver(window);

    const first = await engine.search(request({ limit: 5 }));
    const second = await engine.search(
      request({ limit: 5, cursor: first.nextCursor! }),
    );

    expect((engine as any).contacts.findAll).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ page: 1 }),
    );
    // Still window 1 — the second result page is the second slice of it.
    expect((engine as any).contacts.findAll).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ page: 1 }),
    );
    const seen = [...first.data, ...second.data].map((row) => row.id);
    expect(new Set(seen).size).toBe(10);
  });

  it('should move to the next repository window once the current one is exhausted', async () => {
    const window = Array.from({ length: 20 }, (_, index) =>
      contact(`c${index}`, `Ahmed${index}`),
    );
    const { engine } = engineOver(window, true);

    await engine.search(request({ limit: 5, cursor: '5' }));

    expect((engine as any).contacts.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 20 }),
    );
  });

  it('should stop paginating when a page came back empty', async () => {
    const { engine } = engineOver([]);
    const result = await engine.search(request());
    expect(result.nextCursor).toBeNull();
  });

  it('should order ties deterministically', async () => {
    // Two rows scoring identically must not swap between two identical
    // requests, or the second page repeats a row the first already showed.
    const { engine } = engineOver([
      contact('c2', 'Ahmed'),
      contact('c1', 'Ahmed'),
    ]);
    const first = await engine.search(request());
    const second = await engine.search(request());
    expect(first.data.map((row) => row.id)).toEqual(['c1', 'c2']);
    expect(second.data.map((row) => row.id)).toEqual(['c1', 'c2']);
  });
});
