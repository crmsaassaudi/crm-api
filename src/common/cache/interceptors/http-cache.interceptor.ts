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
    // Check if caching is disabled or skipped (optional custom logic)

    const entityName =
      this.reflector.get<string>(CACHE_ENTITY_KEY, context.getHandler()) ||
      this.reflector.get<string>(CACHE_ENTITY_KEY, context.getClass());

    if (entityName) {
      const request = context.switchToHttp().getRequest();
      const id = request.params.id;

      let tenantId = 'global';
      try {
        const cls = ClsServiceManager.getClsService();
        tenantId = cls.get('activeTenantId') || cls.get('tenantId') || 'global';
      } catch { }

      if (id) {
        return `tenant:${tenantId}:${entityName}:${id}`;
      }

      // For list/queries, using the URL allows unique caching for different filters/pages
      return `tenant:${tenantId}:${entityName}:${request.url}`;
    }

    return super.trackBy(context);
  }
}
