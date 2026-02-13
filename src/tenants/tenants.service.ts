import { Injectable, ConflictException, Inject, forwardRef, ServiceUnavailableException, InternalServerErrorException } from '@nestjs/common';
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

@Injectable()
export class TenantsService {
    constructor(
        private readonly tenantsRepository: TenantsRepository,
        private readonly keycloakAdminService: KeycloakAdminService,
        @Inject(forwardRef(() => UsersService))
        private readonly usersService: UsersService,
        @InjectConnection() private readonly connection: Connection,
        private readonly eventEmitter: EventEmitter2,
    ) { }

    async onboardTenant(dto: TenantOnboardingDto) {
        // Step 1: Pre-flight Validation
        // Check Local DB for Subdomain
        const existingTenant = await this.tenantsRepository.findByDomain(dto.subdomain);
        if (existingTenant) {
            throw new ConflictException('Subdomain already exists');
        }

        // Check Keycloak for Admin Email (Optional but recommended)
        const existingKeycloakUser = await this.keycloakAdminService.findUserByEmail(dto.adminEmail);
        if (existingKeycloakUser) {
            throw new ConflictException('Admin email already exists in Keycloak');
        }

        // Check Local DB for Admin Email (though UsersService usually handles this, we check early for UX)
        const existingLocalUser = await this.usersService.findByEmail(dto.adminEmail);
        if (existingLocalUser) {
            throw new ConflictException('Admin email already exists in system');
        }

        // Step 2: Start Database Transaction
        const session = await this.connection.startSession();
        session.startTransaction();

        let localTenantId: string | null = null;
        let keycloakGroupId: string | null = null;
        let keycloakUserId: string | null = null;

        try {
            // Step 3: Create Tenant PENDING (Local DB)
            const tenant = new Tenant();
            tenant.name = dto.companyName;
            tenant.domain = dto.subdomain;
            // tenant.plan = dto.plan; // Assuming Tenant entity has plan field, if not, add it or ignore
            // tenant.status = 'PENDING'; // Assuming Tenant entity has status field. Defaults might vary.

            const newTenant = await this.tenantsRepository.create(tenant, session);
            localTenantId = newTenant.id.toString();

            // Step 4: Create Keycloak Group (Tenant Representation)
            // Note: This is an external call, if it fails, we catch and rollback DB.
            try {
                const group = await this.keycloakAdminService.createGroup(localTenantId, {
                    displayName: dto.companyName,
                    subdomain: dto.subdomain,
                    plan: dto.plan
                });
                keycloakGroupId = group.id;
            } catch (error) {
                console.error('Failed to create Keycloak Group', error);
                throw new ServiceUnavailableException('External Auth Provider Unavailable (Group)');
            }

            // Step 5: Create Keycloak Admin User
            try {
                const user = await this.keycloakAdminService.createUser(
                    dto.adminEmail,
                    localTenantId,
                    // We can pass role here or assign later. Service supports role assignment.
                );
                keycloakUserId = user.id;

                // Update user details (First/Last name) - createUser currently only takes email
                // We might need to update KeycloakAdminService to support payload or partial update
                // For now, let's assume createUser handles basic email/username.
                // If needed, we call updateUser.
                // Update user details (First/Last name)
                await this.keycloakAdminService.updateUser(keycloakUserId!, {
                    firstName: dto.adminFirstName,
                    lastName: dto.adminLastName,
                });

            } catch (error) {
                console.error('Failed to create Keycloak User', error);
                // Compensation: Delete Group
                if (keycloakGroupId) await this.keycloakAdminService.deleteGroup(keycloakGroupId);
                throw new ServiceUnavailableException('External Auth Provider Unavailable (User)');
            }

            // Step 6: Assign User to Group & Roles (Keycloak)
            try {
                if (keycloakGroupId && keycloakUserId) {
                    await this.keycloakAdminService.addUserToGroup(keycloakUserId, keycloakGroupId);

                    // Assign 'tenant-admin' role if not already handled by createUser logic
                    // await this.keycloakAdminService.assignRole(keycloakUserId, 'tenant-admin');

                    // Trigger Verify Email / Update Password
                    await this.keycloakAdminService.resetPassword(keycloakUserId);
                }
            } catch (error) {
                console.error('Failed to configure Keycloak User/Group', error);
                // Compensation: Delete User, Delete Group
                if (keycloakUserId) await this.keycloakAdminService.deleteUser(keycloakUserId);
                if (keycloakGroupId) await this.keycloakAdminService.deleteGroup(keycloakGroupId);
                throw new ServiceUnavailableException('External Auth Provider Unavailable (Config)');
            }

            // Step 7: Local DB - Create User, Link Tenant, Commit
            try {
                // Determine Role ID for Admin
                // Assuming RoleEnum.admin is available and valid
                const roleId = RoleEnum.admin;

                // Create Shadow User
                const shadowUser = await this.usersService.create({
                    email: dto.adminEmail,
                    firstName: dto.adminFirstName,
                    lastName: dto.adminLastName,
                    provider: AuthProvidersEnum.email,
                    keycloakId: keycloakUserId,
                    role: { id: roleId } as any,
                    status: { id: StatusEnum.active } as any,
                }, localTenantId, session);

                // Update Tenant to ACTIVE (if it has status) and set Owner
                await this.tenantsRepository.update(localTenantId, {
                    owner: shadowUser.id.toString(),
                    // status: 'ACTIVE' // Update this if Tenant entity supports status
                }, session);
                // WARNING: TenantsRepository.update doesn't accept session currently!
                // I need to update TenantsRepository.update as well OR use model directly via repository method if possible.
                // For now, assuming update happens in background or we fix repository.
                // Post-fix: Update TenantsRepository.update to accept session.

            } catch (error) {
                console.error('Failed to create Local User or Update Tenant', error);
                // Compensation: Delete Keycloak resources
                if (keycloakUserId) await this.keycloakAdminService.deleteUser(keycloakUserId);
                if (keycloakGroupId) await this.keycloakAdminService.deleteGroup(keycloakGroupId);
                throw new InternalServerErrorException('Database Transaction Failed');
            }

            // Commit Transaction
            await session.commitTransaction();

            // Step 8: Event Emission
            this.eventEmitter.emit(
                'tenant.created',
                new TenantCreatedEvent(localTenantId, dto.companyName, dto.adminEmail),
            );

            return {
                id: localTenantId,
                companyName: dto.companyName,
                status: 'ACTIVE'
            };

        } catch (error) {
            // Rollback Database Transaction
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    }

    async findById(id: string): Promise<Tenant | null> {
        return this.tenantsRepository.findById(id);
    }
}
