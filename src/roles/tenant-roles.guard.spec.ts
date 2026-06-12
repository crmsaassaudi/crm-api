import { TenantRolesGuard } from './tenant-roles.guard';
import { TenantRoleEnum } from './tenant-role.enum';
import { PlatformRoleEnum } from './platform-role.enum';
import { createUser } from '../test/factories/user.factory';
import { createClsMock } from '../test/mocks/cls.mock';

describe('TenantRolesGuard', () => {
  let guard: TenantRolesGuard;
  let reflector: any;
  let usersService: any;
  let cls: ReturnType<typeof createClsMock>;

  const createContext = (roles: TenantRoleEnum[], userPayload: any = { sub: 'kc_user_1' }) => {
    const request: any = { user: userPayload };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getClass: () => ({ name: 'TestController' }),
      getHandler: () => ({ name: 'testMethod' }),
    } as any;

    reflector.getAllAndOverride.mockReturnValue(roles.length > 0 ? roles : undefined);
    return context;
  };

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    };
    usersService = {
      findByKeycloakIdAndProvider: jest.fn(),
    };
    cls = createClsMock();
    guard = new TenantRolesGuard(reflector, usersService, cls as any);
  });

  // ═══════════════════════════════════════════════════════════════════
  // NO REQUIRED ROLES — allow all
  // ═══════════════════════════════════════════════════════════════════
  it('should allow access when no roles are required', async () => {
    const context = createContext([]);
    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════
  // NO USER PAYLOAD — deny
  // ═══════════════════════════════════════════════════════════════════
  it('should deny access when no user in request', async () => {
    const context = createContext([TenantRoleEnum.ADMIN], null);
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });

  it('should deny access when user payload has no sub', async () => {
    const context = createContext([TenantRoleEnum.ADMIN], { email: 'test@test.com' });
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // USER NOT FOUND — deny
  // ═══════════════════════════════════════════════════════════════════
  it('should deny access when user is not found in database', async () => {
    usersService.findByKeycloakIdAndProvider.mockResolvedValue(null);
    const context = createContext([TenantRoleEnum.ADMIN]);
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // SUPER_ADMIN BYPASS
  // ═══════════════════════════════════════════════════════════════════
  it('should allow SUPER_ADMIN to bypass tenant role check', async () => {
    usersService.findByKeycloakIdAndProvider.mockResolvedValue(
      createUser({
        platformRole: { id: PlatformRoleEnum.SUPER_ADMIN },
        tenants: [], // No membership needed
      }),
    );
    const context = createContext([TenantRoleEnum.OWNER]);
    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════
  // TENANT ISOLATION — no tenantId in CLS
  // ═══════════════════════════════════════════════════════════════════
  it('should deny when no tenantId in CLS context', async () => {
    cls.get = jest.fn(() => undefined);
    usersService.findByKeycloakIdAndProvider.mockResolvedValue(
      createUser({ platformRole: null }),
    );
    const context = createContext([TenantRoleEnum.MEMBER]);
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // TENANT ISOLATION — no membership in tenant
  // ═══════════════════════════════════════════════════════════════════
  it('should deny when user has no membership in current tenant', async () => {
    usersService.findByKeycloakIdAndProvider.mockResolvedValue(
      createUser({
        platformRole: null,
        tenants: [{ tenantId: 'OTHER_TENANT', roles: ['ADMIN'] }],
      }),
    );
    const context = createContext([TenantRoleEnum.ADMIN]);
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // ROLE MATCHING
  // ═══════════════════════════════════════════════════════════════════
  it('should allow when user role matches required role', async () => {
    usersService.findByKeycloakIdAndProvider.mockResolvedValue(
      createUser({
        platformRole: null,
        tenants: [{ tenantId: 'tenant_1', roles: ['ADMIN'] }],
      }),
    );
    const context = createContext([TenantRoleEnum.ADMIN]);
    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('should allow when user has one of multiple required roles', async () => {
    usersService.findByKeycloakIdAndProvider.mockResolvedValue(
      createUser({
        platformRole: null,
        tenants: [{ tenantId: 'tenant_1', roles: ['MEMBER'] }],
      }),
    );
    const context = createContext([TenantRoleEnum.ADMIN, TenantRoleEnum.MEMBER]);
    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('should deny when user role does not match any required role', async () => {
    usersService.findByKeycloakIdAndProvider.mockResolvedValue(
      createUser({
        platformRole: null,
        tenants: [{ tenantId: 'tenant_1', roles: ['VIEWER'] }],
      }),
    );
    const context = createContext([TenantRoleEnum.ADMIN, TenantRoleEnum.OWNER]);
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // CROSS-TENANT ISOLATION — user in tenant_2 cannot access tenant_1
  // ═══════════════════════════════════════════════════════════════════
  it('should deny cross-tenant access even with correct role in other tenant', async () => {
    usersService.findByKeycloakIdAndProvider.mockResolvedValue(
      createUser({
        platformRole: null,
        tenants: [
          { tenantId: 'tenant_2', roles: ['ADMIN'] },
          // No membership in tenant_1
        ],
      }),
    );
    const context = createContext([TenantRoleEnum.ADMIN]);
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });
});
