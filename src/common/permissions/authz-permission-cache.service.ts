import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { RedisService } from '../../redis/redis.service';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import { TenantRoleEnum } from '../../roles/tenant-role.enum';
import { DataScope, maxScope } from './data-scope.enum';
import { StatusEnum } from '../../statuses/statuses.enum';
import { GroupRepository } from '../../groups/infrastructure/persistence/document/repositories/group.repository';
import { TenantsRepository } from '../../tenants/infrastructure/persistence/document/repositories/tenant.repository';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import type { CustomRolesService } from './custom-roles.service';
import type { RoleAssignmentService } from './role-assignment.service';
import { CUSTOM_ROLES_SERVICE, ROLE_ASSIGNMENT_SERVICE } from './authz.tokens';
import {
  calculateEffectivePermissions,
  canAccess,
  explainEffectivePermissions,
  EffectivePermissionExplanation,
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

  /** Load the tenant's custom roles as {id, name, permissions} for engine expansion. */
  private async loadTenantRoles(tenantId: string): Promise<
    {
      id: string;
      name?: string;
      permissions: string[];
      dataScope?: DataScope | null;
    }[]
  > {
    try {
      const rolesService = this.moduleRef.get<CustomRolesService>(
        CUSTOM_ROLES_SERVICE,
        { strict: false },
      );
      const roles = await rolesService.findAll(tenantId);
      return (roles ?? []).map((role) => ({
        id: String(role.id),
        name: role.name,
        permissions: role.permissions ?? [],
        dataScope: role.dataScope ?? null,
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
      const service = this.moduleRef.get<RoleAssignmentService>(
        ROLE_ASSIGNMENT_SERVICE,
        { strict: false },
      );
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
  /**
   * Overlay an admin's UNSAVED membership edits onto the resolved subject.
   * Only the two fields the edit dialog can change are replaced; everything
   * else (group membership, JIT grants, tenant role) stays as stored, because
   * the preview must answer "what will be true after I save", not "what would
   * be true in some other tenant state".
   */
  private withCandidateMembership(
    user: any,
    tenantId: string,
    candidate?: {
      roleIds?: string[];
      permissionOverrides?: Record<string, boolean>;
    },
  ): any {
    if (!candidate) return user;

    const tenants = (user.tenants ?? []).map((membership: any) => {
      if (String(membership.tenantId) !== tenantId) return membership;
      return {
        ...membership,
        roleIds: candidate.roleIds ?? membership.roleIds,
        permissionOverrides:
          candidate.permissionOverrides ?? membership.permissionOverrides,
      };
    });

    return { ...user, tenants };
  }

  private withAssignmentRoles(
    user: any,
    tenantId: string,
    assignmentRoleIds: string[],
  ): any {
    if (assignmentRoleIds.length === 0) return user;

    // A JIT grant ELEVATES an existing member; it does not create membership
    // (H-03). Synthesizing a membership row here meant a role assignment
    // written against a non-member — including a user of another tenant —
    // produced real, working access with no membership at all. Membership is
    // established by the invite/onboarding path and verified by
    // TenantInterceptor; authorization must never manufacture it.
    const hasMembership = (user.tenants ?? []).some(
      (membership: any) => String(membership.tenantId) === tenantId,
    );
    if (!hasMembership) {
      this.logger.warn(
        `Ignoring ${assignmentRoleIds.length} role assignment(s) for user=${String(
          user.id,
        )} in tenant=${tenantId}: the user is not a member of that tenant`,
      );
      return user;
    }

    const tenants = (user.tenants ?? []).map((membership: any) => {
      if (String(membership.tenantId) !== tenantId) return membership;
      const merged = Array.from(
        new Set([...(membership.roleIds ?? []), ...assignmentRoleIds]),
      );
      return { ...membership, roleIds: merged };
    });

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

  /**
   * Resolve a user's EFFECTIVE permissions with source attribution, for admin
   * preview ("what can this user do, and why"). Not cached — always computed
   * fresh from roles/groups/JIT so the preview reflects the true current state.
   *
   * `candidate` replaces the user's stored membership roleIds / overrides with
   * UNSAVED ones, so an admin editing a user can be shown the access their
   * pending change would actually produce. It runs through this exact code
   * path on purpose: the previous client-side preview was a second permission
   * engine, and it disagreed with this one about owner/admin ceilings, direct
   * grants, inherited ancestor groups, JIT assignments and deactivated users.
   */
  async explainForUser(
    rawUserId: string,
    tenantHint?: string,
    candidate?: {
      roleIds?: string[];
      permissionOverrides?: Record<string, boolean>;
    },
  ): Promise<EffectivePermissionExplanation> {
    const tenantsRepository = this.moduleRef.get(TenantsRepository, {
      strict: false,
    });
    const groupRepository = this.moduleRef.get(GroupRepository, {
      strict: false,
    });

    const user = await this.resolveUser(rawUserId);
    if (!user) {
      return {
        effective: [],
        sources: {},
        tenantCeiling: [],
        fullAccess: false,
      };
    }

    const resolvedHint = tenantHint ?? user.tenants?.[0]?.tenantId;
    const tenant = await this.resolveTenant(
      tenantsRepository,
      resolvedHint ? String(resolvedHint) : undefined,
    );
    if (!tenant) {
      return {
        effective: [],
        sources: {},
        tenantCeiling: [],
        fullAccess: false,
      };
    }

    const permissionTenant: PermissionTenant = {
      id: String(tenant.id),
      ownerId: (tenant as any).ownerId ?? null,
      availablePermissions: (tenant as any).availablePermissions ?? null,
      disabledCorePermissions: (tenant as any).disabledCorePermissions ?? null,
    };

    // Deactivated user → no permissions (mirror the runtime deny).
    if (this.isInactive(user)) {
      return {
        effective: [],
        sources: {},
        tenantCeiling: explainEffectivePermissions(permissionTenant, {
          id: String(user.id),
          tenants: [],
        }).tenantCeiling,
        fullAccess: false,
      };
    }

    const superAdmin = user.platformRole?.id === PlatformRoleEnum.SUPER_ADMIN;

    const [userGroups, tenantRoles] = await Promise.all([
      groupRepository.findGroupsByMemberWithAncestors(
        String(tenant.id),
        String(user.id),
      ),
      this.loadTenantRoles(String(tenant.id)),
    ]);

    const groupIds = userGroups
      .map((group: any) => group?.id)
      .filter(Boolean)
      .map(String);
    const assignmentRoleIds = await this.loadActiveAssignmentRoleIds(
      String(tenant.id),
      [String(user.id), ...groupIds],
    );
    const subject = this.withCandidateMembership(
      this.withAssignmentRoles(user, String(tenant.id), assignmentRoleIds),
      String(tenant.id),
      candidate,
    );

    return explainEffectivePermissions(
      permissionTenant,
      { id: String(subject.id), tenants: subject.tenants },
      userGroups.map((group: any) => ({
        id: group?.id ? String(group.id) : undefined,
        name: group?.name,
        permissions: group?.permissions ?? [],
        roleIds: (group?.roleIds ?? []).map(String),
      })),
      tenantRoles,
      { superAdmin },
    );
  }

  /**
   * The principal's effective DataScope in a tenant, plus the org unit it is
   * anchored to.
   *
   * Deliberately built from the SAME grant sources as permissions — membership
   * roleIds, inherited group roleIds, and active JIT assignments — because a
   * scope that ignored one of those sources would disagree with the permission
   * set derived from it. The classic version of that bug is a role granted via a
   * group whose permissions apply but whose scope does not, leaving a manager
   * able to run a query they can see no rows for.
   *
   * Full-access principals (tenant OWNER/ADMIN, super-admin) get TENANT: the
   * permission engine already short-circuits them to the whole ceiling, so
   * anything narrower here would contradict it.
   *
   * Fail-closed: an unresolvable user, tenant, or inactive account yields SELF
   * with no org unit. `maxScope([])` is SELF, so a role catalogue that fails to
   * load narrows rather than widens.
   */
  async resolveDataScope(
    rawUserId: string,
    tenantHint?: string,
  ): Promise<{ scope: DataScope; orgUnitId: string | null }> {
    const closed = { scope: DataScope.SELF, orgUnitId: null };

    const tenantsRepository = this.moduleRef.get(TenantsRepository, {
      strict: false,
    });
    const groupRepository = this.moduleRef.get(GroupRepository, {
      strict: false,
    });

    const user = await this.resolveUser(rawUserId);
    if (!user || this.isInactive(user)) return closed;

    const resolvedHint = tenantHint ?? user.tenants?.[0]?.tenantId;
    const tenant = await this.resolveTenant(
      tenantsRepository,
      resolvedHint ? String(resolvedHint) : undefined,
    );
    if (!tenant) return closed;

    const orgUnitId = (user as any).orgUnitId
      ? String((user as any).orgUnitId)
      : null;

    const membership = user.tenants?.find(
      (row: any) => String(row.tenantId) === String(tenant.id),
    );

    const superAdmin = user.platformRole?.id === PlatformRoleEnum.SUPER_ADMIN;
    const privileged =
      superAdmin ||
      String((tenant as any).ownerId ?? '') === String(user.id) ||
      (membership?.roles ?? []).some(
        (role: string) =>
          role === TenantRoleEnum.OWNER || role === TenantRoleEnum.ADMIN,
      );
    if (privileged) return { scope: DataScope.TENANT, orgUnitId };

    const [userGroups, tenantRoles] = await Promise.all([
      groupRepository.findGroupsByMemberWithAncestors(
        String(tenant.id),
        String(user.id),
      ),
      this.loadTenantRoles(String(tenant.id)),
    ]);

    const groupIds = userGroups
      .map((group: any) => group?.id)
      .filter(Boolean)
      .map(String);
    const assignmentRoleIds = await this.loadActiveAssignmentRoleIds(
      String(tenant.id),
      [String(user.id), ...groupIds],
    );

    const heldRoleIds = new Set<string>([
      ...(membership?.roleIds ?? []).map(String),
      ...userGroups.flatMap((group: any) => (group?.roleIds ?? []).map(String)),
      ...assignmentRoleIds.map(String),
    ]);

    const scopes = tenantRoles
      .filter((role) => heldRoleIds.has(String(role.id)))
      .map((role) => role.dataScope);

    return { scope: maxScope(scopes), orgUnitId };
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
