import {
  CallHandler,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { DataVisibilityInterceptor } from './data-visibility.interceptor';
import { TenantRoleEnum } from '../roles/tenant-role.enum';
import { DataScope } from '../common/permissions/data-scope.enum';
import { AuthzPermissionCacheService } from '../common/permissions/authz-permission-cache.service';
import { OrgUnitsService } from '../org-units/org-units.service';
import { UsersDocumentRepository } from '../users/infrastructure/persistence/document/repositories/user.repository';
import { GroupRepository } from '../groups/infrastructure/persistence/document/repositories/group.repository';
import { ChannelSupportService } from '../channels/services/channel-support.service';

const USER = '507f1f77bcf86cd799439011';
const SUBORDINATE = '507f1f77bcf86cd799439022';

describe('DataVisibilityInterceptor', () => {
  let cls: { get: jest.Mock; set: jest.Mock };
  let hierarchyService: { getVisibleOwnerIds: jest.Mock };
  let settingsService: { getSetting: jest.Mock };
  let userRepository: { findById: jest.Mock; findByIds: jest.Mock };
  let groupRepository: { findGroupsByMember: jest.Mock };
  let authzCache: { resolveDataScope: jest.Mock; canAccess: jest.Mock };
  let orgUnits: {
    resolveScopeUnitIds: jest.Mock;
    listManagedUnitIds: jest.Mock;
  };
  let channelSupport: {
    listServableChannelIds: jest.Mock;
    listVisibilityOverrides: jest.Mock;
  };
  let moduleRef: { get: jest.Mock };
  let interceptor: DataVisibilityInterceptor;

  /** What CLS ended up holding for a key, or undefined if never written. */
  const written = (key: string): unknown => {
    const calls = cls.set.mock.calls.filter(([k]) => k === key);
    return calls.length ? calls[calls.length - 1][1] : undefined;
  };

  const run = () =>
    lastValueFrom(interceptor.intercept(createContext(), createHandler()));

  beforeEach(() => {
    cls = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          tenantId: 'tenant_1',
          userId: USER,
        };
        return values[key];
      }),
      set: jest.fn(),
    };
    hierarchyService = {
      getVisibleOwnerIds: jest.fn().mockResolvedValue([USER, SUBORDINATE]),
    };
    settingsService = {
      getSetting: jest.fn().mockResolvedValue({ defaultAccess: 'private' }),
    };
    userRepository = {
      findById: jest.fn().mockResolvedValue({
        tenants: [{ tenantId: 'tenant_1', roles: [TenantRoleEnum.MEMBER] }],
      }),
      findByIds: jest.fn().mockResolvedValue([]),
    };
    groupRepository = {
      findGroupsByMember: jest.fn().mockResolvedValue([{ id: 'g1' }]),
    };
    authzCache = {
      resolveDataScope: jest
        .fn()
        .mockResolvedValue({ scope: DataScope.SELF, orgUnitId: 'unit_b' }),
      canAccess: jest.fn().mockResolvedValue({ allowed: false }),
    };
    orgUnits = {
      resolveScopeUnitIds: jest.fn().mockResolvedValue([]),
      listManagedUnitIds: jest.fn().mockResolvedValue([]),
    };
    channelSupport = {
      listServableChannelIds: jest.fn().mockResolvedValue(null),
      listVisibilityOverrides: jest.fn().mockResolvedValue(new Map()),
    };

    // Dispatch on the requested token — the interceptor resolves five different
    // providers lazily through the same ModuleRef.
    moduleRef = {
      get: jest.fn((token: unknown) => {
        if (token === AuthzPermissionCacheService) return authzCache;
        if (token === OrgUnitsService) return orgUnits;
        if (token === UsersDocumentRepository) return userRepository;
        if (token === GroupRepository) return groupRepository;
        if (token === ChannelSupportService) return channelSupport;
        throw new Error(`Unexpected provider requested: ${String(token)}`);
      }),
    };

    interceptor = new DataVisibilityInterceptor(
      cls as any,
      hierarchyService as any,
      settingsService as any,
      moduleRef as any,
    );
  });

  describe('early exits', () => {
    it('should fail closed when visibility resolution fails', async () => {
      settingsService.getSetting.mockRejectedValueOnce(new Error('db timeout'));

      await expect(run()).rejects.toBeInstanceOf(InternalServerErrorException);

      expect(written('visibleOwnerIds')).toEqual([]);
      // Both axes must close. Leaving the org-unit axis unset would be harmless
      // today (undefined adds no clause) but the pair should never diverge.
      expect(written('visibleOrgUnitIds')).toEqual([]);
    });

    it('should keep admin bypass explicit on both axes', async () => {
      userRepository.findById.mockResolvedValue({
        tenants: [{ tenantId: 'tenant_1', roles: [TenantRoleEnum.ADMIN] }],
      });

      await expect(run()).resolves.toEqual({ ok: true });

      expect(written('visibleOwnerIds')).toBeNull();
      expect(written('visibleOrgUnitIds')).toBeNull();
      expect(hierarchyService.getVisibleOwnerIds).not.toHaveBeenCalled();
    });

    it('should open both axes for a public_read tenant', async () => {
      settingsService.getSetting.mockResolvedValue({
        defaultAccess: 'public_read',
      });

      await run();

      expect(written('visibleOwnerIds')).toBeNull();
      expect(written('visibleOrgUnitIds')).toBeNull();
    });

    it('should skip entirely without tenant or user context', async () => {
      cls.get.mockReturnValue(undefined);
      await run();
      expect(cls.set).not.toHaveBeenCalled();
    });
  });

  describe('scope → CLS translation', () => {
    it('should restrict SELF to the principal alone, ignoring the hierarchy', async () => {
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SELF,
        orgUnitId: 'unit_b',
      });
      settingsService.getSetting.mockResolvedValue({
        defaultAccess: 'private',
        defaultScope: DataScope.SELF,
      });

      await run();

      expect(written('visibleOwnerIds')).toEqual([USER]);
      expect(hierarchyService.getVisibleOwnerIds).not.toHaveBeenCalled();
      expect(written('visibleOrgUnitIds')).toEqual([]);
    });

    it('should follow the reportsToId chain for SUBORDINATES', async () => {
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SUBORDINATES,
        orgUnitId: 'unit_b',
      });

      await run();

      expect(written('visibleOwnerIds')).toEqual([USER, SUBORDINATE]);
      expect(written('visibleOrgUnitIds')).toEqual([]);
    });

    it('should add the own unit for ORG_UNIT and KEEP the owner axis', async () => {
      // The union is the point. A manager must not lose sight of a subordinate
      // who sits in a different unit just because a unit filter was added.
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.ORG_UNIT,
        orgUnitId: 'unit_b',
      });
      orgUnits.resolveScopeUnitIds.mockResolvedValue(['unit_b']);

      await run();

      expect(written('visibleOwnerIds')).toEqual([USER, SUBORDINATE]);
      expect(written('visibleOrgUnitIds')).toEqual(['unit_b']);
      expect(orgUnits.resolveScopeUnitIds).toHaveBeenCalledWith(
        'tenant_1',
        'unit_b',
        DataScope.ORG_UNIT,
      );
    });

    it('should add the whole subtree for ORG_UNIT_SUBTREE', async () => {
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.ORG_UNIT_SUBTREE,
        orgUnitId: 'unit_b',
      });
      orgUnits.resolveScopeUnitIds.mockResolvedValue(['unit_b', 'unit_t']);

      await run();

      expect(written('visibleOrgUnitIds')).toEqual(['unit_b', 'unit_t']);
    });

    it('should drop the owner filter for TENANT without touching the tenant boundary', async () => {
      // TENANT is the old "Organization" scope. It removes the owner restriction
      // and nothing else — tenantFilterPlugin still runs underneath.
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.TENANT,
        orgUnitId: 'unit_b',
      });

      await run();

      expect(written('visibleOwnerIds')).toBeNull();
      expect(written('visibleOrgUnitIds')).toBeNull();
      expect(orgUnits.resolveScopeUnitIds).not.toHaveBeenCalled();
      // Group scoping still has to be populated on this path — omni
      // conversations are scoped by assigned group, not by owner.
      expect(written('visibleGroupIds')).toEqual(['g1']);
    });

    it('should contribute NO unit ids for an unassigned user under a unit scope', async () => {
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.ORG_UNIT_SUBTREE,
        orgUnitId: null,
      });
      orgUnits.resolveScopeUnitIds.mockResolvedValue([]);

      await run();

      // Owner-scoped only. An empty unit list must not be read as "no filter".
      expect(written('visibleOwnerIds')).toEqual([USER, SUBORDINATE]);
      expect(written('visibleOrgUnitIds')).toEqual([]);
    });
  });

  describe('tenant default scope', () => {
    it('should default to SUBORDINATES when the tenant configures nothing', async () => {
      // The pre-H-07 contract. If an unset scope resolved to SELF instead, every
      // existing role in every tenant would silently narrow on deploy and users
      // would open the app to an empty list.
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SELF,
        orgUnitId: null,
      });
      settingsService.getSetting.mockResolvedValue({
        defaultAccess: 'private',
      });

      await run();

      expect(written('visibleOwnerIds')).toEqual([USER, SUBORDINATE]);
    });

    it('should let the tenant default WIDEN a role that expresses none', async () => {
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SELF,
        orgUnitId: 'unit_b',
      });
      settingsService.getSetting.mockResolvedValue({
        defaultAccess: 'private',
        defaultScope: DataScope.ORG_UNIT,
      });
      orgUnits.resolveScopeUnitIds.mockResolvedValue(['unit_b']);

      await run();

      expect(written('visibleOrgUnitIds')).toEqual(['unit_b']);
    });

    it('should NOT let the tenant default narrow a wider role', async () => {
      // maxScope is a union: configuring a narrow tenant default must not claw
      // back scope a role explicitly grants, or adding a default would silently
      // demote every manager.
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.ORG_UNIT_SUBTREE,
        orgUnitId: 'unit_b',
      });
      settingsService.getSetting.mockResolvedValue({
        defaultAccess: 'private',
        defaultScope: DataScope.SELF,
      });
      orgUnits.resolveScopeUnitIds.mockResolvedValue(['unit_b', 'unit_t']);

      await run();

      expect(orgUnits.resolveScopeUnitIds).toHaveBeenCalledWith(
        'tenant_1',
        'unit_b',
        DataScope.ORG_UNIT_SUBTREE,
      );
    });

    it('should IGNORE a malformed configured default rather than fail or widen', async () => {
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SELF,
        orgUnitId: null,
      });
      settingsService.getSetting.mockResolvedValue({
        defaultAccess: 'private',
        defaultScope: 'organization', // a removed level someone might still type
      });

      await run();

      // Falls back to SUBORDINATES, not to TENANT.
      expect(written('visibleOwnerIds')).toEqual([USER, SUBORDINATE]);
    });
  });

  describe('M18: per-channel visibility overrides', () => {
    it('should compute the strict scope under a public_read tenant when a channel forces private', async () => {
      settingsService.getSetting.mockResolvedValue({
        defaultAccess: 'public_read',
      });
      channelSupport.listVisibilityOverrides.mockResolvedValue(
        new Map([['ch_private', 'private']]),
      );
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SUBORDINATES,
        orgUnitId: null,
      });

      await run();

      // The tenant-wide axes still bypass everyone...
      expect(written('visibleOwnerIds')).toBeNull();
      expect(written('visibleOrgUnitIds')).toBeNull();
      // ...but the strict scope is computed and stashed for the repository to
      // apply just to ch_private.
      expect(written('strictOwnerIds')).toEqual([USER, SUBORDINATE]);
      expect(written('channelVisibilityOverrides')).toEqual({
        ch_private: 'private',
      });
    });

    it('should not pay for the strict scope when no channel overrides to private', async () => {
      settingsService.getSetting.mockResolvedValue({
        defaultAccess: 'public_read',
      });
      channelSupport.listVisibilityOverrides.mockResolvedValue(
        new Map([['ch_public', 'public_read']]),
      );

      await run();

      expect(hierarchyService.getVisibleOwnerIds).not.toHaveBeenCalled();
      expect(written('strictOwnerIds')).toBeUndefined();
      expect(written('channelVisibilityOverrides')).toEqual({
        ch_public: 'public_read',
      });
    });

    it('should reuse the scoped result as the strict result under a private tenant default', async () => {
      channelSupport.listVisibilityOverrides.mockResolvedValue(
        new Map([['ch_private', 'private']]),
      );
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SUBORDINATES,
        orgUnitId: null,
      });

      await run();

      expect(written('visibleOwnerIds')).toEqual([USER, SUBORDINATE]);
      expect(written('strictOwnerIds')).toEqual([USER, SUBORDINATE]);
    });

    it('should fail the whole request closed if overrides cannot be resolved, rather than defaulting to none', async () => {
      channelSupport.listVisibilityOverrides.mockRejectedValueOnce(
        new Error('cache miss'),
      );

      await expect(run()).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(written('visibleOwnerIds')).toEqual([]);
      expect(written('channelVisibilityOverrides')).toEqual({});
    });

    it('should have admin bypass ignore overrides entirely', async () => {
      userRepository.findById.mockResolvedValue({
        tenants: [{ tenantId: 'tenant_1', roles: [TenantRoleEnum.ADMIN] }],
      });
      channelSupport.listVisibilityOverrides.mockResolvedValue(
        new Map([['ch_private', 'private']]),
      );

      await run();

      expect(channelSupport.listVisibilityOverrides).not.toHaveBeenCalled();
      expect(written('visibleOwnerIds')).toBeNull();
    });
  });

  describe('all_data:view — full read without being an admin', () => {
    it('should bypass every axis for a role that grants it', async () => {
      authzCache.canAccess.mockResolvedValue({ allowed: true });

      await run();

      expect(written('visibleOwnerIds')).toBeNull();
      expect(written('visibleOrgUnitIds')).toBeNull();
      expect(written('servableChannelIds')).toBeNull();
      // Group membership is still resolved — an auditor can also be in a team.
      expect(written('visibleGroupIds')).toEqual(['g1']);
    });

    it('should stay scoped when the permission check itself fails', async () => {
      // Fail-soft must mean "no bypass", never "bypass".
      authzCache.canAccess.mockRejectedValue(new Error('redis down'));

      await run();

      expect(written('visibleOwnerIds')).toEqual([USER, SUBORDINATE]);
    });
  });

  describe('managed org units', () => {
    it('should union the units a principal manages into the org-unit axis', async () => {
      // The point of the axis: a SELF-scoped co-manager still sees their desks.
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SELF,
        orgUnitId: null,
      });
      settingsService.getSetting.mockResolvedValue({
        defaultAccess: 'private',
        defaultScope: DataScope.SELF,
      });
      orgUnits.listManagedUnitIds.mockResolvedValue(['unit_x', 'unit_x_child']);

      await run();

      expect(written('visibleOwnerIds')).toEqual([USER]);
      expect(written('visibleOrgUnitIds')).toEqual(['unit_x', 'unit_x_child']);
    });

    it('should honour the tenant switch that turns the axis off', async () => {
      settingsService.getSetting.mockResolvedValue({
        defaultAccess: 'private',
        defaultScope: DataScope.SELF,
        managedUnitsEnabled: false,
      });
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SELF,
        orgUnitId: null,
      });
      orgUnits.listManagedUnitIds.mockResolvedValue(['unit_x']);

      await run();

      expect(written('visibleOrgUnitIds')).toEqual([]);
    });

    it('should widen rather than fail when the org tree cannot be read', async () => {
      orgUnits.listManagedUnitIds.mockRejectedValue(new Error('mongo down'));

      await expect(run()).resolves.toEqual({ ok: true });
      expect(written('visibleOwnerIds')).toEqual([USER, SUBORDINATE]);
    });
  });

  describe('per-module overrides', () => {
    const settingsFor = (byModule: Record<string, unknown>) =>
      settingsService.getSetting.mockImplementation((key: string) =>
        key === 'data_visibility'
          ? { defaultAccess: 'private', defaultScope: DataScope.SELF, byModule }
          : { rules: [] },
      );

    it('should emit an entry only for modules the tenant configured', async () => {
      settingsFor({ Ticket: { access: 'public_read' } });
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SELF,
        orgUnitId: null,
      });

      await run();

      const byModule = written('dataVisibilityByModule') as Record<string, any>;
      expect(Object.keys(byModule)).toEqual(['Ticket']);
      expect(byModule.Ticket).toEqual({ ownerIds: null, orgUnitIds: null });
      // The tenant-wide pair is untouched by a module override.
      expect(written('visibleOwnerIds')).toEqual([USER]);
    });

    it('should let one module be WIDER in scope than the tenant default', async () => {
      settingsFor({ Deal: { scope: DataScope.SUBORDINATES } });
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SELF,
        orgUnitId: null,
      });

      await run();

      const byModule = written('dataVisibilityByModule') as Record<string, any>;
      expect(byModule.Deal.ownerIds).toEqual([USER, SUBORDINATE]);
      expect(written('visibleOwnerIds')).toEqual([USER]);
    });
  });

  describe('sharing rules', () => {
    const OTHER = '507f1f77bcf86cd799439033';

    const withRules = (rules: unknown[]) =>
      settingsService.getSetting.mockImplementation((key: string) =>
        key === 'sharing_rules'
          ? { rules }
          : { defaultAccess: 'private', defaultScope: DataScope.SELF },
      );

    beforeEach(() => {
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.SELF,
        orgUnitId: null,
      });
      userRepository.findByIds.mockResolvedValue([
        { id: OTHER, tenants: [{ tenantId: 'tenant_1' }] },
      ]);
    });

    it('should add the shared owner to the axis of the named module only', async () => {
      withRules([
        {
          id: 'r1',
          isActive: true,
          module: 'Deal',
          sharedFrom: { type: 'user', ids: [OTHER] },
          shareWith: { type: 'user', ids: [USER] },
        },
      ]);

      await run();

      const byModule = written('dataVisibilityByModule') as Record<string, any>;
      expect(byModule.Deal.ownerIds).toEqual([USER, OTHER]);
      // The module was named, so Contact must NOT be widened — the bug the old
      // implementation had, where `module` was stored and then ignored.
      expect(written('visibleOwnerIds')).toEqual([USER]);
    });

    it('should apply a wildcard rule to the tenant-wide axis', async () => {
      withRules([
        {
          id: 'r1',
          isActive: true,
          module: '*',
          sharedFrom: { type: 'user', ids: [OTHER] },
          shareWith: { type: 'group', ids: ['g1'] },
        },
      ]);

      await run();

      expect(written('visibleOwnerIds')).toEqual([USER, OTHER]);
    });

    it('should ignore an expired rule', async () => {
      withRules([
        {
          id: 'r1',
          isActive: true,
          module: '*',
          expiresAt: '2020-01-01T00:00:00.000Z',
          sharedFrom: { type: 'user', ids: [OTHER] },
          shareWith: { type: 'user', ids: [USER] },
        },
      ]);

      await run();

      expect(written('visibleOwnerIds')).toEqual([USER]);
    });

    it('should ignore a shared id that is not a member of the tenant', async () => {
      // H-08: settings are a lower trust boundary than the authz model.
      userRepository.findByIds.mockResolvedValue([
        { id: OTHER, tenants: [{ tenantId: 'other_tenant' }] },
      ]);
      withRules([
        {
          id: 'r1',
          isActive: true,
          module: '*',
          sharedFrom: { type: 'user', ids: [OTHER] },
          shareWith: { type: 'user', ids: [USER] },
        },
      ]);

      await run();

      expect(written('visibleOwnerIds')).toEqual([USER]);
    });

    it('should put an org_unit source on the org-unit axis, not the owner axis', async () => {
      withRules([
        {
          id: 'r1',
          isActive: true,
          module: '*',
          sharedFrom: { type: 'org_unit', ids: ['unit_z'] },
          shareWith: { type: 'user', ids: [USER] },
        },
      ]);

      await run();

      expect(written('visibleOwnerIds')).toEqual([USER]);
      expect(written('visibleOrgUnitIds')).toEqual(['unit_z']);
    });

    it('should drop the axes entirely for an "all records" rule', async () => {
      withRules([
        {
          id: 'r1',
          isActive: true,
          module: '*',
          sharedFrom: { type: 'all' },
          shareWith: { type: 'user', ids: [USER] },
        },
      ]);

      await run();

      expect(written('visibleOwnerIds')).toBeNull();
    });
  });

  function createContext(): ExecutionContext {
    return {} as ExecutionContext;
  }

  function createHandler(): CallHandler {
    return {
      handle: jest.fn(() => of({ ok: true })),
    };
  }
});
