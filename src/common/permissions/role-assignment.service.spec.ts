import { NotFoundException } from '@nestjs/common';
import { RoleAssignmentService } from './role-assignment.service';

describe('RoleAssignmentService', () => {
  const tenantId = 'tenant_1';
  const userId = 'user_1';
  const roleId = 'role_sales';

  let model: any;
  let customRoles: any;
  let audit: any;
  let eventEmitter: any;
  let service: RoleAssignmentService;

  beforeEach(() => {
    model = {
      create: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
      find: jest.fn(),
      findOne: jest.fn(),
    };
    customRoles = {
      findById: jest.fn().mockResolvedValue({ _id: roleId }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = { emit: jest.fn() };
    service = new RoleAssignmentService(model, customRoles, audit, eventEmitter);
  });

  it('grant validates the role exists in the tenant', async () => {
    customRoles.findById.mockRejectedValueOnce(new NotFoundException());
    await expect(
      service.grant({
        tenantId,
        principalType: 'user',
        principalId: userId,
        roleId,
        grantedById: 'admin_1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('grant persists, invalidates the principal cache, and audits', async () => {
    const expiresAt = new Date('2999-01-01T00:00:00.000Z');
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
      expect.objectContaining({ tenantId, principalId: userId, roleId, expiresAt }),
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith('user.permissions.updated', {
      tenantId,
      userId,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'ASSIGNMENT', action: 'assign' }),
    );
  });

  it('grant to a group emits a group invalidation event', async () => {
    await service.grant({
      tenantId,
      principalType: 'group',
      principalId: 'group_1',
      roleId,
      grantedById: 'admin_1',
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith('group.updated', {
      tenantId,
      groupId: 'group_1',
    });
  });

  it('activeRoleIdsForPrincipals queries out revoked and expired grants', async () => {
    model.find.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve([{ roleId: 'r1' }, { roleId: 'r2' }, { roleId: 'r1' }]),
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
    expect(where.$or).toEqual([
      { expiresAt: null },
      { expiresAt: { $gt: now } },
    ]);
    expect(where.principalId.$in.sort()).toEqual([userId, 'group_1'].sort());
  });

  it('activeRoleIdsForPrincipals short-circuits on empty input', async () => {
    const result = await service.activeRoleIdsForPrincipals(tenantId, [], new Date());
    expect(result).toEqual([]);
    expect(model.find).not.toHaveBeenCalled();
  });

  it('revoke is idempotent on an already-revoked assignment', async () => {
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

  it('revoke soft-marks, invalidates, and audits', async () => {
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

  it('revoke throws when the assignment does not exist', async () => {
    model.findOne.mockReturnValue({ exec: () => Promise.resolve(null) });
    await expect(
      service.revoke(tenantId, 'missing', 'admin_1', new Date()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
