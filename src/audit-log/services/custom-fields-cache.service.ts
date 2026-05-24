import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/**
 * Caches Custom Field labels (field_key → display_label) per tenant + entityType.
 *
 * [PATCH R2] This service is injected by AuditLogListener — CRM Services
 * do NOT need to know about labels. Separation of concerns: audit layer
 * resolves its own label dependencies.
 *
 * Cache strategy:
 * - Redis TTL: 5 minutes (300s) — balances freshness vs DB load
 * - Fail-open: if cache/DB errors, returns {} — audit log still records
 *   the change, just without human-readable label (l field)
 * - Active invalidation via CustomFieldsCacheInvalidationListener when
 *   Admin updates Custom Field config
 */
@Injectable()
export class CustomFieldsCacheService {
  private readonly logger = new Logger(CustomFieldsCacheService.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Returns map { field_key → display_label } for a tenant + entityType.
   * Cache hit: returns cached map (Redis TTL 300s).
   * Cache miss: TODO Phase 1 — query CustomFieldsRepository, cache, return.
   * Error: returns {} — fail-open, non-blocking.
   */
  async getLabelsForTenant(
    tenantId: string,
    entityType: string,
  ): Promise<Record<string, string>> {
    const cacheKey = `cf:labels:${tenantId}:${entityType}`;
    try {
      const cached =
        await this.redisService.get<Record<string, string>>(cacheKey);
      if (cached) return cached;

      // TODO Phase 1: Read from CrmSettingsService / CustomFieldsRepository
      // and cache with TTL 300s. For now, return empty map.
      // When implemented:
      //   const labels = await this.customFieldsRepo.getLabelsMap(tenantId, entityType);
      //   await this.redisService.set(cacheKey, labels, 300);
      //   return labels;
      return {};
    } catch (error) {
      this.logger.debug(
        `[CustomFieldsCache] Failed to get labels for ${tenantId}/${entityType}: ${(error as Error).message}`,
      );
      return {};
    }
  }

  /**
   * Invalidates cached labels when Admin updates Custom Field configuration.
   * Called by CustomFieldsCacheInvalidationListener on 'custom_field.config_updated'.
   * Ensures real-time consistency: audit logs after invalidation use fresh labels.
   */
  async invalidate(tenantId: string, entityType: string): Promise<void> {
    const cacheKey = `cf:labels:${tenantId}:${entityType}`;
    await this.redisService.del(cacheKey).catch(() => {
      /* non-fatal */
    });
  }
}
