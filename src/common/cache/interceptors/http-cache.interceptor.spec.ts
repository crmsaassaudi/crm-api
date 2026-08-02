import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { HttpCacheInterceptor } from './http-cache.interceptor';
import { CACHE_ENTITY_KEY } from '../decorators/cache-entity.decorator';

/**
 * The cache key IS the correctness boundary of this interceptor: whatever two
 * requests map to the same key are, from the cache's point of view, the same
 * question. Both bugs fixed here were key bugs that shipped as wrong answers in
 * the product — an admin was shown "this member gets 0 permissions" for a
 * member who had a role, because the second preview in the dialog was served
 * the first one's response.
 */

const cls = {
  tenantId: 'T1' as string | undefined,
  userId: 'U1' as string | undefined,
};

jest.mock('nestjs-cls', () => ({
  ClsServiceManager: {
    getClsService: () => ({
      get: (key: string) =>
        key === 'userId'
          ? cls.userId
          : key === 'tenantId'
            ? cls.tenantId
            : undefined,
    }),
  },
}));

const contextFor = (request: {
  method: string;
  url: string;
  params?: Record<string, string>;
}): ExecutionContext =>
  ({
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

describe('HttpCacheInterceptor.trackBy', () => {
  let interceptor: HttpCacheInterceptor;

  beforeEach(() => {
    cls.tenantId = 'T1';
    cls.userId = 'U1';
    const reflector = {
      get: (key: string) => (key === CACHE_ENTITY_KEY ? 'User' : undefined),
    } as unknown as Reflector;
    interceptor = new HttpCacheInterceptor({} as any, reflector);
  });

  const track = (request: Parameters<typeof contextFor>[0]) =>
    (
      interceptor as unknown as {
        trackBy: (c: ExecutionContext) => string | undefined;
      }
    ).trackBy(contextFor(request));

  it('should never cache a method other than GET', () => {
    // `intercept()` caches whenever trackBy returns a key, and the base class's
    // method check lives in the trackBy this class overrides. Without this, a
    // POST body is cached and replayed for a DIFFERENT body.
    expect(
      track({
        method: 'POST',
        url: '/api/v1/users/U9/effective-permissions/preview',
        params: { id: 'U9' },
      }),
    ).toBeUndefined();
    expect(
      track({ method: 'PATCH', url: '/api/v1/users/U9', params: { id: 'U9' } }),
    ).toBeUndefined();
    expect(
      track({
        method: 'DELETE',
        url: '/api/v1/users/U9',
        params: { id: 'U9' },
      }),
    ).toBeUndefined();
  });

  it('should give two routes of the same record two different keys', () => {
    const detail = track({
      method: 'GET',
      url: '/api/v1/users/U9',
      params: { id: 'U9' },
    });
    const effective = track({
      method: 'GET',
      url: '/api/v1/users/U9/effective-permissions',
      params: { id: 'U9' },
    });

    expect(detail).toBeDefined();
    expect(detail).not.toEqual(effective);
  });

  it('should keep the id ahead of the URL so invalidation wildcards still match', () => {
    const key = track({
      method: 'GET',
      url: '/api/v1/users/U9',
      params: { id: 'U9' },
    });

    expect(key).toMatch(/^tenant:T1:user:U1:User:U9:/);
  });

  it('should separate two users, two tenants and two query strings', () => {
    const first = track({ method: 'GET', url: '/api/v1/users?page=1' });
    const second = track({ method: 'GET', url: '/api/v1/users?page=2' });
    expect(first).not.toEqual(second);

    cls.userId = 'U2';
    expect(track({ method: 'GET', url: '/api/v1/users?page=1' })).not.toEqual(
      first,
    );
  });

  it('should refuse to cache when the principal is unknown, rather than sharing an entry', () => {
    cls.userId = undefined;
    expect(
      track({ method: 'GET', url: '/api/v1/users/U9', params: { id: 'U9' } }),
    ).toBeUndefined();

    cls.userId = 'U1';
    cls.tenantId = undefined;
    expect(
      track({ method: 'GET', url: '/api/v1/users/U9', params: { id: 'U9' } }),
    ).toBeUndefined();
  });
});
