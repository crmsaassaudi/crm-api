import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuthzPermissionCacheService } from './authz-permission-cache.service';

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

  constructor(private readonly cache: AuthzPermissionCacheService) {}

  @OnEvent('user.permissions.updated')
  @OnEvent('user.tenant-membership.updated')
  async handleUserPermissionEvent(event: UserAuthzEvent): Promise<void> {
    if (!event.tenantId || !event.userId) return;
    await this.cache.invalidateUser(event.tenantId, event.userId);
  }

  @OnEvent('group.updated')
  @OnEvent('group.membership.updated')
  async handleGroupPermissionEvent(event: GroupAuthzEvent): Promise<void> {
    if (!event.tenantId) return;

    if (event.memberIds?.length) {
      await this.cache.invalidateUsers(event.tenantId, event.memberIds);
      return;
    }

    this.logger.warn(
      `Group authz invalidation for tenant=${event.tenantId} had no memberIds; invalidating tenant cache`,
    );
    await this.cache.invalidateTenant(event.tenantId);
  }

  @OnEvent('tenant.permissions.updated')
  async handleTenantPermissionEvent(event: TenantAuthzEvent): Promise<void> {
    if (!event.tenantId) return;
    await this.cache.invalidateTenant(event.tenantId);
  }
}
