
import { Test, TestingModule } from '@nestjs/testing';
import { TenantsService } from './tenants.service';
import { TenantsRepository } from './infrastructure/persistence/document/repositories/tenant.repository';
import { KeycloakAdminService } from '../auth/services/keycloak-admin.service';
import { UsersService } from '../users/users.service';
import { getConnectionToken } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantOnboardingDto, TenantPlan } from './dto/tenant-onboarding.dto';
import { ConflictException, ServiceUnavailableException, InternalServerErrorException } from '@nestjs/common';
import { RoleEnum } from '../roles/roles.enum';
import { AuthProvidersEnum } from '../auth/auth-providers.enum';
import { StatusEnum } from '../statuses/statuses.enum';

describe('TenantsService', () => {
    let service: TenantsService;
    let tenantsRepository: TenantsRepository;
    let keycloakAdminService: KeycloakAdminService;
    let usersService: UsersService;
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
                        findByDomain: jest.fn(),
                        create: jest.fn(),
                        update: jest.fn(),
                        findById: jest.fn(),
                    },
                },
                {
                    provide: KeycloakAdminService,
                    useValue: {
                        findUserByEmail: jest.fn(),
                        createGroup: jest.fn(),
                        createUser: jest.fn(),
                        updateUser: jest.fn(),
                        addUserToGroup: jest.fn(),
                        resetPassword: jest.fn(),
                        deleteGroup: jest.fn(),
                        deleteUser: jest.fn(),
                    },
                },
                {
                    provide: UsersService,
                    useValue: {
                        findByEmail: jest.fn(),
                        create: jest.fn(),
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
            ],
        }).compile();

        service = module.get<TenantsService>(TenantsService);
        tenantsRepository = module.get<TenantsRepository>(TenantsRepository);
        keycloakAdminService = module.get<KeycloakAdminService>(KeycloakAdminService);
        usersService = module.get<UsersService>(UsersService);
        eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('onboardTenant', () => {
        const dto: TenantOnboardingDto = {
            companyName: 'Test Company',
            subdomain: 'test-company',
            adminEmail: 'admin@test.com',
            adminFirstName: 'John',
            adminLastName: 'Doe',
            plan: TenantPlan.PRO,
        };

        it('should successfully onboard a tenant', async () => {
            // Mock Data
            const localTenantId = 'local-tenant-id';
            const keycloakGroupId = 'keycloak-group-id';
            const keycloakUserId = 'keycloak-user-id';
            const shadowUserId = 'shadow-user-id';

            // Mocks
            (tenantsRepository.findByDomain as jest.Mock).mockResolvedValue(null);
            (keycloakAdminService.findUserByEmail as jest.Mock).mockResolvedValue(null);
            (usersService.findByEmail as jest.Mock).mockResolvedValue(null);

            (tenantsRepository.create as jest.Mock).mockResolvedValue({ id: localTenantId });
            (keycloakAdminService.createGroup as jest.Mock).mockResolvedValue({ id: keycloakGroupId });
            (keycloakAdminService.createUser as jest.Mock).mockResolvedValue({ id: keycloakUserId });
            (usersService.create as jest.Mock).mockResolvedValue({ id: shadowUserId });

            // Execution
            const result = await service.onboardTenant(dto);

            // Assertions
            expect(result).toEqual({
                id: localTenantId,
                companyName: dto.companyName,
                status: 'ACTIVE',
            });

            // 1. Validation
            expect(tenantsRepository.findByDomain).toHaveBeenCalledWith(dto.subdomain);
            expect(keycloakAdminService.findUserByEmail).toHaveBeenCalledWith(dto.adminEmail);
            expect(usersService.findByEmail).toHaveBeenCalledWith(dto.adminEmail);

            // 2. Transaction
            expect(connection.startSession).toHaveBeenCalled();
            expect(session.startTransaction).toHaveBeenCalled();

            // 3. Local Tenant Creation
            expect(tenantsRepository.create).toHaveBeenCalledWith(expect.objectContaining({
                name: dto.companyName,
                domain: dto.subdomain,
            }), session);

            // 4. Keycloak Group
            expect(keycloakAdminService.createGroup).toHaveBeenCalledWith(localTenantId, {
                displayName: dto.companyName,
                subdomain: dto.subdomain,
                plan: dto.plan,
            });

            // 5. Keycloak User
            expect(keycloakAdminService.createUser).toHaveBeenCalledWith(dto.adminEmail, localTenantId);
            expect(keycloakAdminService.updateUser).toHaveBeenCalledWith(keycloakUserId, {
                firstName: dto.adminFirstName,
                lastName: dto.adminLastName,
            });

            // 6. Config
            expect(keycloakAdminService.addUserToGroup).toHaveBeenCalledWith(keycloakUserId, keycloakGroupId);
            expect(keycloakAdminService.resetPassword).toHaveBeenCalledWith(keycloakUserId);

            // 7. Local User & Tenant Update
            expect(usersService.create).toHaveBeenCalledWith(expect.objectContaining({
                email: dto.adminEmail,
                firstName: dto.adminFirstName,
                lastName: dto.adminLastName,
                provider: AuthProvidersEnum.email,
                keycloakId: keycloakUserId,
                role: { id: RoleEnum.admin },
                status: { id: StatusEnum.active }
            }), localTenantId, session);

            expect(tenantsRepository.update).toHaveBeenCalledWith(localTenantId, expect.objectContaining({
                owner: shadowUserId,
                // status: 'ACTIVE' // check implementation
            }), session);

            // 8. Commit & Event
            expect(session.commitTransaction).toHaveBeenCalled();
            expect(eventEmitter.emit).toHaveBeenCalledWith('tenant.created', expect.anything());
        });

        it('should throw ConflictException if subdomain exists', async () => {
            (tenantsRepository.findByDomain as jest.Mock).mockResolvedValue({ id: 'existing' });

            await expect(service.onboardTenant(dto)).rejects.toThrow(ConflictException);
            expect(session.startTransaction).not.toHaveBeenCalled();
        });

        it('should rollback and delete group if Keycloak user creation fails', async () => {
            const localTenantId = 'local-tenant-id';
            const keycloakGroupId = 'keycloak-group-id';

            (tenantsRepository.findByDomain as jest.Mock).mockResolvedValue(null);
            (keycloakAdminService.findUserByEmail as jest.Mock).mockResolvedValue(null);
            (usersService.findByEmail as jest.Mock).mockResolvedValue(null);
            (tenantsRepository.create as jest.Mock).mockResolvedValue({ id: localTenantId });
            (keycloakAdminService.createGroup as jest.Mock).mockResolvedValue({ id: keycloakGroupId });

            // Fail here
            (keycloakAdminService.createUser as jest.Mock).mockRejectedValue(new Error('Keycloak Error'));

            await expect(service.onboardTenant(dto)).rejects.toThrow(ServiceUnavailableException);

            expect(keycloakAdminService.deleteGroup).toHaveBeenCalledWith(keycloakGroupId);
            expect(session.abortTransaction).toHaveBeenCalled();
        });

        it('should rollback and delete user/group if local user creation fails', async () => {
            const localTenantId = 'local-tenant-id';
            const keycloakGroupId = 'keycloak-group-id';
            const keycloakUserId = 'keycloak-user-id';

            (tenantsRepository.findByDomain as jest.Mock).mockResolvedValue(null);
            (keycloakAdminService.findUserByEmail as jest.Mock).mockResolvedValue(null);
            (usersService.findByEmail as jest.Mock).mockResolvedValue(null);
            (tenantsRepository.create as jest.Mock).mockResolvedValue({ id: localTenantId });
            (keycloakAdminService.createGroup as jest.Mock).mockResolvedValue({ id: keycloakGroupId });
            (keycloakAdminService.createUser as jest.Mock).mockResolvedValue({ id: keycloakUserId });

            // Fail here
            (usersService.create as jest.Mock).mockRejectedValue(new Error('DB Error'));

            await expect(service.onboardTenant(dto)).rejects.toThrow(InternalServerErrorException);

            expect(keycloakAdminService.deleteUser).toHaveBeenCalledWith(keycloakUserId);
            expect(keycloakAdminService.deleteGroup).toHaveBeenCalledWith(keycloakGroupId);
            expect(session.abortTransaction).toHaveBeenCalled();
        });
    });
});
