import { PermissionGuard } from './permission.guard';

import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import { createClsMock } from '../../test/mocks/cls.mock';

describe('PermissionGuard', () => {
  let guard: PermissionGuard;
  let reflector: any;
  let authzCache: any;
  let cls: ReturnType<typeof createClsMock>;

  const createContext = (userPayload: any = {}) => {
    const request: any = {
      user: userPayload,
      method: 'GET',
      originalUrl: '/api/contacts',
      headers: {},
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getClass: () => ({ name: 'ContactsController' }),
      getHandler: () => ({ name: 'findAll' }),
      request,
    } as any;
  };

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    };
    authzCache = {
      canAccess: jest.fn(),
    };
    cls = createClsMock();
    guard = new PermissionGuard(reflector, authzCache, cls as any);
  });

  // ═══════════════════════════════════════════════════════════════════
  // NO METADATA — public route
  // ═══════════════════════════════════════════════════════════════════
  it('should allow access when no permission metadata is defined', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    const context = createContext({ sub: 'user_1' });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authzCache.canAccess).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════════
  // MISSING USER — deny
  // ═══════════════════════════════════════════════════════════════════
  it('should deny access when user payload is missing', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'view',
      resource: 'contacts',
    });
    // Override CLS to have no userId
    cls.get = jest.fn(() => undefined);

    const context = createContext(null);
    const result = await guard.canActivate(context);

    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // SUPER_ADMIN BYPASS
  // ═══════════════════════════════════════════════════════════════════
  it('should bypass permission check for SUPER_ADMIN via realm_access', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'delete',
      resource: 'contacts',
    });

    const context = createContext({
      sub: 'user_super',
      userId: 'user_super',
      realm_access: { roles: [PlatformRoleEnum.SUPER_ADMIN] },
    });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authzCache.canAccess).not.toHaveBeenCalled();
  });

  it('should bypass permission check for SUPER_ADMIN via roles array', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'delete',
      resource: 'contacts',
    });

    const context = createContext({
      sub: 'user_super',
      userId: 'user_super',
      roles: [PlatformRoleEnum.SUPER_ADMIN],
    });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════
  // NORMAL USER — permission granted
  // ═══════════════════════════════════════════════════════════════════
  it('should allow access when authzCache returns allowed=true', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'view',
      resource: 'contacts',
    });
    authzCache.canAccess.mockResolvedValue({
      allowed: true,
      userId: 'user_1',
      tenantId: 'tenant_1',
      email: 'test@example.com',
      cacheHit: false,
    });

    const context = createContext({ sub: 'user_1' });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authzCache.canAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        rawUserId: 'user_1',
        rule: { action: 'view', resource: 'contacts' },
      }),
    );
  });

  it('should set CLS context when permission is granted', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'view',
      resource: 'contacts',
    });
    authzCache.canAccess.mockResolvedValue({
      allowed: true,
      userId: 'user_1',
      tenantId: 'tenant_1',
      email: 'test@example.com',
      cacheHit: false,
    });

    const context = createContext({ sub: 'user_1' });
    await guard.canActivate(context);

    expect(cls.set).toHaveBeenCalledWith('userId', 'user_1');
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant_1');
    expect(cls.set).toHaveBeenCalledWith('activeTenantId', 'tenant_1');
  });

  // ═══════════════════════════════════════════════════════════════════
  // NORMAL USER — permission denied
  // ═══════════════════════════════════════════════════════════════════
  it('should deny access when authzCache returns allowed=false', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'delete',
      resource: 'contacts',
    });
    authzCache.canAccess.mockResolvedValue({
      allowed: false,
      userId: 'user_1',
      tenantId: 'tenant_1',
      cacheHit: false,
      denyReason: 'permission_not_granted',
      requiredPermission: 'contacts:delete',
    });

    const context = createContext({ sub: 'user_1' });
    const result = await guard.canActivate(context);

    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // TENANT ISOLATION — tenantId resolution
  // ═══════════════════════════════════════════════════════════════════
  it('should pass tenantId from CLS to authzCache', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'view',
      resource: 'contacts',
    });
    authzCache.canAccess.mockResolvedValue({
      allowed: true,
      userId: 'user_1',
      tenantId: 'tenant_1',
      cacheHit: false,
    });

    const context = createContext({ sub: 'user_1' });
    await guard.canActivate(context);

    expect(authzCache.canAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantHint: 'tenant_1',
      }),
    );
  });

  it('should use X-Tenant-Id header in non-production when CLS is empty', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    // CLS returns no tenantId
    cls.get = jest.fn((key: string) => {
      if (key === 'userId') return 'user_1';
      return undefined;
    });

    reflector.getAllAndOverride.mockReturnValue({
      action: 'view',
      resource: 'contacts',
    });
    authzCache.canAccess.mockResolvedValue({
      allowed: true,
      userId: 'user_1',
      tenantId: 'tenant_from_header',
      cacheHit: false,
    });

    const context = createContext({ sub: 'user_1' });
    context.switchToHttp().getRequest().headers['x-tenant-id'] =
      'tenant_from_header';

    await guard.canActivate(context);

    expect(authzCache.canAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantHint: 'tenant_from_header',
      }),
    );

    process.env.NODE_ENV = originalEnv;
  });
});
