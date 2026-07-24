import { ModuleRef } from '@nestjs/core';
import { AuthorizationService } from './authorization.service';
import { AuthzPermissionCacheService } from './authz-permission-cache.service';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import { TenantsRepository } from '../../tenants/infrastructure/persistence/document/repositories/tenant.repository';
import { GroupRepository } from '../../groups/infrastructure/persistence/document/repositories/group.repository';
import { CustomRolesService } from './custom-roles.service';
import { RoleAssignmentService } from './role-assignment.service';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';

/**
 * Authorization integration — wires the REAL PDP end-to-end:
 *   AuthorizationService → AuthzPermissionCacheService (real) → engine (real)
 * with only Redis + repositories mocked at the boundary. This proves the
 * decision chain, not each unit in isolation:
 *   - a member resolves permissions from a tenant custom role (RBAC expansion)
 *   - a deactivated user is denied even with matching roles / super-admin
 *   - platform super-admin needs BOTH a claim AND DB confirmation (C5)
 *   - an unknown / cross-tenant roleId fails safe (no permissions)
 */
describe('Authorization PDP (integration)', () => {
  const tenantId = '507f1f77bcf86cd799439011';
  const userId = '507f1f77bcf86cd799439012';
  const salesRoleId = '507f1f77bcf86cd799439099';
  const editorRoleId = '507f1f77bcf86cd799439088';

  let redisClient: any;
  let userRepository: any;
  let tenantsRepository: any;
  let groupRepository: any;
  let customRolesService: any;
  let roleAssignmentService: any;
  let cache: AuthzPermissionCacheService;
  let authz: AuthorizationService;

  const buildUser = (overrides: any = {}) => ({
    id: userId,
    email: 'agent@example.com',
    tenants: [{ tenantId, roles: [], roleIds: [salesRoleId], joinedAt: new Date() }],
    ...overrides,
  });

  beforeEach(() => {
    const pipeline = {
      del: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    // In-memory Redis: never a cache hit, capture what gets populated.
    redisClient = {
      exists: jest.fn().mockResolvedValue(0),
      sismember: jest.fn().mockResolvedValue(0),
      del: jest.fn().mockResolvedValue(1),
      pipeline: jest.fn().mockReturnValue(pipeline),
      scan: jest.fn().mockResolvedValue(['0', []]),
    };

    userRepository = {
      findByIdsGlobal: jest.fn().mockResolvedValue([buildUser()]),
      findByKeycloakIdAndProvider: jest.fn(),
    };
    tenantsRepository = {
      findById: jest.fn().mockResolvedValue({
        id: tenantId,
        ownerId: 'owner_1',
        availablePermissions: ['contacts:view', 'contacts:edit'],
        disabledCorePermissions: [],
      }),
      findByAlias: jest.fn(),
      findByKeycloakOrgId: jest.fn(),
    };
    groupRepository = {
      findGroupsByMemberWithAncestors: jest.fn().mockResolvedValue([]),
    };
    // The tenant owns a "Sales" custom role that grants contacts:view and an
    // "Editor" role that grants contacts:edit (used by the JIT test).
    customRolesService = {
      findAll: jest.fn().mockResolvedValue([
        { _id: salesRoleId, permissions: ['contacts:view'] },
        { _id: editorRoleId, permissions: ['contacts:edit'] },
      ]),
    };
    // No active grants by default.
    roleAssignmentService = {
      activeRoleIdsForPrincipals: jest.fn().mockResolvedValue([]),
    };

    const moduleRef = {
      get: jest.fn((token) => {
        if (token === UserRepository) return userRepository;
        if (token === TenantsRepository) return tenantsRepository;
        if (token === GroupRepository) return groupRepository;
        if (token === CustomRolesService) return customRolesService;
        if (token === RoleAssignmentService) return roleAssignmentService;
        return null;
      }),
    } as unknown as ModuleRef;

    cache = new AuthzPermissionCacheService(
      moduleRef,
      { getClient: () => redisClient } as any,
      { set: jest.fn() } as any,
    );

    const objectAcl = { can: jest.fn().mockResolvedValue(null) } as any;
    const accessPolicy = { evaluate: jest.fn().mockResolvedValue(null) } as any;
    authz = new AuthorizationService(cache, objectAcl, accessPolicy);
  });

  it('grants a member access via a tenant custom-role reference (RBAC expansion)', async () => {
    const decision = await authz.canPerformAction({
      rule: { action: 'view', resource: 'contacts' },
      rawUserId: userId,
      tenantHint: tenantId,
      claims: {},
    });

    expect(decision.allowed).toBe(true);
    expect(decision.superAdmin).toBeUndefined();
    expect(customRolesService.findAll).toHaveBeenCalledWith(tenantId);
  });

  it('denies an action the resolved role does not grant', async () => {
    const decision = await authz.canPerformAction({
      rule: { action: 'edit', resource: 'contacts' },
      rawUserId: userId,
      tenantHint: tenantId,
      claims: {},
    });

    expect(decision.allowed).toBe(false);
  });

  it('denies a DEACTIVATED user even though their role grants the action', async () => {
    userRepository.findByIdsGlobal.mockResolvedValue([
      buildUser({ status: { id: 'inactive' } }),
    ]);

    const decision = await authz.canPerformAction({
      rule: { action: 'view', resource: 'contacts' },
      rawUserId: userId,
      tenantHint: tenantId,
      claims: {},
    });

    expect(decision.allowed).toBe(false);
    expect(decision.denyReason).toBe('user_inactive');
  });

  it('grants platform super-admin only with BOTH claim and DB confirmation (C5)', async () => {
    userRepository.findByIdsGlobal.mockResolvedValue([
      buildUser({ platformRole: { id: PlatformRoleEnum.SUPER_ADMIN } }),
    ]);

    const decision = await authz.canPerformAction({
      rule: { action: 'view', resource: 'contacts' },
      rawUserId: userId,
      tenantHint: tenantId,
      claims: { realm_access: { roles: [PlatformRoleEnum.SUPER_ADMIN] } },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.superAdmin).toBe(true);
  });

  it('rejects a forged super-admin CLAIM when the DB says the user is not one (C5)', async () => {
    // platformRole stays USER in the DB; only the (untrusted) token claims it.
    userRepository.findByIdsGlobal.mockResolvedValue([
      buildUser({ platformRole: { id: PlatformRoleEnum.USER }, tenants: [] }),
    ]);

    const decision = await authz.canPerformAction({
      rule: { action: 'view', resource: 'contacts' },
      rawUserId: userId,
      tenantHint: tenantId,
      claims: { realm_access: { roles: [PlatformRoleEnum.SUPER_ADMIN] } },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.superAdmin).toBeUndefined();
  });

  it('denies a DEACTIVATED super-admin (status wins over platformRole)', async () => {
    userRepository.findByIdsGlobal.mockResolvedValue([
      buildUser({
        platformRole: { id: PlatformRoleEnum.SUPER_ADMIN },
        status: { id: 'inactive' },
      }),
    ]);

    const decision = await authz.canPerformAction({
      rule: { action: 'view', resource: 'contacts' },
      rawUserId: userId,
      tenantHint: tenantId,
      claims: { realm_access: { roles: [PlatformRoleEnum.SUPER_ADMIN] } },
    });

    expect(decision.allowed).toBe(false);
  });

  it('fails safe when a membership references an unknown / cross-tenant roleId', async () => {
    userRepository.findByIdsGlobal.mockResolvedValue([
      buildUser({
        tenants: [
          { tenantId, roles: [], roleIds: ['deadbeefdeadbeefdeadbeef'], joinedAt: new Date() },
        ],
      }),
    ]);

    const decision = await authz.canPerformAction({
      rule: { action: 'view', resource: 'contacts' },
      rawUserId: userId,
      tenantHint: tenantId,
      claims: {},
    });

    // Unknown role → no permissions expanded → denied. No escalation.
    expect(decision.allowed).toBe(false);
  });

  it('grants access via an active JIT role assignment on top of standing roles', async () => {
    // Standing role only grants view; an active grant of the Editor role adds edit.
    roleAssignmentService.activeRoleIdsForPrincipals.mockResolvedValue([
      editorRoleId,
    ]);

    const decision = await authz.canPerformAction({
      rule: { action: 'edit', resource: 'contacts' },
      rawUserId: userId,
      tenantHint: tenantId,
      claims: {},
    });

    expect(decision.allowed).toBe(true);
    expect(
      roleAssignmentService.activeRoleIdsForPrincipals,
    ).toHaveBeenCalledWith(tenantId, expect.arrayContaining([userId]), expect.any(Date));
  });

  it('denies once the JIT assignment has lapsed (no active grants returned)', async () => {
    // Expired/revoked grants are filtered by the service → empty here.
    roleAssignmentService.activeRoleIdsForPrincipals.mockResolvedValue([]);

    const decision = await authz.canPerformAction({
      rule: { action: 'edit', resource: 'contacts' },
      rawUserId: userId,
      tenantHint: tenantId,
      claims: {},
    });

    expect(decision.allowed).toBe(false);
  });
});
