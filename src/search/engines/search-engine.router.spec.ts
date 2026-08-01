import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { SearchEngineRouter } from './search-engine.router';
import {
  AuthorizationFilterException,
  IndexFilterUnsupportedException,
} from './opensearch-filter';

const request = {
  capability: 'global_search' as const,
  module: 'contacts' as const,
  query: 'acme',
  limit: 5,
  scope: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    visibleOwnerIds: null,
    visibleOrgUnitIds: null,
    includeUnowned: false,
  },
};

describe('SearchEngineRouter', () => {
  const mongo = { name: 'mongodb', search: jest.fn() };
  const opensearch = { name: 'opensearch', search: jest.fn() };
  const events = { emit: jest.fn() };
  const metrics = { incrementCounter: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  function router(
    enabled: boolean,
    fallbackToMongoDb = true,
    capabilityOverrides: Record<string, string> = {},
  ) {
    return new SearchEngineRouter(
      {
        getOrThrow: jest.fn(() => ({
          enabled,
          fallbackToMongoDb,
          capabilityOverrides,
        })),
      } as never,
      mongo as never,
      opensearch as never,
      events as never,
      metrics as never,
    );
  }

  it('should use only MongoDB when the flag is disabled', async () => {
    mongo.search.mockResolvedValue({ data: [], nextCursor: null });
    await expect(router(false).search(request)).resolves.toMatchObject({
      actualEngine: 'mongodb',
      fallbackUsed: false,
    });
    expect(opensearch.search).not.toHaveBeenCalled();
  });

  it('should use OpenSearch when the flag is enabled', async () => {
    opensearch.search.mockResolvedValue({ data: [], nextCursor: null });
    await expect(router(true).search(request)).resolves.toMatchObject({
      actualEngine: 'opensearch',
      fallbackUsed: false,
    });
    expect(mongo.search).not.toHaveBeenCalled();
  });

  it('should fall back to MongoDB on an OpenSearch runtime failure', async () => {
    opensearch.search.mockRejectedValue(new Error('connection failed'));
    mongo.search.mockResolvedValue({ data: [], nextCursor: null });
    await expect(router(true).search(request)).resolves.toMatchObject({
      actualEngine: 'mongodb',
      fallbackUsed: true,
    });
  });

  it('should surface the OpenSearch failure when fallback is disabled', async () => {
    opensearch.search.mockRejectedValue(new Error('connection failed'));
    await expect(router(true, false).search(request)).rejects.toThrow(
      'connection failed',
    );
    expect(mongo.search).not.toHaveBeenCalled();
  });

  it('should never fall back for validation failures', async () => {
    opensearch.search.mockRejectedValue(new BadRequestException('cursor'));
    await expect(router(true).search(request)).rejects.toThrow('cursor');
    expect(mongo.search).not.toHaveBeenCalled();
  });

  it('should never fall back for authentication failures', async () => {
    opensearch.search.mockRejectedValue(new UnauthorizedException());
    await expect(router(true).search(request)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(mongo.search).not.toHaveBeenCalled();
  });

  it('should stop calling a dead OpenSearch once the breaker opens', async () => {
    opensearch.search.mockRejectedValue(new Error('connection failed'));
    mongo.search.mockResolvedValue({ data: [], nextCursor: null });
    const instance = router(true);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await instance.search(request);
    }
    expect(opensearch.search).toHaveBeenCalledTimes(5);

    // Sixth request must not spend another timeout on a known-dead engine.
    await expect(instance.search(request)).resolves.toMatchObject({
      actualEngine: 'mongodb',
      fallbackReason: 'circuit_open',
    });
    expect(opensearch.search).toHaveBeenCalledTimes(5);
  });

  it('should not let a refused authorization predicate trip the breaker', async () => {
    opensearch.search.mockRejectedValue(new BadRequestException('cursor'));
    const instance = router(true);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(instance.search(request)).rejects.toThrow('cursor');
    }
    expect(opensearch.search).toHaveBeenCalledTimes(6);
  });

  it('should tag the cursor it returns with the engine that minted it', async () => {
    opensearch.search.mockResolvedValue({ data: [], nextCursor: 'WzEuOF0' });
    await expect(router(true).search(request)).resolves.toMatchObject({
      nextCursor: 'os:WzEuOF0',
      cursorReset: false,
    });
  });

  it('should hand an engine its own cursor back untagged', async () => {
    opensearch.search.mockResolvedValue({ data: [], nextCursor: null });
    await router(true).search({ ...request, cursor: 'os:WzEuOF0' });
    expect(opensearch.search).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'WzEuOF0' }),
    );
  });

  it('should restart a module rather than feed MongoDB an OpenSearch cursor', async () => {
    // The breaker switching engines between two pages used to send a base64
    // `search_after` triple to `Number()`, land on page 1 again, and then hand
    // the resulting "NaN" back to OpenSearch as a 400.
    opensearch.search.mockRejectedValue(new Error('connection failed'));
    mongo.search.mockResolvedValue({ data: [], nextCursor: '2' });

    await expect(
      router(true).search({ ...request, cursor: 'os:WzEuOF0' }),
    ).resolves.toMatchObject({
      actualEngine: 'mongodb',
      cursorReset: true,
      nextCursor: 'mg:2',
    });
    expect(mongo.search).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: undefined }),
    );
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'crm_search_cursor_reset_total',
      { engine: 'mongodb', module: 'contacts' },
    );
  });

  it('should restart a module rather than feed OpenSearch a page number', async () => {
    opensearch.search.mockResolvedValue({ data: [], nextCursor: null });
    await expect(
      router(true).search({ ...request, cursor: 'mg:2' }),
    ).resolves.toMatchObject({ cursorReset: true });
    expect(opensearch.search).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: undefined }),
    );
  });

  it('should treat a cursor from an older build as a restart, not an error', async () => {
    opensearch.search.mockResolvedValue({ data: [], nextCursor: null });
    await expect(
      router(true).search({ ...request, cursor: 'WzEuOF0' }),
    ).resolves.toMatchObject({ cursorReset: true });
  });

  it('should serve a module from MongoDB when the index cannot express its policy', async () => {
    opensearch.search.mockRejectedValue(
      new IndexFilterUnsupportedException('"accountId" is not indexed'),
    );
    mongo.search.mockResolvedValue({ data: [], nextCursor: null });
    const instance = router(true);

    // MongoDB enforces the same predicate over the full document, so this is
    // neither an outage nor a refusal — and it must not open the breaker,
    // because every retry would fail identically.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(instance.search(request)).resolves.toMatchObject({
        actualEngine: 'mongodb',
        fallbackReason: 'filter_unsupported',
      });
    }
    expect(opensearch.search).toHaveBeenCalledTimes(6);
  });

  it('should fail closed on an inexpressible policy when fallback is disabled', async () => {
    opensearch.search.mockRejectedValue(
      new IndexFilterUnsupportedException('"accountId" is not indexed'),
    );
    await expect(router(true, false).search(request)).rejects.toThrow(
      IndexFilterUnsupportedException,
    );
    expect(mongo.search).not.toHaveBeenCalled();
  });

  it('should still refuse a malformed predicate outright', async () => {
    opensearch.search.mockRejectedValue(
      new AuthorizationFilterException('unsafe field path'),
    );
    await expect(router(true).search(request)).rejects.toThrow(
      AuthorizationFilterException,
    );
    expect(mongo.search).not.toHaveBeenCalled();
  });

  it('should carry the engine reason onto the fallback metric', async () => {
    opensearch.search.mockRejectedValue(
      Object.assign(new Error('rejected'), { reason: 'rejected_400' }),
    );
    mongo.search.mockResolvedValue({ data: [], nextCursor: null });

    await expect(router(true).search(request)).resolves.toMatchObject({
      fallbackReason: 'rejected_400',
    });
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'crm_search_engine_errors_total',
      { engine: 'opensearch', reason: 'rejected_400' },
    );
  });

  describe('capability routing', () => {
    it('should mark a runtime diversion as degraded, not merely a fallback', async () => {
      // `fallbackUsed` says an engine changed. `degraded` says the answer is
      // weaker than the capability promised — which is the part a caller has to
      // be told, and the part that used to be computed and discarded.
      opensearch.search.mockRejectedValue(new Error('connection failed'));
      mongo.search.mockResolvedValue({ data: [], nextCursor: null });

      const response = await router(true).search(request);
      expect(response.degraded).toBe(true);
      expect(response.degradedSemantics).toEqual(expect.any(String));
    });

    it('should not call MongoDB at all when a capability is switched off', async () => {
      // The whole point of `off`: an unavailable feature is recoverable, a
      // primary saturated by scans that the feature diverted onto it is not.
      const off = router(true, true, { global_search: 'off' });
      await expect(off.search(request)).rejects.toThrow(/unavailable/);
      expect(mongo.search).not.toHaveBeenCalled();
      expect(opensearch.search).not.toHaveBeenCalled();
    });

    it('should serve a capability forced to MongoDB without touching OpenSearch', async () => {
      mongo.search.mockResolvedValue({ data: [], nextCursor: null });
      const forced = router(true, true, { global_search: 'mongodb' });

      await expect(forced.search(request)).resolves.toMatchObject({
        actualEngine: 'mongodb',
        degraded: false,
      });
      expect(opensearch.search).not.toHaveBeenCalled();
    });

    it('should keep one capability breaker from opening another', async () => {
      // The breaker used to be one counter for the whole process, so a heavy
      // capability timing out took a light, healthy one down with it.
      const instance = router(true);
      opensearch.search.mockRejectedValue(new Error('connection failed'));
      mongo.search.mockResolvedValue({ data: [], nextCursor: null });

      for (let attempt = 0; attempt < 6; attempt += 1) {
        await instance.search({ ...request, capability: 'global_search' });
      }
      const openedForGlobalSearch = opensearch.search.mock.calls.length;
      // Five failures open it; the sixth request must not have reached
      // OpenSearch at all.
      expect(openedForGlobalSearch).toBe(5);

      // A different capability has its own counter and is still tried.
      opensearch.search.mockResolvedValue({ data: [], nextCursor: null });
      await instance.search({ ...request, capability: 'contact_list' });
      // contact_list is tier E, so it never reaches OpenSearch by design —
      // which is itself the guarantee under test.
      expect(opensearch.search.mock.calls.length).toBe(openedForGlobalSearch);
    });
  });
});
