import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { SearchEngineRouter } from './search-engine.router';

const request = {
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

  function router(enabled: boolean, fallbackToMongoDb = true) {
    return new SearchEngineRouter(
      {
        getOrThrow: jest.fn(() => ({ enabled, fallbackToMongoDb })),
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
});
