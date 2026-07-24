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
        return;
      }

      // 2. Check if user is ADMIN or OWNER → bypass
      const userRoles = await this.getUserTenantRoles(tenantId, userId);
      if (
        userRoles.includes(TenantRoleEnum.ADMIN) ||
        userRoles.includes(TenantRoleEnum.OWNER)
      ) {
        this.cls.set('visibleOwnerIds', null); // See all
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

      // 3. For MEMBER/VIEWER: resolve hierarchy
      const visibleIds = await this.hierarchyService.getVisibleOwnerIds(
        tenantId,
        userId,
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
      throw new InternalServerErrorException(
        'Data visibility resolution failed',
      );
    }
  }

  /**
   * Get the user's roles within the current tenant.
   */
  private async getUserTenantRoles(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    try {
      const userRepo = this.moduleRef.get(UsersDocumentRepository, {
        strict: false,
      });

      let user: any = null;
      if (isValidObjectId(userId)) {
        user = await userRepo.findById(userId);
      }

      if (!user) return [];

      const membership = user.tenants?.find(
        (t: any) => t.tenantId === tenantId,
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

      return [...new Set(sharedUserIds)];
    } catch {
      return [];
    }
  }
}
