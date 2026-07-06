import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { RedisService } from '../../redis/redis.service';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import { GroupRepository } from '../../groups/infrastructure/persistence/document/repositories/group.repository';
import { TenantsRepository } from '../../tenants/infrastructure/persistence/document/repositories/tenant.repository';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import {
  calculateEffectivePermissions,
  canAccess,
  PermissionTenant,
} from './permission.engine';
import { PermissionRuleMetadata } from './permission.decorator';
import { getPermissionKey } from './permission.constants';

const DEFAULT_CACHE_TTL_SECONDS = 5 * 60;
const EMPTY_SENTINEL = '__empty__';
const ALL_SENTINEL = '__all__';

export interface AuthzPermissionCheckResult {
  allowed: boolean;
  userId?: string;
  tenantId?: string;
  email?: string | null;
  cacheHit: boolean;
  requiredPermission?: string;
  denyReason?: string;
}

@Injectable()
export class AuthzPermissionCacheService {
  private readonly logger = new Logger(AuthzPermissionCacheService.name);
  private readonly ttlSeconds = this.readPositiveNumberEnv(
    'AUTHZ_PERMISSION_CACHE_TTL_SECONDS',
    DEFAULT_CACHE_TTL_SECONDS,
  );

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly redisService: RedisService,
    private readonly cls: ClsService,
  ) {}

  async canAccess(params: {
    rawUserId: string;
    tenantHint?: string;
    rule: PermissionRuleMetadata;
  }): Promise<AuthzPermissionCheckResult> {
    const permissionKey = getPermissionKey(
      params.rule.action,
      params.rule.resource,
    );

    if (!permissionKey) {
      this.logger.warn(
        `Permission denied: unknown permission action=${params.rule.action} resource=${params.rule.resource}`,
      );
      return {
        allowed: false,
        cacheHit: false,
        denyReason: 'unknown_permission',
      };
    }

    const hintedTenantId = this.isObjectId(params.tenantHint)
      ? params.tenantHint
      : undefined;
    const rawUserId = String(params.rawUserId);

    if (hintedTenantId && this.isObjectId(rawUserId)) {
      const cached = await this.readCachedPermissionSafely(
        hintedTenantId,
        rawUserId,
        permissionKey,
      );
      if (cached !== null) {
        return {
          allowed: cached,
          userId: rawUserId,
          tenantId: hintedTenantId,
          cacheHit: true,
          requiredPermission: permissionKey,
          denyReason: cached ? undefined : 'cached_permission_denied',
        };
      }
    }

    const user = await this.resolveUser(rawUserId);
    if (!user) {
      this.logger.warn(
        `Permission denied: user not found rawUserId=${rawUserId} requiredPermission=${permissionKey}`,
      );
      return {
        allowed: false,
        cacheHit: false,
        requiredPermission: permissionKey,
        denyReason: 'user_not_found',
      };
    }

    return this.evaluatePermissionForUser(
      user,
      params,
      permissionKey,
    );
  }

  /** Resolve a user from either MongoDB ObjectId or Keycloak UUID. */
  private async resolveUser(rawUserId: string): Promise<any> {
    const userRepository = this.moduleRef.get(UserRepository, {
      strict: false,
    });

    return this.isObjectId(rawUserId)
      ? (await userRepository.findByIdsGlobal([rawUserId]))[0] || null
      : await userRepository.findByKeycloakIdAndProvider({
          keycloakId: rawUserId,
          provider: 'email',
        });
  }

  /** Evaluate permissions for a resolved user against tenant context. */
  private async evaluatePermissionForUser(
    user: any,
    params: {
      rawUserId: string;
      tenantHint?: string;
      rule: PermissionRuleMetadata;
    },
    permissionKey: string,
  ): Promise<AuthzPermissionCheckResult> {
    const tenantsRepository = this.moduleRef.get(TenantsRepository, {
      strict: false,
    });
    const groupRepository = this.moduleRef.get(GroupRepository, {
      strict: false,
    });

    const tenantHint = params.tenantHint ?? user.tenants?.[0]?.tenantId;
    const tenant = await this.resolveTenant(tenantsRepository, tenantHint);
    if (!tenant) {
      this.logger.warn(
        `Permission denied: tenant not resolved userId=${String(user.id)} tenantHint=${tenantHint ? String(tenantHint) : 'none'} requiredPermission=${permissionKey}`,
      );
      return {
        allowed: false,
        userId: String(user.id),
        email: user.email,
        cacheHit: false,
        requiredPermission: permissionKey,
        denyReason: 'tenant_not_resolved',
      };
    }

    this.setAuthorizationContext({
      userId: String(user.id),
      tenantId: String(tenant.id),
      email: user.email,
    });

    const cached = await this.readCachedPermissionSafely(
      String(tenant.id),
      String(user.id),
      permissionKey,
    );
    if (cached !== null) {
      return {
        allowed: cached,
        userId: String(user.id),
        tenantId: String(tenant.id),
        email: user.email,
        cacheHit: true,
        requiredPermission: permissionKey,
        denyReason: cached ? undefined : 'cached_permission_denied',
      };
    }

    if (user.platformRole?.id === PlatformRoleEnum.SUPER_ADMIN) {
      await this.populatePermissionsSafely(String(tenant.id), String(user.id), [
        ALL_SENTINEL,
      ]);

      return {
        allowed: true,
        userId: String(user.id),
        tenantId: String(tenant.id),
        email: user.email,
        cacheHit: false,
        requiredPermission: permissionKey,
      };
    }

    const userGroups = await groupRepository.findGroupsByMember(
      String(tenant.id),
      String(user.id),
    );
    const effectivePermissions = calculateEffectivePermissions(
      tenant as PermissionTenant,
      user,
      userGroups,
    );

    await this.populatePermissionsSafely(
      String(tenant.id),
      String(user.id),
      Array.from(effectivePermissions),
    );

    const allowed = canAccess(
      effectivePermissions,
      params.rule.action,
      params.rule.resource,
    );

    if (!allowed) {
      this.logger.warn(
        `Permission denied: permission not granted userId=${String(user.id)} tenantId=${String(tenant.id)} requiredPermission=${permissionKey} effectivePermissions=${effectivePermissions.size} groups=${userGroups.length}`,
      );
    }

    return {
      allowed,
      userId: String(user.id),
      tenantId: String(tenant.id),
      email: user.email,
      cacheHit: false,
      requiredPermission: permissionKey,
      denyReason: allowed ? undefined : 'permission_not_granted',
    };
  }

  async invalidateUser(tenantId: string, userId: string): Promise<void> {
    await this.redisService
      .getClient()
      .del(this.buildKey(tenantId, userId))
      .catch((error) => this.logRedisWarning('invalidate user', error));
  }

  async invalidateUsers(tenantId: string, userIds: string[]): Promise<void> {
    const keys = Array.from(new Set(userIds.filter(Boolean))).map((userId) =>
      this.buildKey(tenantId, userId),
    );
    if (keys.length === 0) return;
    await this.redisService
      .getClient()
      .del(...keys)
      .catch((error) => this.logRedisWarning('invalidate users', error));
  }

  async invalidateTenant(tenantId: string): Promise<void> {
    try {
      const client = this.redisService.getClient();
      const pattern = `authz:t:${tenantId}:u:*:perms`;
      let cursor = '0';
      let deleted = 0;

      do {
        const [nextCursor, keys] = await client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          deleted += await client.del(...keys);
        }
      } while (cursor !== '0');

      this.logger.debug(
        `Invalidated ${deleted} authz permission cache keys for tenant=${tenantId}`,
      );
    } catch (error) {
      this.logRedisWarning('invalidate tenant', error);
    }
  }

  private async readCachedPermissionSafely(
    tenantId: string,
    userId: string,
    permissionKey: string,
  ): Promise<boolean | null> {
    try {
      return await this.readCachedPermission(tenantId, userId, permissionKey);
    } catch (error) {
      this.logRedisWarning('read permission cache', error);
      return null;
    }
  }

  private async populatePermissionsSafely(
    tenantId: string,
    userId: string,
    permissions: string[],
  ): Promise<void> {
    try {
      await this.populatePermissions(tenantId, userId, permissions);
    } catch (error) {
      this.logRedisWarning('populate permission cache', error);
    }
  }

  private async readCachedPermission(
    tenantId: string,
    userId: string,
    permissionKey: string,
  ): Promise<boolean | null> {
    const client = this.redisService.getClient();
    const key = this.buildKey(tenantId, userId);
    const exists = await client.exists(key);

    if (!exists) {
      this.logger.debug(`Authz permission cache miss key=${key}`);
      return null;
    }

    this.logger.debug(`Authz permission cache hit key=${key}`);
    const [hasAll, hasPermission] = await Promise.all([
      client.sismember(key, ALL_SENTINEL),
      client.sismember(key, permissionKey),
    ]);

    return hasAll === 1 || hasPermission === 1;
  }

  private async populatePermissions(
    tenantId: string,
    userId: string,
    permissions: string[],
  ): Promise<void> {
    const key = this.buildKey(tenantId, userId);
    const members = permissions.length > 0 ? permissions : [EMPTY_SENTINEL];
    const client = this.redisService.getClient();
    const pipeline = client.pipeline();

    pipeline.del(key);
    pipeline.sadd(key, ...members);
    pipeline.expire(key, this.ttlSeconds);
    await pipeline.exec();
  }

  private async resolveTenant(
    tenantsRepository: TenantsRepository,
    tenantHint?: string,
  ) {
    if (!tenantHint) return null;
    const tenantHintString = String(tenantHint);

    if (this.isObjectId(tenantHintString)) {
      return tenantsRepository.findById(tenantHintString);
    }

    return (
      (await tenantsRepository.findByAlias(tenantHintString)) ??
      (await tenantsRepository.findByKeycloakOrgId(tenantHintString))
    );
  }

  private buildKey(tenantId: string, userId: string): string {
    return `authz:t:${tenantId}:u:${userId}:perms`;
  }

  private isObjectId(value?: string): value is string {
    return !!value && /^[0-9a-fA-F]{24}$/.test(value);
  }

  private readPositiveNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;

    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private logRedisWarning(action: string, error: unknown): void {
    this.logger.warn(
      `Authz Redis ${action} failed; continuing without cache: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  private setAuthorizationContext(context: {
    userId: string;
    tenantId: string;
    email?: string | null;
  }): void {
    this.cls.set('userId', context.userId);
    this.cls.set('tenantId', context.tenantId);
    this.cls.set('activeTenantId', context.tenantId);
    this.cls.set('email', context.email);
  }
}
