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

    const request = context.switchToHttp().getRequest();
    const id = request.params?.id;
    const scope = `tenant:${tenantId}:user:${userId}:${entityName}`;

    // For list/queries the URL carries the filters/pagination that shape the
    // response, so it belongs in the key.
    return id ? `${scope}:${id}` : `${scope}:${request.url}`;
  }
}
