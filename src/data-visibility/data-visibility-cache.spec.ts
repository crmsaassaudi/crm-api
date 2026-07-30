import { DataVisibilityInterceptor } from './data-visibility.interceptor';

describe('DataVisibilityInterceptor versioned cache', () => {
  const build = () => {
    const values = new Map<string, unknown>([
      ['tenantId', 't1'],
      ['userId', 'u1'],
      ['visibleOwnerIds', ['u1', 'u2']],
      ['visibleOrgUnitIds', ['ou1']],
      ['includeUnownedInScope', false],
    ]);
    const cls = {
      get: jest.fn((key: string) => values.get(key)),
      set: jest.fn((key: string, value: unknown) => values.set(key, value)),
    };
    const bundles = new Map<string, unknown>();
    const client = {
      get: jest.fn().mockResolvedValue('7'),
      set: jest.fn(),
    };
    const redis = {
      getClient: jest.fn().mockReturnValue(client),
      get: jest.fn((key: string) => Promise.resolve(bundles.get(key))),
      set: jest.fn((key: string, value: unknown) => {
        bundles.set(key, value);
        return Promise.resolve();
      }),
    };
    const interceptor = new DataVisibilityInterceptor(
      cls as any,
      {} as any,
      {} as any,
      {} as any,
      redis as any,
    );
    return { interceptor, values, redis, bundles };
  };

  it('should store and restore the complete scope snapshot under tenant/user/version', async () => {
    const { interceptor, values, redis } = build();
    await (interceptor as any).cacheResolvedVisibility('t1', 'u1');

    expect(redis.set).toHaveBeenCalledWith(
      'authz:scope:t1:u1:v7',
      expect.objectContaining({
        visibleOwnerIds: ['u1', 'u2'],
        visibleOrgUnitIds: ['ou1'],
      }),
      60,
    );

    values.delete('visibleOwnerIds');
    values.delete('visibleOrgUnitIds');
    await expect(
      (interceptor as any).restoreCachedVisibility('t1', 'u1'),
    ).resolves.toBe(true);
    expect(values.get('visibleOwnerIds')).toEqual(['u1', 'u2']);
    expect(values.get('visibleOrgUnitIds')).toEqual(['ou1']);
  });
});
