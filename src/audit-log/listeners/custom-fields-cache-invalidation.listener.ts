import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CustomFieldsCacheService } from '../services/custom-fields-cache.service';

/**
 * Listens for Custom Field configuration updates and immediately
 * invalidates the cached labels in Redis.
 *
 * Without this listener, stale labels would persist for up to 5 minutes
 * (the cache TTL). With active invalidation, audit logs written after
 * an Admin renames a field will use the new label immediately.
 *
 * Event source: CustomFieldsService.update() or CrmSettingsService
 * should emit 'custom_field.config_updated' with { tenantId, entityType }.
 */
@Injectable()
export class CustomFieldsCacheInvalidationListener {
  constructor(
    private readonly customFieldsCache: CustomFieldsCacheService,
  ) {}

  @OnEvent('custom_field.config_updated', { async: true })
  async handleConfigUpdated(payload: {
    tenantId: string;
    entityType: string;
  }): Promise<void> {
    await this.customFieldsCache.invalidate(
      payload.tenantId,
      payload.entityType,
    );
  }
}
