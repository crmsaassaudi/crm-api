import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CacheInvalidationService } from '../cache-invalidation.service';
import { CacheKeyHelper } from '../cache-key.helper';

@Injectable()
export class CacheInvalidationListener {
  private readonly logger = new Logger(CacheInvalidationListener.name);

  constructor(
    private readonly cacheInvalidationService: CacheInvalidationService,
  ) { }

  @OnEvent('entity.created')
  async handleEntityCreated(payload: { entity: string; id: string; tenantId?: string }) {
    await this.invalidateEntityCache(payload.tenantId || 'global', payload.entity);
  }

  @OnEvent('entity.updated')
  async handleEntityUpdated(payload: { entity: string; id: string; tenantId?: string }) {
    await this.invalidateEntityCache(payload.tenantId || 'global', payload.entity);
  }

  @OnEvent('entity.deleted')
  async handleEntityDeleted(payload: { entity: string; id: string; tenantId?: string }) {
    await this.invalidateEntityCache(payload.tenantId || 'global', payload.entity);
  }

  private async invalidateEntityCache(tenantId: string, entityName: string) {
    const pattern = CacheKeyHelper.getPattern(tenantId, entityName);
    this.logger.log(`Invalidating cache for pattern: ${pattern}`);
    await this.cacheInvalidationService.clearCacheByPattern(pattern);
  }
}
