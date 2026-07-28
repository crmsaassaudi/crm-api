import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  InternalServerErrorException,
  Optional,
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
import {
  VISIBILITY_MODULES,
  VisibilityModule,
} from '../common/permissions/visibility-modules';
import { AuthzPermissionCacheService } from '../common/permissions/authz-permission-cache.service';
import { OrgUnitsService } from '../org-units/org-units.service';
import { ChannelSupportService } from '../channels/services/channel-support.service';
import { RedisService } from '../redis/redis.service';

const VISIBILITY_CACHE_KEYS = [
  'visibleOwnerIds',
  'visibleOrgUnitIds',
  'visibleGroupIds',
  'servableChannelIds',
  'dataVisibilityByModule',
  'channelVisibilityOverrides',
  'strictOwnerIds',
  'strictOrgUnitIds',
  'includeUnownedInScope',
] as const;

/** The pair of axes the repositories AND/OR together at query time. */
interface VisibilityAxes {
  ownerIds: string[] | null;
  orgUnitIds: string[] | null;
}

/** Extra visibility a sharing rule grants, already resolved to ids. */
interface SharingGrant {
  ownerIds: string[];
  orgUnitIds: string[];
  /** The rule shares EVERY record in the module — the axes drop entirely. */
  all: boolean;
}

const EMPTY_GRANT: SharingGrant = { ownerIds: [], orgUnitIds: [], all: false };

/**
 * DataVisibilityInterceptor — resolves, once per request, everything the
 * repositories need to scope a read.
 *
 * Runs AFTER TenantInterceptor (which sets tenantId, userId).
 *
 * CLS output:
 *   - `visibleOwnerIds` / `visibleOrgUnitIds`: the tenant-wide axes.
 *       - undefined → visibility not evaluated (system routes, no auth)
 *       - null      → see ALL records (bypass)
 *       - string[]  → restrict to these ids
 *   - `dataVisibilityByModule`: the same pair per module, present only for
 *     modules the tenant configured differently (or that a sharing rule
 *     targets specifically). Repositories tagged with `visibilityModule()`
 *     prefer their entry; everything else keeps using the tenant-wide pair.
 *   - `visibleGroupIds`, `servableChannelIds`, `channelVisibilityOverrides`,
 *     `strictOwnerIds` / `strictOrgUnitIds`, `includeUnownedInScope`.
 *
 * Four independent axes make up "what can this person see":
 *   1. role DataScope (self → tenant), unioned with the tenant default;
 *   2. org units they MANAGE, which follows the person, not their job title;
 *   3. sharing rules — explicit, optionally expiring exceptions;
 *   4. the channel pool, for conversations only.
 * They are unioned, never intersected: a wider grant must never return fewer
 * rows than a narrower one, or the model becomes impossible to reason about.
 */
@Injectable()
export class DataVisibilityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(DataVisibilityInterceptor.name);

  constructor(
    private readonly cls: ClsService,
    private readonly hierarchyService: RoleHierarchyService,
    private readonly settingsService: CrmSettingsService,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly redis?: RedisService,
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

  /**
   * Resolve every visibility axis for the `tenantId` + `userId` already in CLS.
   *
   * Public so non-HTTP entry points can reuse the exact same computation. The
   * automation worker calls it after establishing a principal, which is what
   * lets an automation be subject to the owner, org-unit, sharing-rule and
   * channel axes instead of running unscoped: the repository layer keys off
   * these CLS values and treats their absence as "no filter", so a queue
   * consumer that never populated them read and wrote the whole tenant.
   *
   * Deliberately shared rather than reimplemented — two copies of a visibility
   * calculation is two answers to the same question.
   */
  async resolveVisibility(): Promise<void> {
    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');

    // No context → skip (public routes, health checks)
    if (!tenantId || !userId) {
      return;
    }

    try {
      if (await this.restoreCachedVisibility(tenantId, userId)) return;
      // 1. Check if user is ADMIN or OWNER → bypass every axis.
      //
      // Resolved before the settings read because the channel axis below must
      // apply even under `public_read`: `public_read` is a statement about
      // record ownership, whereas a restricted channel is an explicit access
      // grant made by whoever configured the channel. Only a tenant admin
      // overrides that.
      const userRoles = await this.getUserTenantRoles(tenantId, userId);
      const bypass =
        userRoles.includes(TenantRoleEnum.ADMIN) ||
        userRoles.includes(TenantRoleEnum.OWNER) ||
        // A tenant-defined role may also carry the full-read grant, so "who
        // sees everything" is not permanently welded to the two built-in
        // roles. Checked after them because they short-circuit for free.
        (await this.hasFullReadPermission(tenantId, userId));
      if (bypass) {
        this.cls.set('visibleOwnerIds', null); // See all
        this.cls.set('visibleOrgUnitIds', null);
        this.cls.set('servableChannelIds', null);
        this.cls.set('dataVisibilityByModule', {});
        // Resolved even though nothing is being restricted: an admin can also
        // be a member of a team, and features that mean "the team I am in"
        // (the omni team queue, group-scoped ACL rows) read this list. Leaving
        // it unset made those silently empty for admins only.
        this.cls.set(
          'visibleGroupIds',
          await this.resolveUserGroupIds(tenantId, userId),
        );
        await this.cacheResolvedVisibility(tenantId, userId);
        this.logger.debug(`Admin/Owner bypass for user ${userId}`);
        return;
      }

      // 2. The channel axis: which channels this principal may serve at all.
      //    Independent of the owner axis — an agent outside a restricted
      //    channel's support pool must not read its conversations even when
      //    they are unassigned or assigned to a visible colleague.
      //    null → no restriction (every channel in the tenant is open).
      const userGroupIds = await this.resolveUserGroupIds(tenantId, userId);
      this.cls.set('visibleGroupIds', userGroupIds);
      this.cls.set(
        'servableChannelIds',
        await this.resolveServableChannelIds(tenantId, userId),
      );

      // 2b. Per-channel override of the tenant default (M18): a channel can
      // force 'private' or 'public_read' regardless of the tenant-wide
      // setting below. Not wrapped in its own try/catch — an unresolvable
      // override must fail the whole request closed via the outer catch,
      // not silently fall back to {} (which would widen a channel that was
      // deliberately set to 'private').
      const visibilityOverrides =
        await this.resolveChannelVisibilityOverrides(tenantId);
      this.cls.set('channelVisibilityOverrides', visibilityOverrides);
      const needsStrictScope =
        Object.values(visibilityOverrides).includes('private');

      // 3. Tenant policy.
      const settings = await this.settingsService.getSetting('data_visibility');

      // C3: unowned (ownerId null/missing) records are hidden from scoped
      // users by default — they must NOT leak to everyone. Tenants that rely
      // on an "unassigned pool" pattern (e.g. shared lead/ticket queue) can
      // opt in via data_visibility.unownedRecordsVisibleToAll. Admins/Owners
      // always see them (they bypass the owner filter entirely, step 1).
      this.cls.set(
        'includeUnownedInScope',
        settings?.unownedRecordsVisibleToAll === true,
      );

      const ctx = await this.buildContext(
        tenantId,
        userId,
        userRoles,
        userGroupIds,
        settings,
      );

      // 4. The tenant-wide pair, then only those modules that actually differ.
      const base = await this.computeAxes(ctx, null);
      this.cls.set('visibleOwnerIds', base.ownerIds);
      this.cls.set('visibleOrgUnitIds', base.orgUnitIds);

      const byModule: Record<string, VisibilityAxes> = {};
      for (const moduleKey of VISIBILITY_MODULES) {
        if (!this.moduleDiffers(ctx, moduleKey)) continue;
        byModule[moduleKey] = await this.computeAxes(ctx, moduleKey);
      }
      this.cls.set('dataVisibilityByModule', byModule);

      // 5. M18 strict scope: what a channel forced to 'private' must apply,
      // even when everything above bypassed. Conversation-flavoured, since
      // that is the only thing a channel override can affect.
      if (needsStrictScope) {
        const strict = await this.computeAxes(ctx, 'Conversation', {
          forceAccess: 'private',
        });
        this.cls.set('strictOwnerIds', strict.ownerIds);
        this.cls.set('strictOrgUnitIds', strict.orgUnitIds);
      }

      this.logger.debug(
        `Visibility for user ${userId}: ${
          base.ownerIds?.length ?? 'unrestricted'
        } owner IDs, ${Object.keys(byModule).length} module override(s)`,
      );
      await this.cacheResolvedVisibility(tenantId, userId);
    } catch (e) {
      // Fail-closed: visibility failures must never widen access.
      this.logger.error(
        `Visibility resolution failed, fail-closed: ${(e as Error).message}`,
      );
      this.cls.set('visibleOwnerIds', []);
      this.cls.set('visibleOrgUnitIds', []);
      this.cls.set('dataVisibilityByModule', {});
      this.cls.set('servableChannelIds', []);
      this.cls.set('channelVisibilityOverrides', {});
      this.cls.set('strictOwnerIds', []);
      this.cls.set('strictOrgUnitIds', []);
      throw new InternalServerErrorException(
        'Data visibility resolution failed',
      );
    }
  }

  private visibilityVersionKey(tenantId: string): string {
    return `authz:scope:${tenantId}:version`;
  }

  private async visibilityVersion(tenantId: string): Promise<string> {
    const client = this.redis!.getClient();
    const key = this.visibilityVersionKey(tenantId);
    let version = await client.get(key);
    if (version === null) {
      await client.set(key, '1', 'EX', 300, 'NX');
      version = (await client.get(key)) ?? '1';
    }
    return version;
  }

  private async restoreCachedVisibility(
    tenantId: string,
    userId: string,
  ): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const version = await this.visibilityVersion(tenantId);
      const cached = await this.redis.get<Record<string, unknown>>(
        `authz:scope:${tenantId}:${userId}:v${version}`,
      );
      if (!cached) return false;
      for (const key of VISIBILITY_CACHE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(cached, key)) {
          this.cls.set(key, cached[key]);
        }
      }
      return true;
    } catch (error) {
      this.logger.warn(
        `Visibility cache read failed; resolving live: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async cacheResolvedVisibility(
    tenantId: string,
    userId: string,
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const snapshot: Record<string, unknown> = {};
      for (const key of VISIBILITY_CACHE_KEYS) {
        const value = this.cls.get(key);
        if (value !== undefined) snapshot[key] = value;
      }
      const version = await this.visibilityVersion(tenantId);
      await this.redis.set(
        `authz:scope:${tenantId}:${userId}:v${version}`,
        snapshot,
        60,
      );
    } catch (error) {
      this.logger.warn(
        `Visibility cache write failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Does a tenant-defined role grant this principal `all_data:view`?
   *
   * Goes through the normal permission path, so it is served from the same
   * Redis-cached effective-permission set every guard uses — not a second
   * source of truth that could drift from it.
   *
   * Fail-soft (false): a permission check that cannot complete must not hand
   * out a full-tenant read. The narrow answer is the safe one here.
   */
  private async hasFullReadPermission(
    tenantId: string,
    userId: string,
  ): Promise<boolean> {
    try {
      const result = await this.authzCache.canAccess({
        rawUserId: userId,
        tenantHint: tenantId,
        rule: { action: 'view', resource: 'all_data' },
      });
      return result?.allowed === true;
    } catch {
      return false;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Resolution context
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Everything the per-module computations share, resolved at most once each.
   *
   * The expensive parts — the reporting chain, org-unit subtrees, the managed
   * units, the sharing rules — are memoised thunks rather than eager reads: a
   * tenant on `public_read` with no overrides must not pay for a hierarchy walk
   * it will never consult, and that is the common case.
   */
  private async buildContext(
    tenantId: string,
    userId: string,
    userRoles: string[],
    userGroupIds: string[],
    settings: any,
  ): Promise<ScopeContext> {
    const { scope: roleScope, orgUnitId } =
      await this.authzCache.resolveDataScope(userId, tenantId);

    const tenantDefaultScope = isDataScope(settings?.defaultScope)
      ? settings.defaultScope
      : DataScope.SUBORDINATES;

    const unitIdsByScope = new Map<DataScope, Promise<string[]>>();
    let hierarchyIds: Promise<string[]> | null = null;
    let managedUnitIds: Promise<string[]> | null = null;

    // Resolved eagerly, unlike the axes below: `moduleDiffers` has to know
    // which modules a rule names BEFORE deciding whether to compute them, and
    // it cannot await. The cost is one cached settings read when no rule exists.
    const grants = await this.resolveSharingGrants(
      tenantId,
      userId,
      userRoles,
      userGroupIds,
    );

    return {
      moduleScopedGrantKeys: new Set(
        [...grants.keys()].filter((key) => key !== '*'),
      ),
      grants: () => Promise.resolve(grants),
      tenantId,
      userId,
      userRoles,
      userGroupIds,
      roleScope,
      orgUnitId,
      tenantDefaultScope,
      defaultAccess:
        settings?.defaultAccess === 'public_read' ? 'public_read' : 'private',
      byModuleSettings:
        settings?.byModule && typeof settings.byModule === 'object'
          ? settings.byModule
          : {},
      managedUnitsEnabled: settings?.managedUnitsEnabled !== false,
      hierarchyIds: () =>
        (hierarchyIds ??= this.hierarchyService.getVisibleOwnerIds(
          tenantId,
          userId,
        )),
      scopeUnitIds: (scope: DataScope) => {
        const cached = unitIdsByScope.get(scope);
        if (cached) return cached;
        const promise = this.orgUnits.resolveScopeUnitIds(
          tenantId,
          orgUnitId,
          scope,
        );
        unitIdsByScope.set(scope, promise);
        return promise;
      },
      managedUnitIds: () =>
        (managedUnitIds ??= this.resolveManagedUnitIds(tenantId, userId)),
    };
  }

  /**
   * Does this module need its own axes, or does the tenant-wide pair already
   * describe it?
   *
   * Cheap and purely structural — it must not await anything, because it runs
   * for every module on every request. A module qualifies when the tenant
   * configured it explicitly, or when a sharing rule names it (a rule scoped to
   * 'Deal' must not widen Contact, which is exactly the bug the old
   * implementation shipped).
   */
  private moduleDiffers(
    ctx: ScopeContext,
    moduleKey: VisibilityModule,
  ): boolean {
    const configured = ctx.byModuleSettings[moduleKey];
    if (configured?.access || configured?.scope) return true;
    return ctx.moduleScopedGrantKeys.has(moduleKey);
  }

  /**
   * One module's axes (or the tenant-wide pair when `moduleKey` is null).
   *
   * Order matters: the widening checks come first, because once the answer is
   * "no restriction" there is nothing left to compute — and computing it anyway
   * is what made the previous version walk the hierarchy for `public_read`
   * tenants.
   */
  private async computeAxes(
    ctx: ScopeContext,
    moduleKey: VisibilityModule | null,
    opts?: { forceAccess?: 'private' | 'public_read' },
  ): Promise<VisibilityAxes> {
    const configured = moduleKey ? ctx.byModuleSettings[moduleKey] : undefined;
    const access =
      opts?.forceAccess ??
      (configured?.access === 'private' || configured?.access === 'public_read'
        ? configured.access
        : ctx.defaultAccess);

    if (access === 'public_read') return { ownerIds: null, orgUnitIds: null };

    const grant = await this.grantFor(ctx, moduleKey);
    if (grant.all) return { ownerIds: null, orgUnitIds: null };

    const moduleDefaultScope = isDataScope(configured?.scope)
      ? configured.scope
      : ctx.tenantDefaultScope;
    const scope = maxScope([ctx.roleScope, moduleDefaultScope]);

    if (scope === DataScope.TENANT) return { ownerIds: null, orgUnitIds: null };

    // SELF stops at the principal; anything wider follows the reportsToId
    // chain. Org-unit scopes include the hierarchy too: a unit head normally
    // also has direct reports, and dropping them would make a WIDER scope show
    // FEWER records than a narrower one.
    const scopedOwnerIds =
      scope === DataScope.SELF ? [ctx.userId] : await ctx.hierarchyIds();

    // Empty for SELF / SUBORDINATES, and empty for an unassigned user under
    // any scope — an empty list contributes no rows rather than matching
    // everything, so it is unioned with the owner axis at query time.
    const scopedUnitIds = await ctx.scopeUnitIds(scope);
    const managed = ctx.managedUnitsEnabled ? await ctx.managedUnitIds() : [];

    return {
      ownerIds: union(scopedOwnerIds, grant.ownerIds),
      orgUnitIds: union(scopedUnitIds, managed, grant.orgUnitIds),
    };
  }

  /** The sharing grant that applies to a module: its own, plus the '*' rules. */
  private async grantFor(
    ctx: ScopeContext,
    moduleKey: VisibilityModule | null,
  ): Promise<SharingGrant> {
    const grants = await ctx.grants();
    const wildcard = grants.get('*') ?? EMPTY_GRANT;
    if (!moduleKey) return wildcard;

    const scoped = grants.get(moduleKey);
    if (!scoped) return wildcard;
    return {
      ownerIds: union(wildcard.ownerIds, scoped.ownerIds),
      orgUnitIds: union(wildcard.orgUnitIds, scoped.orgUnitIds),
      all: wildcard.all || scoped.all,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Axis: org units the principal manages
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Units this principal is named manager of, plus their subtrees.
   *
   * Fail-soft ([]) rather than fail-closed: this axis only ever WIDENS, so a
   * failure here costs a manager some rows but cannot leak any. Failing the
   * request instead would take the whole app down for an org-tree hiccup.
   */
  private async resolveManagedUnitIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    try {
      return await this.orgUnits.listManagedUnitIds(tenantId, userId);
    } catch (e) {
      this.logger.warn(
        `Managed-unit resolution failed for ${userId}; continuing without it: ${
          (e as Error).message
        }`,
      );
      return [];
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Axis: sharing rules
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Sharing rules the principal is a TARGET of, resolved into ids and grouped
   * by module ('*' for rules that apply everywhere).
   *
   * What each source type contributes:
   *   - `user`     → those users' ids on the owner axis
   *   - `group`    → the members of those groups, likewise
   *   - `org_unit` → the unit ids on the ORG-UNIT axis, not an expanded user
   *     list: records already carry `orgUnitId`, so this is both cheaper and
   *     correct for a record whose owner has since moved elsewhere
   *   - `all`      → the axes drop entirely for that module
   *
   * Expired and inactive rules are skipped. Everything is validated against
   * tenant membership afterwards (H-08): settings are a lower trust boundary
   * than the authorization model, so an id written there must not be able to
   * name a principal from another workspace.
   */
  private async resolveSharingGrants(
    tenantId: string,
    userId: string,
    userRoles: string[],
    userGroupIds: string[],
  ): Promise<Map<string, SharingGrant>> {
    const byModule = new Map<string, SharingGrant>();
    try {
      const sharingRules =
        await this.settingsService.getSetting('sharing_rules');
      const rules = Array.isArray(sharingRules?.rules)
        ? sharingRules.rules
        : [];
      if (rules.length === 0) return byModule;

      const now = Date.now();
      const myRoleIds = await this.resolveUserRoleIds(tenantId, userId);
      const groupSet = new Set(userGroupIds.map(String));

      const applicable = rules.filter((rule: any) =>
        this.ruleTargetsPrincipal(rule, {
          now,
          userId,
          userRoles,
          myRoleIds,
          groupSet,
        }),
      );
      if (applicable.length === 0) return byModule;

      // Group members are the only source needing a lookup; batch every rule's
      // groups into one query rather than one per rule.
      const sourceGroupIds = union(
        applicable
          .filter((r: any) => r.sharedFrom?.type === 'group')
          .flatMap((r: any) => (r.sharedFrom?.ids ?? []).map(String)),
      );
      const membersByGroup = await this.loadGroupMemberIds(
        tenantId,
        sourceGroupIds,
      );

      for (const rule of applicable) {
        const key =
          typeof rule.module === 'string' && rule.module && rule.module !== '*'
            ? rule.module
            : '*';
        const current = byModule.get(key) ?? {
          ownerIds: [],
          orgUnitIds: [],
          all: false,
        };
        const source = rule.sharedFrom ?? {};
        const ids = (source.ids ?? []).map(String);

        if (source.type === 'all') current.all = true;
        else if (source.type === 'user') current.ownerIds.push(...ids);
        else if (source.type === 'group') {
          current.ownerIds.push(
            ...ids.flatMap((gid: string) => membersByGroup.get(gid) ?? []),
          );
        } else if (source.type === 'org_unit') current.orgUnitIds.push(...ids);

        byModule.set(key, current);
      }

      // Verify the owner ids once, across every rule.
      const allOwnerIds = [
        ...new Set([...byModule.values()].flatMap((grant) => grant.ownerIds)),
      ];
      const verified = new Set(
        await this.keepTenantMembers(tenantId, allOwnerIds),
      );
      for (const grant of byModule.values()) {
        grant.ownerIds = [...new Set(grant.ownerIds)].filter((id) =>
          verified.has(id),
        );
        grant.orgUnitIds = [...new Set(grant.orgUnitIds)];
      }

      return byModule;
    } catch (e) {
      // Fail-soft: sharing only widens, so losing it narrows — never leaks.
      this.logger.warn(
        `Sharing rules could not be resolved; continuing without them: ${
          (e as Error).message
        }`,
      );
      return new Map();
    }
  }

  /** Is this principal on the receiving end of the rule, and is it live? */
  private ruleTargetsPrincipal(
    rule: any,
    principal: {
      now: number;
      userId: string;
      userRoles: string[];
      myRoleIds: string[];
      groupSet: Set<string>;
    },
  ): boolean {
    if (!rule?.isActive) return false;

    if (rule.expiresAt) {
      const expiry = Date.parse(String(rule.expiresAt));
      // An unparseable expiry is treated as expired: a rule whose lifetime
      // cannot be read must not outlive it by defaulting to "forever".
      if (Number.isNaN(expiry) || expiry <= principal.now) return false;
    }

    const target = rule.shareWith ?? {};
    const ids = (target.ids ?? []).map(String);
    if (ids.length === 0) return false;

    if (target.type === 'user') return ids.includes(String(principal.userId));
    if (target.type === 'group')
      return ids.some((id: string) => principal.groupSet.has(id));
    if (target.type === 'role') {
      // Both vocabularies: built-in tenant roles are stored as names
      // ('admin', 'member'), custom roles as ObjectIds on the membership.
      return ids.some(
        (id: string) =>
          principal.userRoles.includes(id) || principal.myRoleIds.includes(id),
      );
    }
    return false;
  }

  /** Custom-role ids on the principal's membership in this tenant. */
  private async resolveUserRoleIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    try {
      const userRepo = this.moduleRef.get(UsersDocumentRepository, {
        strict: false,
      });
      if (!isValidObjectId(userId)) return [];
      const user: any = await userRepo.findById(userId);
      const membership = user?.tenants?.find(
        (t: any) => String(t.tenantId) === String(tenantId),
      );
      return (membership?.roleIds ?? []).map(String);
    } catch {
      return [];
    }
  }

  private async loadGroupMemberIds(
    tenantId: string,
    groupIds: string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (groupIds.length === 0) return map;
    try {
      const groupRepo = this.moduleRef.get(GroupRepository, { strict: false });
      for (const groupId of groupIds) {
        const members = await groupRepo.findMemberIdsForGroups(tenantId, [
          groupId,
        ]);
        map.set(groupId, (members ?? []).map(String));
      }
    } catch {
      // Widening-only axis: an unreadable group contributes nothing.
    }
    return map;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Shared lookups
  // ────────────────────────────────────────────────────────────────────────

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
   * Channels this principal may serve, or null when nothing restricts them.
   *
   * Fail-closed on error: an unresolvable channel policy returns `[]`, which
   * hides every conversation, rather than null, which would show all of them.
   * The outer catch already fails the request, but this method is also the
   * boundary that decides "restriction unknown" — and unknown must not mean
   * "unrestricted".
   */
  private async resolveServableChannelIds(
    tenantId: string,
    userId: string,
  ): Promise<string[] | null> {
    try {
      const support = this.moduleRef.get(ChannelSupportService, {
        strict: false,
      });
      return await support.listServableChannelIds(tenantId, userId);
    } catch (e) {
      this.logger.error(
        `Channel visibility resolution failed, fail-closed: ${(e as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Channels that explicitly override the tenant's data_visibility default
   * (M18), keyed by channel id. Deliberately NOT fail-soft like
   * resolveServableChannelIds above: defaulting to {} on error would make a
   * channel someone explicitly set to 'private' quietly inherit whatever the
   * tenant-wide default is instead — a widening failure. Errors propagate to
   * the outer catch, which fails the whole request closed.
   */
  private async resolveChannelVisibilityOverrides(
    tenantId: string,
  ): Promise<Record<string, 'private' | 'public_read'>> {
    const support = this.moduleRef.get(ChannelSupportService, {
      strict: false,
    });
    const overrides = await support.listVisibilityOverrides(tenantId);
    return Object.fromEntries(overrides);
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

/** Per-request state shared by every module computation. */
interface ScopeContext {
  tenantId: string;
  userId: string;
  userRoles: string[];
  userGroupIds: string[];
  roleScope: DataScope;
  orgUnitId: string | null;
  tenantDefaultScope: DataScope;
  defaultAccess: 'private' | 'public_read';
  byModuleSettings: Record<
    string,
    { access?: 'private' | 'public_read'; scope?: string } | undefined
  >;
  managedUnitsEnabled: boolean;
  /** Modules named by at least one applicable sharing rule. */
  moduleScopedGrantKeys: Set<string>;
  hierarchyIds: () => Promise<string[]>;
  scopeUnitIds: (scope: DataScope) => Promise<string[]>;
  managedUnitIds: () => Promise<string[]>;
  grants: () => Promise<Map<string, SharingGrant>>;
}

/** Union of id lists, de-duplicated, order-stable. */
function union(...lists: (string[] | undefined)[]): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []).map(String))];
}
