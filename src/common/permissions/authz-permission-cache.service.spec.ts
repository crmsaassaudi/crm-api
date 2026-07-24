import { ModuleRef } from '@nestjs/core';
import { AuthzPermissionCacheService } from './authz-permission-cache.service';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import { TenantsRepository } from '../../tenants/infrastructure/persistence/document/repositories/tenant.repository';
import { GroupRepository } from '../../groups/infrastructure/persistence/document/repositories/group.repository';
import { CustomRolesService } from './custom-roles.service';

describe('AuthzPermissionCacheService', () => {
  const tenantId = '507f1f77bcf86cd799439011';
  const userId = '507f1f77bcf86cd799439012';
  let redisClient: any;
  let moduleRef: jest.Mocked<ModuleRef>;
  let userRepository: any;
  let tenantsRepository: any;
  let groupRepository: any;
  let customRolesService: any;
  let cls: { set: jest.Mock };
  let service: AuthzPermissionCacheService;

  beforeEach(() => {
    const pipeline = {
      del: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    redisClient = {
      exists: jest.fn().mockResolvedValue(0),
      sismember: jest.fn().mockResolvedValue(0),
      del: jest.fn().mockResolvedValue(1),
      pipeline: jest.fn().mockReturnValue(pipeline),
      scan: jest.fn().mockResolvedValue(['0', []]),
    };
    userRepository = {
      findByIdsGlobal: jest.fn().mockResolvedValue([
        {
          id: userId,
          email: 'user@example.com',
          tenants: [{ tenantId, roles: [], joinedAt: new Date() }],
        },
      ]),
      findByKeycloakIdAndProvider: jest.fn(),
    };
    tenantsRepository = {
      findById: jest.fn().mockResolvedValue({
        id: tenantId,
        ownerId: 'owner_1',
        availablePermissions: null,
        disabledCorePermissions: [],
      }),
      findByAlias: jest.fn(),
      findByKeycloakOrgId: jest.fn(),
    };
    groupRepository = {
      findGroupsByMemberWithAncestors: jest
        .fn()
        .mockResolvedValue([
          { memberIds: [userId], permissions: ['contacts:view'] },
        ]),
    };
    customRolesService = {
      findAll: jest.fn().mockResolvedValue([]),
    };
    moduleRef = {
      get: jest.fn((token) => {
        if (token === UserRepository) return userRepository;
        if (token === TenantsRepository) return tenantsRepository;
        if (token === GroupRepository) return groupRepository;
        if (token === CustomRolesService) return customRolesService;
        return null;
      }),
    } as any;

    cls = {
      set: jest.fn(),
    };

    service = new AuthzPermissionCacheService(
      moduleRef,
      {
        getClient: () => redisClient,
      } as any,
      cls as any,
    );
  });

  it('should use Redis SISMEMBER on cache hit without querying MongoDB', async () => {
    redisClient.exists.mockResolvedValueOnce(1);
    redisClient.sismember.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const result = await service.canAccess({
      rawUserId: userId,
      tenantHint: tenantId,
      rule: { action: 'view', resource: 'contacts' },
    });

    expect(result.allowed).toBe(true);
    expect(result.cacheHit).toBe(true);
    expect(redisClient.sismember).toHaveBeenCalledWith(
      `authz:t:${tenantId}:u:${userId}:perms`,
      'contacts:view',
    );
    expect(userRepository.findByIdsGlobal).not.toHaveBeenCalled();
    expect(
      groupRepository.findGroupsByMemberWithAncestors,
    ).not.toHaveBeenCalled();
  });

  it('should populate Redis SET on cache miss', async () => {
    const result = await service.canAccess({
      rawUserId: userId,
      tenantHint: tenantId,
      rule: { action: 'view', resource: 'contacts' },
    });

    const pipeline = redisClient.pipeline.mock.results[0].value;
    expect(result.allowed).toBe(true);
    expect(result.cacheHit).toBe(false);
    expect(groupRepository.findGroupsByMemberWithAncestors).toHaveBeenCalledWith(
      tenantId,
      userId,
    );
    expect(cls.set).toHaveBeenCalledWith('activeTenantId', tenantId);
    expect(pipeline.sadd).toHaveBeenCalledWith(
      `authz:t:${tenantId}:u:${userId}:perms`,
      'contacts:view',
    );
    expect(pipeline.expire).toHaveBeenCalledWith(
      `authz:t:${tenantId}:u:${userId}:perms`,
      300,
    );
  });

  it('should continue with repository permission lookup when Redis read fails', async () => {
    redisClient.exists.mockRejectedValueOnce(new Error('redis offline'));

    const result = await service.canAccess({
      rawUserId: userId,
      tenantHint: tenantId,
      rule: { action: 'view', resource: 'contacts' },
    });

    expect(result.allowed).toBe(true);
    expect(result.cacheHit).toBe(false);
    expect(userRepository.findByIdsGlobal).toHaveBeenCalledWith([userId]);
    expect(groupRepository.findGroupsByMemberWithAncestors).toHaveBeenCalledWith(
      tenantId,
      userId,
    );
  });

  it('should not fail authorization when Redis populate fails', async () => {
    redisClient.pipeline.mockReturnValueOnce({
      del: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockRejectedValue(new Error('redis offline')),
    });

    const result = await service.canAccess({
      rawUserId: userId,
      tenantHint: tenantId,
      rule: { action: 'view', resource: 'contacts' },
    });

    expect(result.allowed).toBe(true);
    expect(result.cacheHit).toBe(false);
  });
});
