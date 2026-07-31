import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { SearchEngineRouter } from './engines/search-engine.router';
import { GlobalSearchService } from './global-search.service';

describe('GlobalSearchService', () => {
  const authorization = { canPerformAction: jest.fn() };
  const router = { search: jest.fn() };
  const context = new Map<string, unknown>([
    ['tenantId', 'tenant-1'],
    ['userId', 'user-1'],
    ['visibleOwnerIds', ['user-1']],
  ]);
  const cls = {
    get: jest.fn((key: string) => context.get(key)),
    set: jest.fn((key: string, value: unknown) => context.set(key, value)),
  };
  const events = { emit: jest.fn() };
  const metrics = { incrementCounter: jest.fn() };
  const settings = { getSetting: jest.fn(() => Promise.resolve({})) };
  const service = new GlobalSearchService(
    authorization as never,
    cls as unknown as ClsService,
    events as unknown as EventEmitter2,
    router as unknown as SearchEngineRouter,
    metrics as never,
    settings as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    context.delete('abacResourceFilter');
  });

  it('should omit denied modules and never query their engine', async () => {
    authorization.canPerformAction
      .mockResolvedValueOnce({
        allowed: true,
        resourceFilter: { ownerId: 'user-1' },
      })
      .mockResolvedValueOnce({ allowed: false });
    router.search.mockResolvedValue({
      data: [],
      nextCursor: null,
      requestedEngine: 'opensearch',
      actualEngine: 'opensearch',
      fallbackUsed: false,
    });

    const response = await service.search({
      query: 'acme',
      modules: ['contacts', 'accounts'],
      limitPerModule: 5,
    });

    expect(router.search).toHaveBeenCalledTimes(1);
    expect(router.search).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'contacts',
        scope: expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-1',
          visibleOwnerIds: ['user-1'],
          abacFilter: { ownerId: 'user-1' },
        }),
      }),
    );
    expect(response.meta.allowedModules).toEqual(['contacts']);
    expect(response.meta.deniedModules).toEqual(['accounts']);
    expect(context.get('abacResourceFilter')).toBeUndefined();
  });

  it('should return an opaque cursor and map telemetry without raw query', async () => {
    authorization.canPerformAction.mockResolvedValue({ allowed: true });
    router.search
      .mockResolvedValueOnce({
        data: [],
        nextCursor: 'engine-cursor',
        requestedEngine: 'opensearch',
        actualEngine: 'mongodb',
        fallbackUsed: true,
        fallbackReason: 'ServiceUnavailableException',
      })
      .mockResolvedValueOnce({
        data: [],
        nextCursor: null,
        requestedEngine: 'opensearch',
        actualEngine: 'opensearch',
        fallbackUsed: false,
      });

    const first = await service.search({
      query: 'secret@example.com',
      modules: ['contacts'],
      limitPerModule: 5,
    });
    await service.search({
      query: 'secret@example.com',
      modules: ['contacts'],
      limitPerModule: 5,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.nextCursor).toEqual(expect.any(String));
    expect(router.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'engine-cursor' }),
    );
    const telemetry = events.emit.mock.calls.at(-1)?.[1];
    expect(telemetry).toEqual(
      expect.objectContaining({
        queryHash: expect.any(String),
        queryLength: 18,
        cursorUsed: true,
      }),
    );
    expect(JSON.stringify(telemetry)).not.toContain('secret@example.com');
  });

  it('should carry restrict_own_contacts into the engine scope', async () => {
    authorization.canPerformAction.mockResolvedValue({ allowed: true });
    settings.getSetting.mockResolvedValueOnce({ restrict_own_contacts: true });
    router.search.mockResolvedValue({
      data: [],
      nextCursor: null,
      requestedEngine: 'opensearch',
      actualEngine: 'opensearch',
      fallbackUsed: false,
    });

    await service.search({
      query: 'acme',
      modules: ['contacts', 'deals'],
      limitPerModule: 5,
    });

    expect(router.search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        module: 'contacts',
        scope: expect.objectContaining({ restrictToOwnerUserId: 'user-1' }),
      }),
    );
    // The flag is contact-specific; it must not silently narrow other modules.
    expect(router.search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        module: 'deals',
        scope: expect.objectContaining({ restrictToOwnerUserId: null }),
      }),
    );
  });

  it('should fail closed when the data access policy cannot be read', async () => {
    authorization.canPerformAction.mockResolvedValue({ allowed: true });
    settings.getSetting.mockRejectedValueOnce(new Error('settings down'));
    router.search.mockResolvedValue({
      data: [],
      nextCursor: null,
      requestedEngine: 'opensearch',
      actualEngine: 'opensearch',
      fallbackUsed: false,
    });

    await service.search({
      query: 'acme',
      modules: ['contacts'],
      limitPerModule: 5,
    });

    expect(router.search).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ restrictToOwnerUserId: 'user-1' }),
      }),
    );
  });
});
