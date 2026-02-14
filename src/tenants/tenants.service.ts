import { Injectable, ConflictException, Inject, forwardRef, ServiceUnavailableException, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { TenantsRepository } from './infrastructure/persistence/document/repositories/tenant.repository';
import { TenantOnboardingDto } from './dto/tenant-onboarding.dto';
import { Tenant } from './domain/tenant';
import { KeycloakAdminService } from '../auth/services/keycloak-admin.service';
import { UsersService } from '../users/users.service';
import { RoleEnum } from '../roles/roles.enum';
import { AuthProvidersEnum } from '../auth/auth-providers.enum';
import { StatusEnum } from '../statuses/statuses.enum';
import { CreateTenantDto } from './dto/create-tenant.dto';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantCreatedEvent } from './events/tenant-created.event';

import { TransactionManager } from '../database/transaction-manager.service';
import { RedisLockService } from '../redis/redis-lock.service';

@Injectable()
export class TenantsService {
    private readonly logger = new Logger(TenantsService.name);

    constructor(
        private readonly tenantsRepository: TenantsRepository,
        private readonly keycloakAdminService: KeycloakAdminService,
        @Inject(forwardRef(() => UsersService))
        private readonly usersService: UsersService,
        @InjectConnection() private readonly connection: Connection,
        private readonly eventEmitter: EventEmitter2,
        private readonly txManager: TransactionManager,
        private readonly redisLock: RedisLockService,
    ) { }

    async onboardTenant(dto: TenantOnboardingDto) {
        const lockKey = `onboard:tenant:${dto.subdomain}`;

        // 1. Race Condition Prevention (Idempotency) using Redis Lock
        return await this.redisLock.acquire(lockKey, 10000, async () => {
            // 2. Pre-flight Validation
            const existingTenant = await this.tenantsRepository.findByDomain(dto.subdomain);
            if (existingTenant) {
                throw new ConflictException('Subdomain already exists');
            }

            const existingKeycloakUser = await this.keycloakAdminService.findUserByEmail(dto.adminEmail);
            if (existingKeycloakUser) {
                throw new ConflictException('Admin email already exists in Keycloak');
            }

            const existingLocalUser = await this.usersService.findByEmail(dto.adminEmail);
            if (existingLocalUser) {
                throw new ConflictException('Admin email already exists in system');
            }

            let keycloakGroupId: string | null = null;
            let keycloakUserId: string | null = null;

            try {
                // 3. External System Interactions (Keycloak) BEFORE DB Transaction
                // This prevents holding DB locks while waiting for external services
                const group = await this.keycloakAdminService.createGroup(dto.subdomain, { // Using subdomain as name for uniqueness
                    displayName: dto.companyName,
                    subdomain: dto.subdomain,
                    plan: dto.plan
                });
                keycloakGroupId = group.id;

                const user = await this.keycloakAdminService.createUser(
                    dto.adminEmail,
                    dto.subdomain,
                    dto.adminFirstName,
                    dto.adminLastName,
                    // We will assign roles/groups in next steps or via default logic if any
                );
                keycloakUserId = user.id;

                // Add user to the tenant group
                await this.keycloakAdminService.addUserToGroup(keycloakUserId, keycloakGroupId);

                // Trigger password reset email
                await this.keycloakAdminService.resetPassword(keycloakUserId);

                // 4. Local DB Transaction
                const result = await this.txManager.runInTransaction(async (session) => {
                    const tenant = new Tenant();
                    tenant.name = dto.companyName;
                    tenant.domain = dto.subdomain;
                    // tenant.plan = dto.plan; 
                    // tenant.status = 'ACTIVE'; 

                    const newTenant = await this.tenantsRepository.create(tenant, session);

                    // Create Shadow User
                    const shadowUser = await this.usersService.create({
                        email: dto.adminEmail,
                        firstName: dto.adminFirstName,
                        lastName: dto.adminLastName,
                        provider: AuthProvidersEnum.email,
                        keycloakId: keycloakUserId,
                        role: { id: RoleEnum.admin } as any,
                        status: { id: StatusEnum.active } as any,
                    }, newTenant.id.toString(), session);

                    // Update Tenant Owner
                    await this.tenantsRepository.update(newTenant.id.toString(), {
                        owner: shadowUser.id.toString()
                    }, session);

                    return {
                        id: newTenant.id.toString(),
                        companyName: dto.companyName,
                        status: 'ACTIVE'
                    };
                });

                // 5. Fire event (Out of transaction, when DB is committed)
                this.eventEmitter.emit(
                    'tenant.created',
                    new TenantCreatedEvent(result.id, dto.companyName, dto.adminEmail),
                );

                return result;

            } catch (error) {
                this.logger.error('Onboarding failed, rolling back Keycloak resources', error);

                // 6. Saga Compensation
                if (keycloakUserId) {
                    await this.keycloakAdminService.deleteUser(keycloakUserId).catch(e =>
                        this.logger.error('Failed to cleanup user during rollback', e)
                    );
                }
                if (keycloakGroupId) {
                    await this.keycloakAdminService.deleteGroup(keycloakGroupId).catch(e =>
                        this.logger.error('Failed to cleanup group during rollback', e)
                    );
                }

                if (error instanceof ConflictException || error instanceof ServiceUnavailableException) {
                    throw error;
                }
                throw new InternalServerErrorException('Onboarding process failed');
            }
        });
    }

    async findById(id: string): Promise<Tenant | null> {
        return this.tenantsRepository.findById(id);
    }
}
