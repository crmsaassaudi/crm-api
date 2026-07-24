import { PermissionGuard } from './permission.guard';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import { createClsMock } from '../../test/mocks/cls.mock';

/**
 * PermissionGuard is a thin adapter — it resolves request context and delegates
 * the decision to AuthorizationService.canPerformAction. These tests verify the
 * adapter wiring (delegation, CLS writes, deny logging). The actual RBAC /
 * super-admin decision logic is tested in authorization.service.spec.ts.
 */
describe('PermissionGuard (adapter over AuthorizationService)', () => {
  let guard: PermissionGuard;
  let reflector: any;
  let authz: any;
  let cls: ReturnType<typeof createClsMock>;

  const createContext = (userPayload: any = {}) => {
    const request: any = {
      user: userPayload,
      method: 'GET',
      originalUrl: '/api/contacts',
      headers: {},
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getClass: () => ({ name: 'ContactsController' }),
      getHandler: () => ({ name: 'findAll' }),
      request,
    } as any;
  };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    authz = { canPerformAction: jest.fn() };
    cls = createClsMock();
    guard = new PermissionGuard(reflector, authz as any, cls as any);
  });

  it('allows access when no permission metadata is defined', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const result = await guard.canActivate(createContext({ sub: 'user_1' }));
    expect(result).toBe(true);
    expect(authz.canPerformAction).not.toHaveBeenCalled();
  });

  it('denies access when user payload / userId is missing', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'view',
      resource: 'contacts',
    });
    cls.get = jest.fn(() => undefined) as any;
    const result = await guard.canActivate(createContext(null));
    expect(result).toBe(false);
    expect(authz.canPerformAction).not.toHaveBeenCalled();
  });

  it('delegates to AuthorizationService and allows when it allows', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'view',
      resource: 'contacts',
    });
    authz.canPerformAction.mockResolvedValue({
      allowed: true,
      userId: 'user_1',
      tenantId: 'tenant_1',
      email: 'test@example.com',
    });

    const result = await guard.canActivate(createContext({ sub: 'user_1' }));

    expect(result).toBe(true);
    expect(authz.canPerformAction).toHaveBeenCalledWith(
      expect.objectContaining({
        rawUserId: 'user_1',
        rule: { action: 'view', resource: 'contacts' },
        claims: expect.any(Object),
      }),
    );
    expect(cls.set).toHaveBeenCalledWith('userId', 'user_1');
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant_1');
    expect(cls.set).toHaveBeenCalledWith('activeTenantId', 'tenant_1');
  });

  it('denies when AuthorizationService denies', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'delete',
      resource: 'contacts',
    });
    authz.canPerformAction.mockResolvedValue({
      allowed: false,
      denyReason: 'permission_not_granted',
      requiredPermission: 'contacts:delete',
    });

    const result = await guard.canActivate(createContext({ sub: 'user_1' }));
    expect(result).toBe(false);
  });

  it('uses payload-derived ids on a super-admin bypass', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'delete',
      resource: 'contacts',
    });
    authz.canPerformAction.mockResolvedValue({ allowed: true, superAdmin: true });

    const result = await guard.canActivate(
      createContext({
        sub: 'kc_op',
        userId: 'kc_op',
        realm_access: { roles: [PlatformRoleEnum.SUPER_ADMIN] },
      }),
    );

    expect(result).toBe(true);
    expect(cls.set).toHaveBeenCalledWith('userId', 'kc_op');
  });

  it('passes tenantId hint from CLS to the service', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      action: 'view',
      resource: 'contacts',
    });
    authz.canPerformAction.mockResolvedValue({
      allowed: true,
      userId: 'user_1',
      tenantId: 'tenant_1',
    });

    await guard.canActivate(createContext({ sub: 'user_1' }));

    expect(authz.canPerformAction).toHaveBeenCalledWith(
      expect.objectContaining({ tenantHint: 'tenant_1' }),
    );
  });

  it('uses X-Tenant-Id header in non-production when CLS is empty', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    cls.get = jest.fn((key: string) =>
      key === 'userId' ? 'user_1' : undefined,
    ) as any;

    reflector.getAllAndOverride.mockReturnValue({
      action: 'view',
      resource: 'contacts',
    });
    authz.canPerformAction.mockResolvedValue({
      allowed: true,
      userId: 'user_1',
      tenantId: 'tenant_from_header',
    });

    const context = createContext({ sub: 'user_1' });
    context.switchToHttp().getRequest().headers['x-tenant-id'] =
      'tenant_from_header';

    await guard.canActivate(context);

    expect(authz.canPerformAction).toHaveBeenCalledWith(
      expect.objectContaining({ tenantHint: 'tenant_from_header' }),
    );

    process.env.NODE_ENV = originalEnv;
  });
});
