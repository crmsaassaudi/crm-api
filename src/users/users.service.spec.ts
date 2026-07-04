import {
  UnprocessableEntityException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { createUser } from '../test/factories/user.factory';
import { createClsMock } from '../test/mocks/cls.mock';
import { createEventBusMock } from '../test/mocks/event-bus.mock';

/**
 * UsersService — Phase 3 unit tests
 *
 * Covers: create (email uniqueness, password hashing), invite (existing vs new user,
 * Keycloak rollback on DB failure), remove (tenant owner protection),
 * removeFromTenant (group cleanup), i18n resolution cascade,
 * and user-permissions event emission.
 */
describe('UsersService', () => {
  let service: UsersService;
  let usersRepository: any;
  let filesService: any;
  let cls: ReturnType<typeof createClsMock>;
  let keycloakAdminService: any;
  let tenantsRepository: any;
  let groupRepository: any;
  let eventEmitter: ReturnType<typeof createEventBusMock>;

  beforeEach(() => {
    usersRepository = {
      create: jest
        .fn()
        .mockImplementation((data: any) =>
          Promise.resolve({ id: 'user_new', ...data }),
        ),
      findById: jest.fn().mockResolvedValue(null),
      findByIds: jest.fn().mockResolvedValue([]),
      findByIdsGlobal: jest.fn().mockResolvedValue([]),
      findByEmail: jest.fn().mockResolvedValue(null),
      findByKeycloakIdAndProvider: jest.fn().mockResolvedValue(null),
      findManyByTenant: jest.fn().mockResolvedValue([]),
      findManyWithPagination: jest
        .fn()
        .mockResolvedValue({ data: [], hasNextPage: false }),
      update: jest
        .fn()
        .mockImplementation((id: any, data: any) =>
          Promise.resolve({ id, ...data, tenants: [] }),
        ),
      remove: jest.fn().mockResolvedValue(undefined),
      upsertWithTenants: jest
        .fn()
        .mockImplementation(
          (_kcId: any, _email: any, _data: any, tenants: any) =>
            Promise.resolve({ id: 'user_existing', tenants }),
        ),
      removeTenantMembership: jest
        .fn()
        .mockResolvedValue(createUser({ tenants: [] })),
    };

    filesService = {
      findById: jest.fn().mockResolvedValue(null),
    };

    cls = createClsMock();

    keycloakAdminService = {
      findUserByEmail: jest.fn().mockResolvedValue(null),
      createUser: jest
        .fn()
        .mockResolvedValue({ id: 'kc_new', email: 'new@test.com' }),
      addUserToOrganization: jest.fn().mockResolvedValue(undefined),
      resetPassword: jest.fn().mockResolvedValue(undefined),
      deleteUser: jest.fn().mockResolvedValue(undefined),
      updateUserStatus: jest.fn().mockResolvedValue(undefined),
    };

    tenantsRepository = {
      findById: jest.fn().mockResolvedValue({
        id: 'tenant_1',
        ownerId: 'owner_1',
        keycloakOrgId: 'org_1',
      }),
      findByOwnerId: jest.fn().mockResolvedValue([]),
    };

    groupRepository = {
      findGroupsByMember: jest.fn().mockResolvedValue([]),
      removeMember: jest.fn().mockResolvedValue(undefined),
    };

    eventEmitter = createEventBusMock();

    service = new UsersService(
      usersRepository,
      filesService,
      cls as any,
      keycloakAdminService,
      tenantsRepository,
      groupRepository,
      eventEmitter as any,
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // CREATE — email uniqueness, password hashing
  // ═══════════════════════════════════════════════════════════════════
  describe('create', () => {
    it('should create user with hashed password', async () => {
      const result = await service.create({
        email: 'new@test.com',
        password: 'plain123',
        firstName: 'John',
        lastName: 'Doe',
      });

      expect(usersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new@test.com',
          firstName: 'John',
          lastName: 'Doe',
          // password should be hashed (not 'plain123')
          password: expect.not.stringContaining('plain123'),
        }),
        undefined, // session
      );
      expect(result.id).toBe('user_new');
    });

    it('should throw when email already exists', async () => {
      usersRepository.findByEmail.mockResolvedValueOnce(
        createUser({ email: 'dupe@test.com' }),
      );

      await expect(
        service.create({
          email: 'dupe@test.com',
          firstName: 'A',
          lastName: 'B',
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should add tenant membership when tenantId provided', async () => {
      await service.create(
        { email: 'new@test.com', firstName: 'A', lastName: 'B' },
        'tenant_1',
      );

      expect(usersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenants: expect.arrayContaining([
            expect.objectContaining({ tenantId: 'tenant_1' }),
          ]),
        }),
        undefined,
      );
    });

    it('should create with empty tenants when no tenantId', async () => {
      await service.create({
        email: 'new@test.com',
        firstName: 'A',
        lastName: 'B',
      });

      expect(usersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenants: [] }),
        undefined,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // INVITE — existing user, new user, Keycloak rollback
  // ═══════════════════════════════════════════════════════════════════
  describe('invite', () => {
    it('should add existing user to tenant without creating Keycloak user', async () => {
      usersRepository.findByEmail.mockResolvedValueOnce(
        createUser({
          keycloakId: 'kc_existing',
          tenants: [
            {
              tenantId: 'other_tenant',
              roles: ['MEMBER'],
              joinedAt: new Date(),
            },
          ],
        }),
      );

      await service.invite({ email: 'existing@test.com' });

      // Should NOT create new Keycloak user
      expect(keycloakAdminService.createUser).not.toHaveBeenCalled();
      // Should upsert with tenant
      expect(usersRepository.upsertWithTenants).toHaveBeenCalled();
      // Should emit membership event
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'user.tenant-membership.updated',
        expect.objectContaining({ tenantId: 'tenant_1' }),
      );
    });

    it('should throw when user already belongs to tenant', async () => {
      usersRepository.findByEmail.mockResolvedValueOnce(
        createUser({
          tenants: [
            { tenantId: 'tenant_1', roles: ['MEMBER'], joinedAt: new Date() },
          ],
        }),
      );

      await expect(
        service.invite({ email: 'already-in@test.com' }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should create new user in Keycloak and DB', async () => {
      await service.invite({
        email: 'brand-new@test.com',
        tenantRole: 'ADMIN',
      });

      // Keycloak user created
      expect(keycloakAdminService.createUser).toHaveBeenCalled();
      // Added to KC org
      expect(keycloakAdminService.addUserToOrganization).toHaveBeenCalledWith(
        'org_1',
        'kc_new',
      );
      // Password reset sent
      expect(keycloakAdminService.resetPassword).toHaveBeenCalledWith('kc_new');
      // User created in DB with correct tenant + role
      expect(usersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'brand-new@test.com',
          keycloakId: 'kc_new',
          tenants: expect.arrayContaining([
            expect.objectContaining({
              tenantId: 'tenant_1',
              roles: ['ADMIN'],
            }),
          ]),
        }),
      );
    });

    it('should rollback Keycloak user when DB create fails', async () => {
      usersRepository.create.mockRejectedValueOnce(
        new Error('DB write failed'),
      );

      await expect(
        service.invite({ email: 'rollback@test.com' }),
      ).rejects.toThrow('DB write failed');

      // Keycloak user should be cleaned up
      expect(keycloakAdminService.deleteUser).toHaveBeenCalledWith('kc_new');
    });

    it('should NOT rollback Keycloak when KC user already existed', async () => {
      // KC user already existed → findUserByEmail returns existing
      keycloakAdminService.findUserByEmail.mockResolvedValueOnce({
        id: 'kc_pre_existing',
        email: 'pre@test.com',
      });
      usersRepository.create.mockRejectedValueOnce(new Error('DB error'));

      await expect(service.invite({ email: 'pre@test.com' })).rejects.toThrow(
        'DB error',
      );

      // Should NOT delete pre-existing Keycloak user
      expect(keycloakAdminService.deleteUser).not.toHaveBeenCalled();
    });

    it('should throw when tenant context is missing', async () => {
      cls.get = jest.fn((_key: string) => undefined) as any;

      await expect(
        service.invite({ email: 'no-tenant@test.com' }),
      ).rejects.toThrow('Tenant context missing');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // REMOVE — tenant owner protection, event emission
  // ═══════════════════════════════════════════════════════════════════
  describe('remove', () => {
    it('should prevent deleting a user who owns a tenant', async () => {
      tenantsRepository.findByOwnerId.mockResolvedValueOnce([
        { id: 'tenant_owned' },
      ]);

      await expect(service.remove('owner_user')).rejects.toThrow(
        'Cannot delete a user who owns a tenant',
      );

      // Should NOT actually delete
      expect(usersRepository.remove).not.toHaveBeenCalled();
    });

    it('should delete user and emit permissions event', async () => {
      usersRepository.findById.mockResolvedValueOnce(
        createUser({
          tenants: [
            { tenantId: 'tenant_1', roles: ['MEMBER'], joinedAt: new Date() },
            { tenantId: 'tenant_2', roles: ['ADMIN'], joinedAt: new Date() },
          ],
        }),
      );

      await service.remove('user_to_delete');

      expect(usersRepository.remove).toHaveBeenCalledWith('user_to_delete');
      // Should emit for each tenant membership
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'user.permissions.updated',
        expect.objectContaining({ tenantId: 'tenant_1' }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'user.permissions.updated',
        expect.objectContaining({ tenantId: 'tenant_2' }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // REMOVE FROM TENANT — owner protection, group cleanup
  // ═══════════════════════════════════════════════════════════════════
  describe('removeFromTenant', () => {
    it('should prevent removing the tenant owner', async () => {
      usersRepository.findById.mockResolvedValueOnce(createUser());

      await expect(service.removeFromTenant('owner_1')).rejects.toThrow(
        'Cannot remove the tenant owner from the tenant',
      );
    });

    it('should remove user from all groups before removing membership', async () => {
      usersRepository.findById.mockResolvedValueOnce(createUser());
      groupRepository.findGroupsByMember.mockResolvedValueOnce([
        { id: 'group_1' },
        { id: 'group_2' },
      ]);

      await service.removeFromTenant('user_to_remove');

      // Should remove from each group
      expect(groupRepository.removeMember).toHaveBeenCalledWith(
        'tenant_1',
        'group_1',
        'user_to_remove',
      );
      expect(groupRepository.removeMember).toHaveBeenCalledWith(
        'tenant_1',
        'group_2',
        'user_to_remove',
      );
      // Then remove membership
      expect(usersRepository.removeTenantMembership).toHaveBeenCalledWith(
        'user_to_remove',
        'tenant_1',
      );
    });

    it('should throw when user not found', async () => {
      await expect(service.removeFromTenant('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // I18N RESOLUTION — User → Tenant → System cascade
  // ═══════════════════════════════════════════════════════════════════
  describe('getResolvedI18n', () => {
    it('should resolve user preferences over tenant defaults', async () => {
      usersRepository.findById.mockResolvedValueOnce({
        id: 'user_1',
        i18nPreferences: { locale: 'vi', timezone: 'Asia/Ho_Chi_Minh' },
      });
      tenantsRepository.findById.mockResolvedValueOnce({
        id: 'tenant_1',
        i18nSettings: {
          locale: 'en',
          timezone: 'UTC',
          dateFormat: 'DD/MM/YYYY',
          currency: 'VND',
        },
      });

      const result = await service.getResolvedI18n(
        'user_1'.padStart(24, '0'), // 24-char to trigger findById path
        'tenant_1',
      );

      expect(result.locale).toBe('vi'); // from user
      expect(result.timezone).toBe('Asia/Ho_Chi_Minh'); // from user
      expect(result.dateFormat).toBe('DD/MM/YYYY'); // always from tenant
      expect(result.currency).toBe('VND'); // always from tenant
      expect(result._sources.locale).toBe('user');
      expect(result._sources.timezone).toBe('user');
    });

    it('should fall back to tenant defaults when user has no preferences', async () => {
      usersRepository.findById.mockResolvedValueOnce({
        id: 'user_1',
        i18nPreferences: undefined,
      });
      tenantsRepository.findById.mockResolvedValueOnce({
        id: 'tenant_1',
        i18nSettings: {
          locale: 'ar',
          timezone: 'Asia/Riyadh',
          dateFormat: 'DD/MM/YYYY',
          currency: 'SAR',
        },
      });

      const result = await service.getResolvedI18n(
        'user_1'.padStart(24, '0'),
        'tenant_1',
      );

      expect(result.locale).toBe('ar');
      expect(result.timezone).toBe('Asia/Riyadh');
      expect(result._sources.locale).toBe('tenant');
    });

    it('should fall back to system defaults when tenant has no i18n settings', async () => {
      usersRepository.findById.mockResolvedValueOnce({ id: 'u1' });
      tenantsRepository.findById.mockResolvedValueOnce({
        id: 't1',
        i18nSettings: undefined,
      });

      const result = await service.getResolvedI18n(
        'u1'.padStart(24, '0'),
        't1',
      );

      expect(result.locale).toBe('en'); // system default
      expect(result.timezone).toBe('UTC');
      expect(result.currency).toBe('USD');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // getUserGroups — tenant isolation
  // ═══════════════════════════════════════════════════════════════════
  describe('getUserGroups', () => {
    it('should throw when user does not belong to current tenant', async () => {
      usersRepository.findById.mockResolvedValueOnce(
        createUser({
          tenants: [
            {
              tenantId: 'other_tenant',
              roles: ['MEMBER'],
              joinedAt: new Date(),
            },
          ],
        }),
      );

      await expect(service.getUserGroups('user_1')).rejects.toThrow(
        'User does not belong to this tenant',
      );
    });

    it('should return groups when user belongs to tenant', async () => {
      usersRepository.findById.mockResolvedValueOnce(
        createUser({
          tenants: [
            { tenantId: 'tenant_1', roles: ['MEMBER'], joinedAt: new Date() },
          ],
        }),
      );
      groupRepository.findGroupsByMember.mockResolvedValueOnce([
        { id: 'g1', name: 'Sales' },
      ]);

      const result = await service.getUserGroups('user_1');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Sales');
    });
  });
});
