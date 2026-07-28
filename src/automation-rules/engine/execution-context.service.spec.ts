import { ExecutionContextService } from './execution-context.service';
import { systemPrincipal, userPrincipal } from '../domain/execution-principal';

/**
 * `DocumentRepositoryAbstract.applyTenantFilter` treats an absent
 * `visibleOwnerIds` as "no filter", and nothing in a BullMQ consumer used to set
 * it — which is how automation ended up reading and writing every record in the
 * tenant regardless of who built the workflow.
 */
describe('ExecutionContextService', () => {
  const buildCls = () => {
    const store = new Map<string, unknown>();
    return {
      store,
      set: jest.fn((k: string, v: unknown) => store.set(k, v)),
      get: jest.fn((k: string) => store.get(k)),
    };
  };

  it('should scope to a real user and resolve the visibility axes', async () => {
    const cls = buildCls();
    const dataVisibility = {
      resolveVisibility: jest.fn(() => {
        // Stand in for the interceptor's own computation.
        cls.store.set('visibleOwnerIds', ['u1']);
        return Promise.resolve();
      }),
    };
    const service = new ExecutionContextService(
      cls as any,
      dataVisibility as any,
    );

    const result = await service.runAs(
      userPrincipal('u1', 'creator', 'wf1'),
      'wf1',
      () => Promise.resolve('done'),
    );

    expect(result).toBe('done');
    // userId drives BOTH the repository's createdById/updatedById enrichment and
    // the visibility resolution, so the automation is scoped as that user.
    expect(cls.store.get('userId')).toBe('u1');
    expect(dataVisibility.resolveVisibility).toHaveBeenCalled();
    expect(cls.store.get('visibleOwnerIds')).toEqual(['u1']);
  });

  it('should set the axes explicitly to null for the system principal', async () => {
    const cls = buildCls();
    const dataVisibility = { resolveVisibility: jest.fn() };
    const service = new ExecutionContextService(
      cls as any,
      dataVisibility as any,
    );

    await service.runAs(systemPrincipal('wf1'), 'wf1', () =>
      Promise.resolve(null),
    );

    // Same breadth as before, but now a decision recorded in CLS rather than
    // the accidental result of a key nobody set.
    expect(cls.store.get('visibleOwnerIds')).toBeNull();
    expect(cls.store.get('visibleOrgUnitIds')).toBeNull();
    expect(cls.store.get('userId')).toBeUndefined();
    expect(dataVisibility.resolveVisibility).not.toHaveBeenCalled();
  });

  it('should attribute the write to the automation and its principal', async () => {
    const cls = buildCls();
    const service = new ExecutionContextService(
      cls as any,
      { resolveVisibility: jest.fn() } as any,
    );

    await service.runAs(userPrincipal('u7', 'trigger_user', 'wf9'), 'wf9', () =>
      Promise.resolve(null),
    );

    expect(cls.store.get('executionSource')).toBe('A_F');
    expect(cls.store.get('sourceContext')).toEqual({
      flowId: 'wf9',
      runAs: 'trigger_user',
      principalId: 'u7',
    });
    expect(cls.store.get('principalType')).toBe('user');
  });

  it('should treat a missing principal as system rather than as unscoped', async () => {
    const cls = buildCls();
    const service = new ExecutionContextService(
      cls as any,
      { resolveVisibility: jest.fn() } as any,
    );

    // Jobs enqueued before the principal existed must still behave predictably.
    await service.runAs(undefined, 'wf1', () => Promise.resolve(null));

    expect(cls.store.get('principalType')).toBe('system');
    expect(cls.store.get('visibleOwnerIds')).toBeNull();
  });
});
