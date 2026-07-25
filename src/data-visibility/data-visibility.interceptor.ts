import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { ClsService } from 'nestjs-cls';
import { RoleHierarchyService } from './role-hierarchy.service';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { TenantRoleEnum } from '../roles/tenant-role.enum';
import { ModuleRef } from '@nestjs/core';
import { UsersDocumentRepository } from '../users/infrastructure/persistence/document/repositories/user.repository';
import { GroupRepository } from '../groups/infrastructure/persistence/document/repositories/group.repository';
import { isValidObjectId } from 'mongoose';
import {
  DataScope,
  isDataScope,
  maxScope,
} from '../common/permissions/data-scope.enum';
import { AuthzPermissionCacheService } from '../common/permissions/authz-permission-cache.service';
import { OrgUnitsService } from '../org-units/org-units.service';

/**
 * DataVisibilityInterceptor — Enriches CLS with `visibleOwnerIds`.
 *
 * Runs AFTER TenantInterceptor (which sets tenantId, userId).
 *
 * CLS output:
 *   - `visibleOwnerIds`: string[] | null | undefined
 *     - undefined  → visibility not evaluated (system routes, no auth)
 *     - null       → see ALL records (admin/owner bypass)
 *     - string[]   → filter by these owner IDs
 *
 * Data visibility settings (from `crm-settings/data_visibility`):
 *   - defaultAccess: 'private' | 'public_read'
 *     - 'private':     users see own + subordinates' data only
 *     - 'public_read': all users see all data (no filter)
 */
@Injectable()
export class DataVisibilityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(DataVisibilityInterceptor.name);

  constructor(
    private readonly cls: ClsService,
    private readonly hierarchyService: RoleHierarchyService,
    private readonly settingsService: CrmSettingsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Resolved lazily, like the repositories below. This interceptor is provided
   * by a @Global module that runs on every request, so constructor-injecting
   * services from AuthorizationModule / OrgUnitsModule would force those into
   * the global module's dependency graph and produce a cycle — both of them
   * transitively depend on the CLS context this interceptor populates.
   */
  private get authzCache(): AuthzPermissionCacheService {
    return this.moduleRef.get(AuthzPermissionCacheService, { strict: false });
  }

  private get orgUnits(): OrgUnitsService {
    return this.moduleRef.get(OrgUnitsService, { strict: false });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return from(this.resolveVisibility()).pipe(switchMap(() => next.handle()));
  }

  private async resolveVisibility(): Promise<void> {
    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');

    // No context → skip (public routes, health checks)
    if (!tenantId || !userId) {
      return;
    }

    try {
      // 1. Check data_visibility settings
      const settings = await this.settingsService.getSetting('data_visibility');
      const defaultAccess = settings?.defaultAccess ?? 'private';

      // If public_read, everyone sees everything
      if (defaultAccess === 'public_read') {
        this.cls.set('visibleOwnerIds', null);
        this.cls.set('visibleOrgUnitIds', null);
        return;
      }

      // 2. Check if user is ADMIN or OWNER → bypass
      const userRoles = await this.getUserTenantRoles(tenantId, userId);
      if (
        userRoles.includes(TenantRoleEnum.ADMIN) ||
        userRoles.includes(TenantRoleEnum.OWNER)
      ) {
        this.cls.set('visibleOwnerIds', null); // See all
        this.cls.set('visibleOrgUnitIds', null);
        this.logger.debug(`Admin/Owner bypass for user ${userId}`);
        return;
      }

      // C3: unowned (ownerId null/missing) records are hidden from scoped
      // users by default — they must NOT leak to everyone. Tenants that rely
      // on an "unassigned pool" pattern (e.g. shared lead/ticket queue) can
      // opt in via data_visibility.unownedRecordsVisibleToAll. Admins/Owners
      // always see them (they bypass the owner filter entirely, step 2).
      this.cls.set(
        'includeUnownedInScope',
        settings?.unownedRecordsVisibleToAll === true,
      );

      // 3. Resolve the principal's DataScope, then translate it into filters.
      //
      // H-07: this is where "Department / Branch / Organization scope" actually
      // becomes enforcement. Before, the only scope that existed was the
      // reportsToId subtree, so a role labelled "sees the whole department" in
      // the admin UI behaved identically to one labelled "sees own records".
      const { scope, orgUnitId } = await this.resolveScope(
        tenantId,
        userId,
        settings?.defaultScope,
      );

      // TENANT scope is the old "Organization" level. It is not a bypass of the
      // tenant boundary — tenantFilterPlugin still applies underneath — it just
      // adds no owner restriction on top.
      if (scope === DataScope.TENANT) {
        this.cls.set('visibleOwnerIds', null);
        this.cls.set('visibleOrgUnitIds', null);
        this.cls.set(
          'visibleGroupIds',
          await this.resolveUserGroupIds(tenantId, userId),
        );
        return;
      }

      // SELF stops at the principal; anything wider follows the reportsToId
      // chain. Org-unit scopes include the hierarchy too: a unit head normally
      // also has direct reports, and dropping them would make a WIDER scope
      // show FEWER records than a narrower one.
      const visibleIds =
        scope === DataScope.SELF
          ? [userId]
          : await this.hierarchyService.getVisibleOwnerIds(tenantId, userId);

      // The org-unit axis, unioned with the owner axis at query time. Empty for
      // SELF / SUBORDINATES, and empty for an unassigned user under any scope —
      // an empty list contributes no rows rather than matching everything.
      this.cls.set(
        'visibleOrgUnitIds',
        await this.orgUnits.resolveScopeUnitIds(tenantId, orgUnitId, scope),
      );

      // 3b. Resolve the groups the user belongs to. Used by entities scoped
      // by group assignment rather than ownerId (e.g. omni conversations, C4).
      this.cls.set(
        'visibleGroupIds',
        await this.resolveUserGroupIds(tenantId, userId),
      );

      // 4. Check sharing rules for additional shared IDs
      const sharedIds = await this.resolveSharedIds(tenantId, userId);
      if (sharedIds.length > 0) {
        const combined = [...new Set([...visibleIds, ...sharedIds])];
        this.cls.set('visibleOwnerIds', combined);
      } else {
        this.cls.set('visibleOwnerIds', visibleIds);
      }

      this.logger.debug(
        `Visibility for user ${userId}: ${visibleIds.length} owner IDs`,
      );
    } catch (e) {
      // Fail-closed: visibility failures must never widen access.
      this.logger.error(
        `Visibility resolution failed, fail-closed: ${(e as Error).message}`,
      );
      this.cls.set('visibleOwnerIds', []);
      this.cls.set('visibleOrgUnitIds', []);
      throw new InternalServerErrorException(
        'Data visibility resolution failed',
      );
    }
  }

  /**
   * The principal's effective DataScope, and the org unit it is anchored to.
   *
   * Two inputs, unioned:
   *   - the widest `dataScope` among the roles the principal actually holds
   *     (membership, inherited groups, active JIT grants);
   *   - the tenant's default scope, for principals whose roles express none.
   *
   * The tenant default exists to preserve the pre-H-07 contract. Before scope
   * was a first-class field, `defaultAccess: 'private'` meant "own records plus
   * subordinates", and every role implied exactly that. If an unset `dataScope`
   * resolved to SELF instead, rolling this out would silently narrow every
   * existing role in every tenant — users would open the app to an empty list
   * and the cause would look like data loss, not a policy change. So an unset
   * scope means "no opinion", and the tenant default supplies SUBORDINATES.
   *
   * A malformed configured default is ignored by `maxScope`, which floors at
   * SELF; the explicit fallback below keeps that from silently narrowing too.
   */
  private async resolveScope(
    tenantId: string,
    userId: string,
    configuredDefault: unknown,
  ): Promise<{ scope: DataScope; orgUnitId: string | null }> {
    const tenantDefault = isDataScope(configuredDefault)
      ? configuredDefault
      : DataScope.SUBORDINATES;

    const { scope: roleScope, orgUnitId } =
      await this.authzCache.resolveDataScope(userId, tenantId);

    return { scope: maxScope([roleScope, tenantDefault]), orgUnitId };
  }

  /**
   * Get the user's roles within the current tenant.
   */
  private async getUserTenantRoles(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    // TenantInterceptor runs first and has already resolved AND verified the
    // membership, so the roles are in CLS. Reusing them avoids a second user
    // read per request and removes the divergence that used to exist here.
    const fromCls = this.cls.get<string[]>('tenantRoles');
    if (Array.isArray(fromCls)) return fromCls;

    try {
      const userRepo = this.moduleRef.get(UsersDocumentRepository, {
        strict: false,
      });

      let user: any = null;
      if (isValidObjectId(userId)) {
        user = await userRepo.findById(userId);
      }

      if (!user) return [];

      // M-06: compare as strings. `tenantId` is an ObjectId on the document but
      // a string in CLS, so the previous `===` silently returned no roles —
      // which meant an admin was scoped like a regular member.
      const membership = user.tenants?.find(
        (t: any) => String(t.tenantId) === String(tenantId),
      );
      return membership?.roles ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Resolve the IDs of groups the user is a direct member of. Fail-soft:
   * returns [] on error (scoping then simply omits group-assigned records).
   */
  private async resolveUserGroupIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    try {
      const groupRepo = this.moduleRef.get(GroupRepository, { strict: false });
      const groups = await groupRepo.findGroupsByMember(tenantId, userId);
      return groups.map((g: any) => String(g.id ?? g._id)).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Resolve sharing rules: find additional user IDs whose records
   * should be visible to this user based on configured sharing rules.
   */
  private async resolveSharedIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    try {
      const sharingRules =
        await this.settingsService.getSetting('sharing_rules');
      if (!sharingRules?.rules || !Array.isArray(sharingRules.rules)) {
        return [];
      }

      const sharedUserIds: string[] = [];

      for (const rule of sharingRules.rules) {
        if (!rule.isActive) continue;

        // Check if this user is a target of the sharing rule
        if (rule.shareWith?.type === 'user') {
          if (rule.shareWith.ids?.includes(userId)) {
            // This rule shares records from specific owners with this user
            if (rule.sharedFrom?.type === 'user') {
              sharedUserIds.push(...(rule.sharedFrom.ids || []));
            }
          }
        }

        if (rule.shareWith?.type === 'role') {
          // Check if the user has any of the shared-with roles
          const userRoles = await this.getUserTenantRoles(tenantId, userId);
          const hasRole = rule.shareWith.ids?.some((r: string) =>
            userRoles.includes(r),
          );
          if (hasRole && rule.sharedFrom?.type === 'user') {
            sharedUserIds.push(...(rule.sharedFrom.ids || []));
          }
        }
      }

      // H-08: sharing rules come from tenant SETTINGS, which is a lower trust
      // boundary than the authorization model — whoever can write settings could
      // otherwise widen anyone's read scope to arbitrary user ids, including ids
      // belonging to another tenant. Only ids that are real members of THIS
      // tenant may enter the visibility scope.
      return this.keepTenantMembers(tenantId, [...new Set(sharedUserIds)]);
    } catch {
      return [];
    }
  }

  /** Filter a candidate id list down to verified members of the tenant. */
  private async keepTenantMembers(
    tenantId: string,
    candidateIds: string[],
  ): Promise<string[]> {
    const validIds = candidateIds.filter((id) => isValidObjectId(id));
    if (validIds.length === 0) return [];

    try {
      const userRepo = this.moduleRef.get(UsersDocumentRepository, {
        strict: false,
      });
      const users = await userRepo.findByIds(validIds);
      const members = users
        .filter((user: any) =>
          user?.tenants?.some(
            (membership: any) =>
              String(membership.tenantId) === String(tenantId),
          ),
        )
        .map((user: any) => String(user.id ?? user._id));

      const rejected = validIds.length - members.length;
      if (rejected > 0) {
        this.logger.warn(
          `Sharing rules referenced ${rejected} id(s) that are not members of tenant ${tenantId}; ignored`,
        );
      }
      return members;
    } catch {
      // Fail closed: an unverifiable id must not widen visibility.
      return [];
    }
  }
}
