import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  UnprocessableEntityException,
} from '@nestjs/common';
import { USER_ERRORS } from './constants/user-error-codes';
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
  let sessionService: any;

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

    sessionService = {
      deleteAllSessionsForUser: jest.fn().mockResolvedValue(undefined),
    };

    service = new UsersService(
      usersRepository,
      filesService,
      cls as any,
      keycloakAdminService,
      sessionService,
      tenantsRepository,
      groupRepository,
      eventEmitter as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      {
        findAll: jest.fn().mockResolvedValue([]),
        // Tenant without seeded system roles → invite falls back to no baseline.
        findBySystemKey: jest.fn().mockResolvedValue(null),
      } as any,
      // AuthzPermissionCacheService — backs the C-04 anti-escalation check.
      // Default: the caller has full access, so grants are permitted and these
      // tests exercise the behaviour they were written for. Escalation-specific
      // cases override explainForUser per test.
      {
        explainForUser: jest.fn().mockResolvedValue({
          effective: [],
          sources: {},
          tenantCeiling: [],
          fullAccess: true,
          fullAccessReason: 'admin',
        }),
      } as any,
      // ModuleRef — used only for the lazy OrgUnitRepository lookup that
      // validates `orgUnitId`. Resolves to a unit by default so the existing
      // update tests, which do not set orgUnitId, are unaffected; a test that
      // needs the rejection path overrides `findById` to return null.
      {
        get: jest.fn().mockReturnValue({
          findById: jest.fn().mockResolvedValue({ id: 'unit_1' }),
        }),
      } as any,
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

    // ── tenantRole is a grant, and the widest one there is ──────────────────
    // `roles: ['ADMIN']` seeds the membership with the whole tenant ceiling and
    // bypasses every data-visibility axis. This endpoint only requires
    // `users:create`, so without these checks anyone who can add a teammate
    // could mint themselves a fully privileged second account.
    it('should refuse ADMIN from a caller who does not hold full access', async () => {
      (service as any).authzCache.explainForUser.mockResolvedValueOnce({
        effective: ['users:create'],
        sources: {},
        tenantCeiling: ['users:create', 'contacts:view'],
        fullAccess: false,
      });

      await expect(
        service.invite({ email: 'escalate@test.com', tenantRole: 'ADMIN' }),
      ).rejects.toThrow(ForbiddenException);

      expect(usersRepository.create).not.toHaveBeenCalled();
      expect(keycloakAdminService.createUser).not.toHaveBeenCalled();
    });

    it('should allow ADMIN from a caller who does hold full access', async () => {
      await service.invite({ email: 'ok-admin@test.com', tenantRole: 'ADMIN' });

      expect(usersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenants: expect.arrayContaining([
            expect.objectContaining({ roles: ['ADMIN'] }),
          ]),
        }),
      );
    });

    it('should refuse OWNER outright — ownership is transferred, not invited', async () => {
      await expect(
        service.invite({ email: 'owner@test.com', tenantRole: 'OWNER' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // INVITE PLACEMENT — org unit / manager / groups
  //
  // A member with no org unit resolves every ORG_UNIT scope to an empty set,
  // so they pass each `:view` guard and then see an empty list. Placement at
  // invite time is what stops a new teammate landing in that state.
  // ═══════════════════════════════════════════════════════════════════
  describe('invite placement', () => {
    /** The acting principal, filed in the active tenant. */
    const inviter = (orgUnitId: string | null) =>
      createUser({
        id: 'user_1',
        tenants: [
          {
            tenantId: 'tenant_1',
            roles: ['ADMIN'],
            orgUnitId,
            joinedAt: new Date(),
          } as any,
        ],
      });

    const membershipFor = (call: any, tenantId = 'tenant_1') =>
      call.tenants.find((t: any) => t.tenantId === tenantId);

    it('should inherit the inviter’s org unit and manager by default', async () => {
      usersRepository.findById.mockResolvedValue(inviter('unit_sales'));

      await service.invite({ email: 'placed@test.com' });

      const created = usersRepository.create.mock.calls[0][0];
      expect(membershipFor(created)).toMatchObject({
        orgUnitId: 'unit_sales',
        reportsToId: 'user_1',
      });
    });

    it('should prefer an explicitly supplied org unit', async () => {
      usersRepository.findById.mockResolvedValue(inviter('unit_sales'));

      await service.invite({
        email: 'explicit@test.com',
        orgUnitId: 'unit_support',
      });

      const created = usersRepository.create.mock.calls[0][0];
      expect(membershipFor(created).orgUnitId).toBe('unit_support');
    });

    it('should reject an org unit from another tenant', async () => {
      (service as any).moduleRef.get.mockReturnValueOnce({
        findById: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.invite({ email: 'foreign@test.com', orgUnitId: 'unit_other' }),
      ).rejects.toThrow(UnprocessableEntityException);

      expect(usersRepository.create).not.toHaveBeenCalled();
    });

    // Placement lives on the membership, so joining a second workspace writes a
    // second placement rather than overwriting the first. This is the whole
    // reason the fields moved off the user document.
    it('should place an existing user without touching their other tenant', async () => {
      usersRepository.findByEmail.mockResolvedValueOnce(
        createUser({
          id: 'existing_1',
          keycloakId: 'kc_existing',
          tenants: [
            {
              tenantId: 'other_tenant',
              roles: ['MEMBER'],
              orgUnitId: 'unit_from_other_tenant',
              joinedAt: new Date(),
            } as any,
          ],
        }),
      );

      await service.invite({
        email: 'existing@test.com',
        orgUnitId: 'unit_support',
      });

      const [, , , newTenants] =
        usersRepository.upsertWithTenants.mock.calls[0];
      expect(newTenants).toEqual([
        expect.objectContaining({
          tenantId: 'tenant_1',
          orgUnitId: 'unit_support',
        }),
      ]);
      // Nothing was written to the user document itself, so the other tenant's
      // placement cannot have been disturbed.
      expect(usersRepository.update).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // REMOVE — tenant owner protection, event emission
  // ═══════════════════════════════════════════════════════════════════
  describe('update authorization grants', () => {
    it('should reject a newly added allow override', async () => {
      usersRepository.findById.mockResolvedValue(
        createUser({
          id: 'target_user',
          tenants: [
            {
              tenantId: 'tenant_1',
              roles: ['MEMBER'],
              permissionOverrides: {},
              joinedAt: new Date(),
            } as any,
          ],
        }),
      );

      await expect(
        service.update('target_user', {
          tenants: [
            {
              tenantId: 'tenant_1',
              roles: ['MEMBER'],
              permissionOverrides: { 'contacts:delete': true },
              joinedAt: new Date(),
            },
          ],
        } as any),
      ).rejects.toThrow(BadRequestException);

      expect(usersRepository.update).not.toHaveBeenCalled();
    });

    // The field is gone from the schema, but a stale client may still send it.
    // It must be dropped rather than written back as an unenforced grant.
    it('should ignore a legacy per-user permissions array', async () => {
      usersRepository.findById.mockResolvedValue(
        createUser({
          id: 'target_user',
          tenants: [
            {
              tenantId: 'tenant_1',
              roles: ['MEMBER'],
              joinedAt: new Date(),
            } as any,
          ],
        }),
      );

      await service.update('target_user', {
        tenants: [
          {
            tenantId: 'tenant_1',
            roles: ['MEMBER'],
            permissions: ['contacts:delete'],
            joinedAt: new Date(),
          },
        ],
      } as any);

      const persisted = usersRepository.update.mock.calls[0][1];
      expect(persisted.tenants[0]).not.toHaveProperty('permissions');
    });
  });

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
      // Losing tenant access revokes their live session rather than waiting
      // out the 24h TTL.
      expect(sessionService.deleteAllSessionsForUser).toHaveBeenCalledWith(
        'user_to_remove',
      );
    });

    it('should throw a 404 carrying USER_NOT_FOUND when user not found', async () => {
      // Asserting the STATUS and CODE rather than the exception class: the class is an
      // implementation detail, while the 404 and the code are the contract the client
      // and its localised message depend on.
      await expect(
        service.removeFromTenant('nonexistent'),
      ).rejects.toMatchObject({
        errorCode: USER_ERRORS.NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // UPDATE STATUS — session revocation on deactivation
  // ═══════════════════════════════════════════════════════════════════
  describe('updateStatus', () => {
    it('should revoke sessions when a user is deactivated', async () => {
      usersRepository.findById.mockResolvedValueOnce(
        createUser({ id: 'user_1', status: { id: 'active' } as any }),
      );
      usersRepository.update.mockResolvedValueOnce(
        createUser({ id: 'user_1', status: { id: 'inactive' } as any }),
      );

      await service.updateStatus('user_1', { id: 'inactive' } as any);

      expect(sessionService.deleteAllSessionsForUser).toHaveBeenCalledWith(
        'user_1',
      );
    });

    it('should not revoke sessions when a user stays active', async () => {
      usersRepository.findById.mockResolvedValueOnce(
        createUser({ id: 'user_1', status: { id: 'active' } as any }),
      );
      usersRepository.update.mockResolvedValueOnce(
        createUser({ id: 'user_1', status: { id: 'active' } as any }),
      );

      await service.updateStatus('user_1', { id: 'active' } as any);

      expect(sessionService.deleteAllSessionsForUser).not.toHaveBeenCalled();
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
