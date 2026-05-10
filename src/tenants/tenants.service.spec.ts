import { Test, TestingModule } from '@nestjs/testing';
import { TenantsService } from './tenants.service';
import { TenantsRepository } from './infrastructure/persistence/document/repositories/tenant.repository';
import { TenantAliasReservationRepository } from './infrastructure/persistence/document/repositories/tenant-alias-reservation.repository';
import { KeycloakAdminService } from '../auth/services/keycloak-admin.service';
import { UserRepository } from '../users/infrastructure/persistence/user.repository';
import { getConnectionToken } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RegisterTenantDto } from './dto/register-tenant.dto';
import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

describe('TenantsService', () => {
  let service: TenantsService;
  let tenantsRepository: TenantsRepository;
  let keycloakAdminService: KeycloakAdminService;
  let aliasReservationRepository: any;
  let userRepository: any;
  let eventEmitter: EventEmitter2;
  let connection: any;
  let session: any;

  beforeEach(async () => {
    session = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
    };

    connection = {
      startSession: jest.fn().mockResolvedValue(session),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantsService,
        {
          provide: TenantsRepository,
          useValue: {
            findByAlias: jest.fn(),
            create: jest.fn(),
            updateById: jest.fn(),
            updateOwner: jest.fn(),
            findById: jest.fn(),
          },
        },
        {
          provide: KeycloakAdminService,
          useValue: {
            findUserByEmail: jest.fn().mockResolvedValue(null),
            createOrganization: jest.fn().mockResolvedValue({ id: 'kc-org-1' }),
            createUser: jest.fn().mockResolvedValue({ id: 'kc-user-1' }),
            updateUser: jest.fn(),
            addUserToOrganization: jest.fn().mockResolvedValue(undefined),
            resetPassword: jest.fn(),
            deleteOrganization: jest.fn().mockResolvedValue(undefined),
            deleteUser: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: TenantAliasReservationRepository,
          useValue: {
            reserve: jest.fn().mockResolvedValue(undefined),
            confirm: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: UserRepository,
          useValue: {
            upsertWithTenants: jest.fn().mockResolvedValue({ id: 'shadow-1' }),
          },
        },
        {
          provide: getConnectionToken(),
          useValue: connection,
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'keycloak.frontendUrl') return 'https://crmsaudi.dev';
              if (key === 'app.rootDomain') return 'crmsaudi.dev';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<TenantsService>(TenantsService);
    tenantsRepository = module.get<TenantsRepository>(TenantsRepository);
    keycloakAdminService =
      module.get<KeycloakAdminService>(KeycloakAdminService);
    aliasReservationRepository = module.get<TenantAliasReservationRepository>(
      TenantAliasReservationRepository,
    );
    userRepository = module.get<UserRepository>(UserRepository);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('register', () => {
    const dto: RegisterTenantDto = {
      organizationName: 'Test Company',
      organizationAlias: 'test-company',
      email: 'admin@test.com',
      fullName: 'John Doe',
      password: 'testPassword123!',
    };

    it('should successfully onboard a tenant', async () => {
      // Mock Data
      const localTenantId = 'local-tenant-id';
      const keycloakGroupId = 'keycloak-group-id';
      const keycloakUserId = 'keycloak-user-id';
      const shadowUserId = 'shadow-user-id';

      // Mocks
      (tenantsRepository.findByAlias as jest.Mock) = jest
        .fn()
        .mockResolvedValue(null);
      (keycloakAdminService.findUserByEmail as jest.Mock) = jest
        .fn()
        .mockResolvedValue(null);

      (tenantsRepository.create as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ id: localTenantId });
      (keycloakAdminService.createOrganization as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ id: keycloakGroupId });
      (keycloakAdminService.createUser as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ id: keycloakUserId });
      (userRepository.upsertWithTenants as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ id: shadowUserId });

      // Execution
      const result = await service.register(dto);

      // Assertions
      expect(result).toEqual({
        tenantId: localTenantId,
        organizationName: dto.organizationName,
        alias: dto.organizationAlias,
        keycloakOrgId: keycloakGroupId,
        loginUrl: expect.any(String),
      });

      // 1. Validation
      expect(aliasReservationRepository.reserve).toHaveBeenCalledWith(
        dto.organizationAlias,
      );
      expect(keycloakAdminService.findUserByEmail).toHaveBeenCalledWith(
        dto.email,
      );

      // 3. Local Tenant Creation
      expect(tenantsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: dto.organizationName,
          alias: dto.organizationAlias,
        }),
      );

      // 4. Keycloak Group
      expect(keycloakAdminService.createOrganization).toHaveBeenCalledWith(
        dto.organizationName,
        dto.organizationAlias,
      );

      // 5. Keycloak User
      expect(keycloakAdminService.createUser).toHaveBeenCalledWith(
        dto.email,
        dto.password,
        dto.fullName,
      );

      // 6. Config
      expect(keycloakAdminService.addUserToOrganization).toHaveBeenCalledWith(
        keycloakGroupId,
        keycloakUserId,
      );

      // 7. Local User & Tenant Update
      expect(userRepository.upsertWithTenants).toHaveBeenCalledWith(
        keycloakUserId,
        dto.email,
        expect.objectContaining({
          firstName: 'John',
          lastName: 'Doe',
          keycloakId: keycloakUserId,
        }),
        expect.any(Array),
      );

      expect(tenantsRepository.updateOwner).toHaveBeenCalledWith(
        localTenantId,
        shadowUserId,
      );
      expect(aliasReservationRepository.confirm).toHaveBeenCalledWith(
        dto.organizationAlias,
      );

      // 8. Event
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'tenant.created',
        expect.anything(),
      );
    });

    it('should throw ConflictException if alias exists', async () => {
      (aliasReservationRepository.reserve as jest.Mock) = jest
        .fn()
        .mockRejectedValue(new ConflictException('Alias already taken'));

      await expect(service.register(dto)).rejects.toThrow(ConflictException);
    });

    it('should rollback and delete group if Keycloak user creation fails', async () => {
      const localTenantId = 'local-tenant-id';
      const keycloakGroupId = 'keycloak-group-id';

      (keycloakAdminService.findUserByEmail as jest.Mock) = jest
        .fn()
        .mockResolvedValue(null);
      (tenantsRepository.create as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ id: localTenantId });
      (keycloakAdminService.createOrganization as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ id: keycloakGroupId });

      // Fail here
      (keycloakAdminService.createUser as jest.Mock) = jest
        .fn()
        .mockRejectedValue(new Error('Keycloak Error'));

      await expect(service.register(dto)).rejects.toThrow(
        InternalServerErrorException,
      );

      expect(keycloakAdminService.deleteOrganization).toHaveBeenCalledWith(
        keycloakGroupId,
      );
      expect(aliasReservationRepository.delete).toHaveBeenCalledWith(
        dto.organizationAlias,
      );
    });

    it('should rollback and delete user/group if local user creation fails', async () => {
      const localTenantId = 'local-tenant-id';
      const keycloakGroupId = 'keycloak-group-id';
      const keycloakUserId = 'keycloak-user-id';

      (keycloakAdminService.findUserByEmail as jest.Mock) = jest
        .fn()
        .mockResolvedValue(null);
      (tenantsRepository.create as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ id: localTenantId });
      (keycloakAdminService.createOrganization as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ id: keycloakGroupId });
      (keycloakAdminService.createUser as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ id: keycloakUserId });

      // Fail here
      (userRepository.upsertWithTenants as jest.Mock) = jest
        .fn()
        .mockRejectedValue(new Error('DB Error'));

      await expect(service.register(dto)).rejects.toThrow(
        InternalServerErrorException,
      );

      expect(keycloakAdminService.deleteUser).toHaveBeenCalledWith(
        keycloakUserId,
      );
      expect(keycloakAdminService.deleteOrganization).toHaveBeenCalledWith(
        keycloakGroupId,
      );
    });
  });
});
