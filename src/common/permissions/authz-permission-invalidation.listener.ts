import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuthzPermissionCacheService } from './authz-permission-cache.service';
import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import { CacheKeyHelper } from '../cache/cache-key.helper';

type UserAuthzEvent = {
  tenantId: string;
  userId: string;
};

type GroupAuthzEvent = {
  tenantId: string;
  groupId?: string;
  memberIds?: string[];
};

type TenantAuthzEvent = {
  tenantId: string;
};

@Injectable()
export class AuthzPermissionInvalidationListener {
  private readonly logger = new Logger(
    AuthzPermissionInvalidationListener.name,
  );

  constructor(
    private readonly cache: AuthzPermissionCacheService,
    private readonly httpCache: CacheInvalidationService,
  ) {}

  @OnEvent('user.permissions.updated')
  @OnEvent('user.tenant-membership.updated')
  async handleUserPermissionEvent(event: UserAuthzEvent): Promise<void> {
    if (!event.tenantId || !event.userId) return;
    await this.cache.invalidateUser(event.tenantId, event.userId);
    await this.purgeUserResponses(event.tenantId, event.userId);
  }

  @OnEvent('group.updated')
  @OnEvent('group.membership.updated')
  async handleGroupPermissionEvent(event: GroupAuthzEvent): Promise<void> {
    if (!event.tenantId) return;

    if (event.memberIds?.length) {
      await this.cache.invalidateUsers(event.tenantId, event.memberIds);
      await Promise.all(
        event.memberIds.map((userId) =>
          this.purgeUserResponses(event.tenantId, userId),
        ),
      );
      return;
    }

    this.logger.warn(
      `Group authz invalidation for tenant=${event.tenantId} had no memberIds; invalidating tenant cache`,
    );
    await this.cache.invalidateTenant(event.tenantId);
    await this.purgeTenantResponses(event.tenantId);
  }

  @OnEvent('tenant.permissions.updated')
  async handleTenantPermissionEvent(event: TenantAuthzEvent): Promise<void> {
    if (!event.tenantId) return;
    await this.cache.invalidateTenant(event.tenantId);
    await this.purgeTenantResponses(event.tenantId);
  }

  /**
   * Purge the principal's cached HTTP responses alongside their permission set.
   *
   * Response bodies are shaped by the permissions in force when they were
   * computed, so dropping only the permission set leaves a revoked user served
   * pre-revocation payloads until the response TTL lapses. Both caches have to
   * be invalidated together for a revocation to take effect immediately.
   */
  private async purgeUserResponses(
    tenantId: string,
    userId: string,
  ): Promise<void> {
    await this.httpCache
      .clearCacheByPattern(CacheKeyHelper.getUserPattern(tenantId, userId))
      .catch((error) =>
        this.logger.warn(
          `Failed to purge HTTP cache for user=${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
  }

  private async purgeTenantResponses(tenantId: string): Promise<void> {
    await this.httpCache
      .clearCacheByPattern(CacheKeyHelper.getTenantPattern(tenantId))
      .catch((error) =>
        this.logger.warn(
          `Failed to purge HTTP cache for tenant=${tenantId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
  }
}
