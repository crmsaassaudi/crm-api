import { CacheInterceptor } from '@nestjs/cache-manager';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import { CACHE_ENTITY_KEY } from '../decorators/cache-entity.decorator';

@Injectable()
export class HttpCacheInterceptor extends CacheInterceptor {
  protected readonly reflector: Reflector;

  constructor(cacheManager: any, reflector: Reflector) {
    super(cacheManager, reflector);
    this.reflector = reflector;
  }

  trackBy(context: ExecutionContext): string | undefined {
    const entityName =
      this.reflector.get<string>(CACHE_ENTITY_KEY, context.getHandler()) ||
      this.reflector.get<string>(CACHE_ENTITY_KEY, context.getClass());

    if (!entityName) {
      return super.trackBy(context);
    }

    const request = context.switchToHttp().getRequest();

    // CORRECTNESS: only GET may be served from cache.
    //
    // The base class enforces that inside its OWN trackBy (`isRequestCacheable`),
    // and `intercept()` caches whenever trackBy returns a key — so an override
    // that forgets the check silently makes every method cacheable. It did:
    // `POST /users/:id/effective-permissions/preview` had its answer stored and
    // replayed, so the second preview in a dialog — the one with the role
    // actually ticked — was served the first preview's "no roles" result, and
    // the admin was told the member would get 0 permissions.
    if (!this.allowedMethods.includes(request.method)) {
      return undefined;
    }

    // SECURITY (C-03): the cache key MUST include the principal.
    //
    // Response payloads are shaped per-user by data visibility
    // (`visibleOwnerIds`) and by field masking. A key scoped only to the tenant
    // serves an admin's full result set to a scoped agent who requests the same
    // URL within the TTL — a horizontal privilege escalation through the cache.
    //
    // Missing tenant or user context means the response cannot be safely
    // attributed to anyone, so it is NOT cached at all (returning undefined
    // bypasses the cache). Previously this fell back to the literal 'global',
    // which merged unrelated tenants into one cache entry.
    let tenantId: string | undefined;
    let userId: string | undefined;
    try {
      const cls = ClsServiceManager.getClsService();
      tenantId = cls.get('activeTenantId') || cls.get('tenantId');
      userId = cls.get('userId');
    } catch {
      return undefined;
    }

    if (!tenantId || !userId) {
      return undefined;
    }

    const id = request.params?.id;
    const scope = `tenant:${tenantId}:user:${userId}:${entityName}`;

    // The URL is ALWAYS part of the key, id or not.
    //
    // Keying a detail response on `:id` alone collapsed every route under
    // `/users/:id/**` into one entry — `GET /users/:id` and
    // `GET /users/:id/effective-permissions` share the param, so whichever ran
    // first won and the other was served its body for the rest of the TTL.
    // The id stays in front of the URL so the invalidation wildcards
    // (`…:User:*`) keep matching.
    return `${scope}:${id ?? '-'}:${request.url}`;
  }
}
