import { AuthorizationService } from './authorization.service';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';

/**
 * AuthorizationService is the single PDP. These tests cover:
 *   - platform super-admin (claim + DB, C5)
 *   - RBAC action delegation
 *   - record-level ACL composition (deny-overrides)
 */
describe('AuthorizationService (PDP)', () => {
  let cache: any;
  let objectAcl: any;
  let accessPolicy: any;
  let svc: AuthorizationService;

  const superClaim = { realm_access: { roles: [PlatformRoleEnum.SUPER_ADMIN] } };

  beforeEach(() => {
    cache = {
      canAccess: jest.fn(),
      isPlatformSuperAdmin: jest.fn(),
    };
    objectAcl = { can: jest.fn() };
    // Default: no ABAC opinion (null) so existing ACL tests are unaffected.
    accessPolicy = { evaluate: jest.fn().mockResolvedValue(null) };
    svc = new AuthorizationService(cache, objectAcl, accessPolicy);
  });

  // ── super-admin (C5) ──────────────────────────────────────────────────
  it('detects a super-admin claim in realm_access / resource_access / roles', () => {
    expect(svc.hasSuperAdminClaim(superClaim)).toBe(true);
    expect(
      svc.hasSuperAdminClaim({
        resource_access: { api: { roles: ['SUPER_ADMIN'] } },
      }),
    ).toBe(true);
    expect(svc.hasSuperAdminClaim({ roles: ['SUPER_ADMIN'] })).toBe(true);
    expect(svc.hasSuperAdminClaim({ roles: ['USER'] })).toBe(false);
    expect(svc.hasSuperAdminClaim(undefined)).toBe(false);
  });

  it('requires BOTH claim AND DB confirmation for super-admin', async () => {
    cache.isPlatformSuperAdmin.mockResolvedValue(true);
    expect(await svc.isSuperAdmin('u1', superClaim)).toBe(true);

    cache.isPlatformSuperAdmin.mockResolvedValue(false);
    expect(await svc.isSuperAdmin('u1', superClaim)).toBe(false);
  });

  it('never hits the DB when there is no super-admin claim', async () => {
    expect(await svc.isSuperAdmin('u1', { roles: ['USER'] })).toBe(false);
    expect(cache.isPlatformSuperAdmin).not.toHaveBeenCalled();
  });

  it('grants a verified super-admin without an RBAC check', async () => {
    cache.isPlatformSuperAdmin.mockResolvedValue(true);
    const decision = await svc.canPerformAction({
      rule: { action: 'delete', resource: 'contacts' },
      rawUserId: 'u1',
      claims: superClaim,
    });
    expect(decision).toEqual({ allowed: true, superAdmin: true });
    expect(cache.canAccess).not.toHaveBeenCalled();
  });

  it('falls through to RBAC for a forged claim (DB says not super-admin)', async () => {
    cache.isPlatformSuperAdmin.mockResolvedValue(false);
    cache.canAccess.mockResolvedValue({ allowed: false, cacheHit: false });

    const decision = await svc.canPerformAction({
      rule: { action: 'delete', resource: 'contacts' },
      rawUserId: 'attacker',
      claims: superClaim,
    });
    expect(decision.allowed).toBe(false);
    expect(cache.canAccess).toHaveBeenCalled();
  });

  it('delegates a normal action to the RBAC cache', async () => {
    cache.canAccess.mockResolvedValue({
      allowed: true,
      userId: 'u1',
      tenantId: 't1',
    });
    const decision = await svc.canPerformAction({
      rule: { action: 'view', resource: 'contacts' },
      rawUserId: 'u1',
      tenantHint: 't1',
      claims: { roles: ['USER'] },
    });
    expect(decision.allowed).toBe(true);
    expect(cache.canAccess).toHaveBeenCalledWith({
      rawUserId: 'u1',
      tenantHint: 't1',
      rule: { action: 'view', resource: 'contacts' },
    });
  });

  // ── record-level ACL composition ──────────────────────────────────────
  const recordParams = {
    tenantId: 't1',
    userId: 'u1',
    action: 'edit',
    resource: 'deals',
    resourceId: 'deal_1',
    groupIds: ['g1'],
  };

  it('denies a record on an explicit ACL deny', async () => {
    objectAcl.can.mockResolvedValue(false);
    expect(await svc.canAccessRecord(recordParams)).toBe(false);
  });

  it('allows a record on an explicit ACL allow (sharing widens scope)', async () => {
    objectAcl.can.mockResolvedValue(true);
    expect(await svc.canAccessRecord(recordParams)).toBe(true);
  });

  it('allows a record when there is no explicit ACL entry (null → fallback)', async () => {
    objectAcl.can.mockResolvedValue(null);
    expect(await svc.canAccessRecord(recordParams)).toBe(true);
    expect(objectAcl.can).toHaveBeenCalledWith(
      't1',
      'u1',
      'edit',
      'deals',
      'deal_1',
      ['g1'],
    );
  });

  // ── ABAC composition (deny-overrides on top of ACL) ───────────────────
  it('denies a record when an ABAC policy evaluates to deny (even if ACL is null)', async () => {
    objectAcl.can.mockResolvedValue(null);
    accessPolicy.evaluate.mockResolvedValue('deny');
    expect(
      await svc.canAccessRecord({
        ...recordParams,
        record: { stage: 'closed' },
      }),
    ).toBe(false);
  });

  it('passes subject/resource/env context to the ABAC evaluator', async () => {
    objectAcl.can.mockResolvedValue(null);
    accessPolicy.evaluate.mockResolvedValue('allow');
    await svc.canAccessRecord({
      ...recordParams,
      principalType: 'agent',
      record: { ownerId: 'u2', stage: 'open' },
      subject: { roleIds: ['r1'] },
    });
    expect(accessPolicy.evaluate).toHaveBeenCalledWith(
      't1',
      'deals',
      'edit',
      expect.objectContaining({
        subject: expect.objectContaining({
          id: 'u1',
          principalType: 'agent',
          groupIds: ['g1'],
          roleIds: ['r1'],
        }),
        resource: { ownerId: 'u2', stage: 'open' },
        env: expect.objectContaining({ now: expect.any(Date) }),
      }),
    );
  });

  it('short-circuits ABAC when ACL already denies', async () => {
    objectAcl.can.mockResolvedValue(false);
    expect(await svc.canAccessRecord(recordParams)).toBe(false);
    expect(accessPolicy.evaluate).not.toHaveBeenCalled();
  });
});
