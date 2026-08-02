import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GroupsService } from './groups.service';

/**
 * The grant invariant on the GROUP path: "you cannot grant what you do not
 * hold yourself".
 *
 * Attaching a role to a group was already covered. These tests cover the three
 * sibling writes that confer exactly the same access without ever naming a
 * roleId — adding a member, creating a group with members, and re-parenting a
 * group under a privileged ancestor.
 */
describe('GroupsService — grant invariant on membership and hierarchy', () => {
  const tenantId = 'tenant_1';
  const callerId = 'caller_1';

  const privilegedRole = {
    id: 'role_admin',
    permissions: ['users:manage_roles'],
  };
  const ordinaryRole = { id: 'role_view', permissions: ['contacts:view'] };

  let repository: any;
  let customRoles: any;
  let authzCache: any;
  let userRepository: any;
  let service: GroupsService;

  /** Caller holds exactly these permission keys and is not an admin. */
  const callerHolds = (...keys: string[]) => {
    authzCache.explainForUser.mockResolvedValue({
      fullAccess: false,
      tenantCeiling: [...keys],
      effective: [...keys],
    });
  };

  beforeEach(() => {
    repository = {
      findById: jest.fn(),
      findAncestorChain: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation((data: any) =>
          Promise.resolve({ id: 'group_new', memberIds: [], ...data }),
        ),
      update: jest
        .fn()
        .mockImplementation((_t: string, id: string, data: any) =>
          Promise.resolve({ id, name: 'g', memberIds: [], ...data }),
        ),
      addMember: jest
        .fn()
        .mockImplementation((_t: string, id: string) =>
          Promise.resolve({ id, name: 'g', memberIds: [callerId] }),
        ),
      removeMember: jest
        .fn()
        .mockImplementation((_t: string, id: string) =>
          Promise.resolve({ id, name: 'g', memberIds: [] }),
        ),
      findDescendantIds: jest.fn().mockResolvedValue([]),
      findMemberIdsForGroups: jest.fn().mockResolvedValue([]),
    };
    customRoles = {
      findAll: jest.fn().mockResolvedValue([privilegedRole, ordinaryRole]),
    };
    authzCache = {
      explainForUser: jest.fn(),
      previewGroupAccess: jest.fn(),
    };
    userRepository = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: callerId, tenants: [{ tenantId }] }),
      findByIds: jest.fn().mockResolvedValue([]),
    };
    callerHolds('contacts:view');

    service = new GroupsService(
      repository,
      {
        get: jest
          .fn()
          .mockImplementation((key: string) =>
            key === 'tenantId' ? tenantId : callerId,
          ),
      } as any,
      userRepository,
      { emit: jest.fn() } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      customRoles,
      authzCache,
    );
  });

  describe('addMember', () => {
    it('should refuse to add a member to a group carrying a role the caller does not hold', async () => {
      const group = {
        id: 'g_admin',
        name: 'Admins',
        roleIds: [privilegedRole.id],
      };
      repository.findById.mockResolvedValue(group);
      repository.findAncestorChain.mockResolvedValue([group]);

      await expect(service.addMember('g_admin', callerId)).rejects.toThrow(
        ForbiddenException,
      );
      expect(repository.addMember).not.toHaveBeenCalled();
    });

    it('should refuse when the privileged role sits on an ANCESTOR, not the group itself', async () => {
      const child = {
        id: 'g_child',
        name: 'Child',
        roleIds: [],
        parentGroupId: 'g_admin',
      };
      repository.findById.mockResolvedValue(child);
      repository.findAncestorChain.mockResolvedValue([
        { id: 'g_admin', name: 'Admins', roleIds: [privilegedRole.id] },
      ]);

      await expect(service.addMember('g_child', callerId)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should allow adding a member when the caller holds everything the chain grants', async () => {
      const group = {
        id: 'g_view',
        name: 'Viewers',
        roleIds: [ordinaryRole.id],
      };
      repository.findById.mockResolvedValue(group);
      repository.findAncestorChain.mockResolvedValue([group]);

      await expect(
        service.addMember('g_view', callerId),
      ).resolves.toBeDefined();
      expect(repository.addMember).toHaveBeenCalled();
    });
  });

  describe('removeMember', () => {
    it('should never apply the grant check — losing membership only removes access', async () => {
      await expect(
        service.removeMember('g_admin', callerId),
      ).resolves.toBeDefined();
      expect(authzCache.explainForUser).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should refuse to re-parent a group under an ancestor the caller cannot grant', async () => {
      repository.findById.mockImplementation((_t: string, id: string) =>
        Promise.resolve(
          id === 'g_admin'
            ? { id: 'g_admin', name: 'Admins', roleIds: [privilegedRole.id] }
            : {
                id: 'g_child',
                name: 'Child',
                roleIds: [],
                memberIds: [callerId],
              },
        ),
      );
      repository.findDescendantIds.mockResolvedValue([]);
      repository.findAncestorChain.mockResolvedValue([
        { id: 'g_admin', name: 'Admins', roleIds: [privilegedRole.id] },
      ]);

      await expect(
        service.update('g_child', { parentGroupId: 'g_admin' } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should refuse to add a member to a group whose roles the caller does not hold', async () => {
      const group = {
        id: 'g_admin',
        name: 'Admins',
        roleIds: [privilegedRole.id],
        memberIds: [],
      };
      repository.findById.mockResolvedValue(group);
      repository.findAncestorChain.mockResolvedValue([group]);

      await expect(
        service.update('g_admin', { memberIds: [callerId] } as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should still allow editing an unrelated field on a group the caller could not grant', async () => {
      // Renaming confers nothing, so it must not require holding the group's
      // permissions — otherwise the invariant becomes an edit lockout.
      repository.findById.mockResolvedValue({
        id: 'g_admin',
        name: 'Admins',
        roleIds: [privilegedRole.id],
        memberIds: ['someone_else'],
      });

      await expect(
        service.update('g_admin', { name: 'Renamed' } as any),
      ).resolves.toBeDefined();
      expect(repository.update).toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('should refuse to create a group parented under a privileged ancestor', async () => {
      repository.findById.mockResolvedValue({ id: 'g_admin', name: 'Admins' });
      repository.findAncestorChain.mockResolvedValue([
        { id: 'g_admin', name: 'Admins', roleIds: [privilegedRole.id] },
      ]);

      await expect(
        service.create({
          name: 'Trojan',
          parentGroupId: 'g_admin',
          memberIds: [callerId],
        } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('previewAccess', () => {
    it('should delegate to the authorization engine rather than resolving locally', async () => {
      authzCache.previewGroupAccess.mockResolvedValue({
        permissions: ['contacts:view'],
        sources: {},
        tenantCeiling: ['contacts:view'],
        scope: 'self',
        explicit: false,
        inherited: [],
      });

      const result = await service.previewAccess({
        roleIds: [ordinaryRole.id],
        parentGroupId: 'g_parent',
      });

      expect(authzCache.previewGroupAccess).toHaveBeenCalledWith(tenantId, {
        roleIds: [ordinaryRole.id],
        parentGroupId: 'g_parent',
      });
      expect(result.permissions).toEqual(['contacts:view']);
    });

    it('should reject role ids from outside the tenant catalog', async () => {
      await expect(
        service.previewAccess({ roleIds: ['role_from_another_tenant'] }),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(authzCache.previewGroupAccess).not.toHaveBeenCalled();
    });

    it('should not apply the grant invariant — previewing confers nothing', async () => {
      authzCache.previewGroupAccess.mockResolvedValue({
        permissions: privilegedRole.permissions,
        sources: {},
        tenantCeiling: privilegedRole.permissions,
        scope: 'self',
        explicit: false,
        inherited: [],
      });

      await expect(
        service.previewAccess({ roleIds: [privilegedRole.id] }),
      ).resolves.toBeDefined();
      expect(authzCache.explainForUser).not.toHaveBeenCalled();
    });
  });

  describe('listMembers', () => {
    it('should drop users who are not members of the active tenant', async () => {
      repository.findById.mockResolvedValue({
        id: 'g1',
        name: 'g',
        memberIds: ['u_in', 'u_out'],
      });
      userRepository.findByIds.mockResolvedValue([
        {
          id: 'u_in',
          firstName: 'In',
          lastName: 'Tenant',
          email: 'in@x.com',
          tenants: [{ tenantId }],
        },
        {
          id: 'u_out',
          firstName: 'Out',
          lastName: 'Side',
          email: 'out@x.com',
          tenants: [{ tenantId: 'other_tenant' }],
        },
      ]);

      await expect(service.listMembers('g1')).resolves.toEqual([
        {
          id: 'u_in',
          firstName: 'In',
          lastName: 'Tenant',
          email: 'in@x.com',
        },
      ]);
    });

    it('should not query the user store for an empty group', async () => {
      repository.findById.mockResolvedValue({ id: 'g1', name: 'g' });

      await expect(service.listMembers('g1')).resolves.toEqual([]);
      expect(userRepository.findByIds).not.toHaveBeenCalled();
    });

    it('should refuse an unknown group rather than returning an empty roster', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.listMembers('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
