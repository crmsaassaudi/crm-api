import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { GlobalSearchService } from './global-search.service';

describe('GlobalSearchService', () => {
  const contacts = { findAll: jest.fn() };
  const accounts = { findAll: jest.fn() };
  const deals = { findAll: jest.fn() };
  const tickets = { findAll: jest.fn() };
  const tasks = { findAll: jest.fn() };
  const authorization = { canPerformAction: jest.fn() };
  const context = new Map<string, unknown>([
    ['tenantId', 'tenant-1'],
    ['userId', 'user-1'],
  ]);
  const cls = {
    get: jest.fn((key: string) => context.get(key)),
    set: jest.fn((key: string, value: unknown) => context.set(key, value)),
  };
  const events = { emit: jest.fn() };

  const service = new GlobalSearchService(
    contacts as never,
    accounts as never,
    deals as never,
    tickets as never,
    tasks as never,
    authorization as never,
    cls as unknown as ClsService,
    events as unknown as EventEmitter2,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    context.delete('abacResourceFilter');
  });

  it('should omit denied modules and never query their repositories', async () => {
    authorization.canPerformAction
      .mockResolvedValueOnce({
        allowed: true,
        resourceFilter: { ownerId: 'user-1' },
      })
      .mockResolvedValueOnce({ allowed: false });
    contacts.findAll.mockResolvedValue({
      data: [{ id: 'contact-1', firstName: 'Acme' }],
      hasNextPage: false,
    });

    const response = await service.search({
      query: 'acme',
      modules: ['contacts', 'accounts'],
      limitPerModule: 5,
    });

    expect(contacts.findAll).toHaveBeenCalledWith({
      search: 'acme',
      page: 1,
      limit: 5,
    });
    expect(accounts.findAll).not.toHaveBeenCalled();
    expect(response.meta.allowedModules).toEqual(['contacts']);
    expect(response.meta.deniedModules).toEqual(['accounts']);
    expect(context.get('abacResourceFilter')).toBeUndefined();
  });

  it('should return an opaque cursor and continue each module independently', async () => {
    authorization.canPerformAction.mockResolvedValue({ allowed: true });
    contacts.findAll
      .mockResolvedValueOnce({
        data: [{ id: 'contact-1', firstName: 'Acme' }],
        hasNextPage: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'contact-2', firstName: 'Acme Two' }],
        hasNextPage: false,
      });

    const first = await service.search({
      query: 'acme',
      modules: ['contacts'],
      limitPerModule: 5,
    });
    const second = await service.search({
      query: 'acme',
      modules: ['contacts'],
      limitPerModule: 5,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.nextCursor).toEqual(expect.any(String));
    expect(contacts.findAll).toHaveBeenLastCalledWith({
      search: 'acme',
      page: 2,
      limit: 5,
    });
    expect(second.nextCursor).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'search.executed',
      expect.objectContaining({
        queryHash: expect.any(String),
        queryLength: 4,
        cursorUsed: true,
      }),
    );
  });
});
