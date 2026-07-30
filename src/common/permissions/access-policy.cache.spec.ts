import { ServiceUnavailableException } from '@nestjs/common';
import { AccessPolicyService } from './access-policy.service';

describe('AccessPolicyService policy bundle cache', () => {
  const policy = {
    resource: 'contacts',
    action: 'view',
    effect: 'deny',
    conditions: [],
    priority: 100,
  };

  const build = ({
    policies = [policy],
    version = '1',
  }: {
    policies?: any[];
    version?: string;
  } = {}) => {
    const exec = jest.fn().mockResolvedValue(policies);
    const model = {
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({ exec }),
        }),
      }),
      create: jest.fn(),
    };
    const cache = new Map<string, unknown>();
    let currentVersion = version;
    const client = {
      get: jest.fn().mockImplementation(() => Promise.resolve(currentVersion)),
      set: jest.fn().mockImplementation((_key, value) => {
        if (currentVersion === null) currentVersion = value;
        return Promise.resolve('OK');
      }),
      incr: jest.fn().mockImplementation(() => {
        currentVersion = String(Number(currentVersion ?? 0) + 1);
        return Promise.resolve(Number(currentVersion));
      }),
    };
    const redis = {
      getClient: jest.fn().mockReturnValue(client),
      get: jest
        .fn()
        .mockImplementation((key) => Promise.resolve(cache.get(key))),
      set: jest.fn().mockImplementation((key, value) => {
        cache.set(key, value);
        return Promise.resolve();
      }),
    };
    return {
      service: new AccessPolicyService(
        model as any,
        { record: jest.fn() } as any,
        redis as any,
      ),
      model,
      redis,
      client,
      exec,
    };
  };

  it('should reuse one tenant bundle for repeated decisions', async () => {
    const { service, model, redis } = build();
    const context = { subject: { id: 'u1' } };

    await expect(
      service.evaluate('t1', 'contacts', 'view', context),
    ).resolves.toBe('deny');
    await expect(
      service.evaluateActionContext('t1', 'contacts', 'view', context),
    ).resolves.toBe('deny');

    expect(model.find).toHaveBeenCalledTimes(1);
    expect(model.find).toHaveBeenCalledWith({ tenantId: 't1', active: true });
    expect(redis.set).toHaveBeenCalledWith(
      'authz:policy:t1:v1:active',
      expect.any(Array),
      60,
    );
  });

  it('should increment the tenant version after a policy mutation', async () => {
    const { service, client } = build();

    await (service as any).invalidatePolicyBundle('t1');

    expect(client.incr).toHaveBeenCalledWith('authz:policy:t1:version');
  });

  it('should fall back to Mongo when Redis is unavailable', async () => {
    const { service, client, model } = build();
    client.get.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      service.evaluate('t1', 'contacts', 'view', {
        subject: { id: 'u1' },
      }),
    ).resolves.toBe('deny');
    expect(model.find).toHaveBeenCalledTimes(1);
  });

  it('should surface invalidation failure instead of silently accepting stale grants', async () => {
    const { service, client } = build();
    client.incr.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      (service as any).invalidatePolicyBundle('t1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
