import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RoleAssignmentService } from './role-assignment.service';
import { AUTHZ_PERMISSION_CACHE } from './authz.tokens';

describe('RoleAssignmentService', () => {
  const tenantId = 'tenant_1';
  const userId = 'user_1';
  const roleId = 'role_sales';
  const governedExpiry = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  let model: any;
  let customRoles: any;
  let audit: any;
  let eventEmitter: any;
  let moduleRef: any;
  let userRepository: any;
  let groupRepository: any;
  let authzCache: any;
  let cls: any;
  let service: RoleAssignmentService;

  const callerId = 'admin_1';

  beforeEach(() => {
    model = {
      create: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
      find: jest.fn(),
      findOne: jest.fn(),
    };
    customRoles = {
      findById: jest.fn().mockResolvedValue({ id: roleId, permissions: [] }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = { emit: jest.fn() };

    // The caller (grantedById in most tests, resolved here via CLS) is
    // distinct from every principal these pre-existing tests target, and
    // holds full access by default so the escalation check is a no-op for
    // them unless a test overrides authzCache.explainForUser.
    cls = { get: jest.fn().mockReturnValue(callerId) };
    authzCache = {
      explainForUser: jest.fn().mockResolvedValue({
        fullAccess: true,
        tenantCeiling: [],
        effective: [],
      }),
    };

    // ModuleRef stub backing the H-03 principal-membership check. Default: the
    // principal IS a member of the tenant, so the pre-existing tests keep
    // exercising the grant/revoke behaviour they were written for.
    userRepository = {
      findByIdsGlobal: jest
        .fn()
        .mockResolvedValue([{ id: userId, tenants: [{ tenantId }] }]),
    };
    groupRepository = {
      findById: jest.fn().mockResolvedValue({ id: 'group_1' }),
    };
    moduleRef = {
      get: jest.fn((token: any) => {
        if (String(token?.name).includes('Group')) return groupRepository;
        if (token === AUTHZ_PERMISSION_CACHE) return authzCache;
        return userRepository;
      }),
    };

    service = new RoleAssignmentService(
      model,
      customRoles,
      audit,
      eventEmitter,
      moduleRef,
      cls,
    );
  });

  it('should H-03: refuses to grant a role to a non-member of the tenant', async () => {
    // A user of another workspace. Previously this created a working grant,
    // because the evaluator synthesized the missing membership row.
    userRepository.findByIdsGlobal.mockResolvedValueOnce([
      { id: userId, tenants: [{ tenantId: 'some_other_tenant' }] },
    ]);

    await expect(
      service.grant({
        tenantId,
        principalType: 'user',
        principalId: userId,
        roleId,
        grantedById: 'admin_1',
        expiresAt: governedExpiry(),
        reason: 'test request',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('should H-03: refuses to grant a role to a group of another tenant', async () => {
    groupRepository.findById.mockResolvedValueOnce(null);

    await expect(
      service.grant({
        tenantId,
        principalType: 'group',
        principalId: 'group_from_elsewhere',
        roleId,
        grantedById: 'admin_1',
        expiresAt: governedExpiry(),
        reason: 'test request',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('should grant validates the role exists in the tenant', async () => {
    customRoles.findById.mockRejectedValueOnce(new NotFoundException());
    await expect(
      service.grant({
        tenantId,
        principalType: 'user',
        principalId: userId,
        roleId,
        grantedById: 'admin_1',
        expiresAt: governedExpiry(),
        reason: 'test request',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('should create a pending request without activating permissions', async () => {
    const expiresAt = governedExpiry();
    await service.grant({
      tenantId,
      principalType: 'user',
      principalId: userId,
      roleId,
      grantedById: 'admin_1',
      expiresAt,
      reason: 'on-call',
    });

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        principalId: userId,
        roleId,
        expiresAt,
        approvalStatus: 'pending',
        approvals: [],
      }),
    );
    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'ASSIGNMENT', action: 'request' }),
    );
  });

  it('should keep a group request inert until approval', async () => {
    await service.grant({
      tenantId,
      principalType: 'group',
      principalId: 'group_1',
      roleId,
      grantedById: 'admin_1',
      expiresAt: governedExpiry(),
      reason: 'test request',
    });
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  describe('anti-escalation invariant', () => {
    it('should refuse a self-grant', async () => {
      cls.get.mockReturnValue(userId); // caller === target

      await expect(
        service.grant({
          tenantId,
          principalType: 'user',
          principalId: userId,
          roleId,
          grantedById: userId,
          expiresAt: governedExpiry(),
          reason: 'test request',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(model.create).not.toHaveBeenCalled();
    });

    it('should refuse to grant a role carrying keys the caller does not hold', async () => {
      customRoles.findById.mockResolvedValueOnce({
        id: roleId,
        permissions: ['contacts:view', 'settings:manage_system'],
      });
      authzCache.explainForUser.mockResolvedValueOnce({
        fullAccess: false,
        tenantCeiling: [
          'contacts:view',
          'settings:manage_system',
          'settings:view',
        ],
        effective: ['contacts:view'], // caller lacks settings:manage_system
      });

      await expect(
        service.grant({
          tenantId,
          principalType: 'user',
          principalId: userId,
          roleId,
          grantedById: callerId,
          expiresAt: governedExpiry(),
          reason: 'test request',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(model.create).not.toHaveBeenCalled();
    });

    it('should allow granting a role whose keys are all within the caller effective set', async () => {
      customRoles.findById.mockResolvedValueOnce({
        id: roleId,
        permissions: ['contacts:view'],
      });
      authzCache.explainForUser.mockResolvedValueOnce({
        fullAccess: false,
        tenantCeiling: ['contacts:view', 'settings:manage_system'],
        effective: ['contacts:view'],
      });

      await service.grant({
        tenantId,
        principalType: 'user',
        principalId: userId,
        roleId,
        grantedById: callerId,
        expiresAt: governedExpiry(),
        reason: 'test request',
      });

      expect(model.create).toHaveBeenCalled();
    });
  });

  it('should activeRoleIdsForPrincipals queries out revoked and expired grants', async () => {
    model.find.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve([
            { roleId: 'r1' },
            { roleId: 'r2' },
            { roleId: 'r1' },
          ]),
      }),
    });
    const now = new Date('2026-07-24T00:00:00.000Z');

    const result = await service.activeRoleIdsForPrincipals(
      tenantId,
      [userId, 'group_1'],
      now,
    );

    expect(result.sort()).toEqual(['r1', 'r2']); // de-duped
    const where = model.find.mock.calls[0][0];
    expect(where.revokedAt).toBeNull();
    expect(where.$and).toEqual([
      {
        $or: [
          { approvalStatus: 'approved' },
          { approvalStatus: { $exists: false } },
        ],
      },
    ]);
    expect(where.$or).toEqual([
      { expiresAt: null },
      { expiresAt: { $gt: now } },
    ]);
    expect(where.principalId.$in.sort()).toEqual([userId, 'group_1'].sort());
  });

  it('should require two distinct approvals before activating a request', async () => {
    const save = jest.fn();
    const doc: any = {
      tenantId,
      principalType: 'user',
      principalId: userId,
      roleId,
      grantedById: 'requester_1',
      approvalStatus: 'pending',
      approvals: [],
      save,
    };
    save.mockImplementation(() => Promise.resolve(doc));
    model.findOne.mockReturnValue({ exec: () => Promise.resolve(doc) });

    const first = await service.approve(
      tenantId,
      'a1',
      'approver_1',
      new Date(),
    );
    expect(first.approvalStatus).toBe('pending');
    expect(eventEmitter.emit).not.toHaveBeenCalled();

    const second = await service.approve(
      tenantId,
      'a1',
      'approver_2',
      new Date(),
    );
    expect(second.approvalStatus).toBe('approved');
    expect(eventEmitter.emit).toHaveBeenCalledWith('user.permissions.updated', {
      tenantId,
      userId,
    });
  });

  it('should prevent requester, target, and duplicate approver participation', async () => {
    const doc: any = {
      tenantId,
      principalType: 'user',
      principalId: userId,
      roleId,
      grantedById: 'requester_1',
      approvalStatus: 'pending',
      approvals: [{ approverId: 'approver_1', approvedAt: new Date() }],
      save: jest.fn(),
    };
    model.findOne.mockReturnValue({ exec: () => Promise.resolve(doc) });

    await expect(
      service.approve(tenantId, 'a1', 'requester_1', new Date()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.approve(tenantId, 'a1', userId, new Date()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.approve(tenantId, 'a1', 'approver_1', new Date()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('should activeRoleIdsForPrincipals short-circuits on empty input', async () => {
    const result = await service.activeRoleIdsForPrincipals(
      tenantId,
      [],
      new Date(),
    );
    expect(result).toEqual([]);
    expect(model.find).not.toHaveBeenCalled();
  });

  it('should revoke is idempotent on an already-revoked assignment', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    model.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          principalType: 'user',
          principalId: userId,
          roleId,
          revokedAt: new Date('2026-01-01'),
          save,
        }),
    });
    await service.revoke(tenantId, 'a1', 'admin_1', new Date());
    expect(save).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('should revoke soft-marks, invalidates, and audits', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const doc: any = {
      principalType: 'user',
      principalId: userId,
      roleId,
      revokedAt: null,
      save,
    };
    model.findOne.mockReturnValue({ exec: () => Promise.resolve(doc) });
    const now = new Date('2026-07-24T10:00:00.000Z');

    await service.revoke(tenantId, 'a1', 'admin_1', now);

    expect(doc.revokedAt).toBe(now);
    expect(doc.revokedById).toBe('admin_1');
    expect(save).toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith('user.permissions.updated', {
      tenantId,
      userId,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'ASSIGNMENT', action: 'revoke' }),
    );
  });

  it('should revoke throws when the assignment does not exist', async () => {
    model.findOne.mockReturnValue({ exec: () => Promise.resolve(null) });
    await expect(
      service.revoke(tenantId, 'missing', 'admin_1', new Date()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
