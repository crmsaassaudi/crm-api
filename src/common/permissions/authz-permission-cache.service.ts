import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { RedisService } from '../../redis/redis.service';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import { StatusEnum } from '../../statuses/statuses.enum';
import { GroupRepository } from '../../groups/infrastructure/persistence/document/repositories/group.repository';
import { TenantsRepository } from '../../tenants/infrastructure/persistence/document/repositories/tenant.repository';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import { CustomRolesService } from './custom-roles.service';
import { RoleAssignmentService } from './role-assignment.service';
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

    return this.evaluatePermissionForUser(user, params, permissionKey);
  }

  /**
   * Server-side confirmation that a principal is a platform SUPER_ADMIN.
   *
   * The DB `platformRole` is the sole source of truth — a JWT/Keycloak role
   * claim alone is NOT sufficient to grant platform god-mode (guards against
   * claim injection and Keycloak role-name namespace collisions). This is
   * tenant-independent so platform operators without a tenant context still
   * resolve correctly.
   */
  async isPlatformSuperAdmin(rawUserId: string): Promise<boolean> {
    const user = await this.resolveUser(String(rawUserId));
    if (!user) return false;
    // A deactivated principal is never a super-admin, even with a valid JWT.
    if (this.isInactive(user)) return false;
    return user?.platformRole?.id === PlatformRoleEnum.SUPER_ADMIN;
  }

  /**
   * A user is inactive when a status is set and it is not `active`
   * (`inactive` / `pending`). Legacy users with no status are treated as
   * active so existing accounts keep working.
   */
  private isInactive(user: any): boolean {
    const statusId = user?.status?.id;
    return Boolean(statusId) && statusId !== StatusEnum.active;
  }

  /** Load the tenant's custom roles as {id, permissions} for engine expansion. */
  private async loadTenantRoles(
    tenantId: string,
  ): Promise<{ id: string; permissions: string[] }[]> {
    try {
      const rolesService = this.moduleRef.get(CustomRolesService, {
        strict: false,
      });
      const roles = await rolesService.findAll(tenantId);
      return (roles ?? []).map((role: any) => ({
        id: String(role._id ?? role.id),
        permissions: role.permissions ?? [],
      }));
    } catch (error) {
      this.logger.warn(
        `Failed to load tenant roles for ${tenantId}; continuing without role expansion: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /** Active (non-expired, non-revoked) JIT/permanent assignment role ids. */
  private async loadActiveAssignmentRoleIds(
    tenantId: string,
    principalIds: string[],
  ): Promise<string[]> {
    try {
      const service = this.moduleRef.get(RoleAssignmentService, {
        strict: false,
      });
      if (!service) return [];
      return await service.activeRoleIdsForPrincipals(
        tenantId,
        principalIds,
        new Date(),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to load active role assignments for ${tenantId}; continuing without them: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /**
   * Return a shallow-cloned subject whose active-tenant membership roleIds also
   * include the granted assignment roleIds — so the engine expands them as
   * regular role references. Never mutates the cached user document.
   */
  private withAssignmentRoles(
    user: any,
    tenantId: string,
    assignmentRoleIds: string[],
  ): any {
    if (assignmentRoleIds.length === 0) return user;
    const tenants = (user.tenants ?? []).map((membership: any) => {
      if (String(membership.tenantId) !== tenantId) return membership;
      const merged = Array.from(
        new Set([...(membership.roleIds ?? []), ...assignmentRoleIds]),
      );
      return { ...membership, roleIds: merged };
    });
    // If the user had no membership row for this tenant, synthesize one so the
    // granted roles still resolve (e.g. a pure JIT elevation).
    const hasMembership = tenants.some(
      (m: any) => String(m.tenantId) === tenantId,
    );
    if (!hasMembership) {
      tenants.push({ tenantId, roles: [], roleIds: assignmentRoleIds });
    }
    return { ...user, tenants };
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

    // Deactivated users get NO permissions — regardless of role assignments
    // or platform super-admin. A still-valid JWT must not outlive account
    // deactivation. Cache the empty set so subsequent requests short-circuit;
    // reactivation invalidates the entry via `user.permissions.updated`.
    if (this.isInactive(user)) {
      await this.populatePermissionsSafely(
        String(tenant.id),
        String(user.id),
        [],
      );
      this.logger.warn(
        `Permission denied: user inactive userId=${String(user.id)} tenantId=${String(tenant.id)} requiredPermission=${permissionKey}`,
      );
      return {
        allowed: false,
        userId: String(user.id),
        tenantId: String(tenant.id),
        email: user.email,
        cacheHit: false,
        requiredPermission: permissionKey,
        denyReason: 'user_inactive',
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

    const [userGroups, tenantRoles] = await Promise.all([
      // Group-hierarchy inheritance (C1): include ancestor groups.
      groupRepository.findGroupsByMemberWithAncestors(
        String(tenant.id),
        String(user.id),
      ),
      this.loadTenantRoles(String(tenant.id)),
    ]);

    // JIT / time-bound grants (Phase B): union active RoleAssignment roleIds
    // for the user AND every group they inherit from, on top of the standing
    // embedded roleIds. Expired/revoked grants are excluded at query time.
    const groupIds = userGroups
      .map((group: any) => group?.id)
      .filter(Boolean)
      .map(String);
    const assignmentRoleIds = await this.loadActiveAssignmentRoleIds(
      String(tenant.id),
      [String(user.id), ...groupIds],
    );
    const subject = this.withAssignmentRoles(
      user,
      String(tenant.id),
      assignmentRoleIds,
    );

    const effectivePermissions = calculateEffectivePermissions(
      tenant as PermissionTenant,
      subject,
      userGroups,
      tenantRoles,
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
