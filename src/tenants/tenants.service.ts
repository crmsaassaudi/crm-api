import { Injectable, ConflictException, Inject, forwardRef } from '@nestjs/common';
import { TenantsRepository } from './infrastructure/persistence/document/repositories/tenant.repository';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { Tenant } from './domain/tenant';
import { KeycloakAdminService } from '../auth/services/keycloak-admin.service';
import { UsersService } from '../users/users.service'; // Assuming UsersService handles shadow user creation
import { v4 as uuidv4 } from 'uuid';
import { RoleEnum } from '../roles/roles.enum'; // Check if this exists
import { AuthProvidersEnum } from '../auth/auth-providers.enum';

@Injectable()
export class TenantsService {
    constructor(
        private readonly tenantsRepository: TenantsRepository,
        private readonly keycloakAdminService: KeycloakAdminService,
        // Injecting UsersService might cause circular dependency if Users depend on Tenants. 
        // Usually Tenant creation uses UsersRepository directly or a specific service.
        // For now, assuming UsersService is safe.
        @Inject(forwardRef(() => UsersService))
        private readonly usersService: UsersService,
    ) { }

    async createTenant_Saga(createTenantDto: CreateTenantDto) {
        // 1. Validate
        const existingTenant = await this.tenantsRepository.findByDomain(createTenantDto.domain);
        if (existingTenant) {
            throw new ConflictException('Domain already exists');
        }

        // 2. DB: Create Tenant first to get the ObjectId
        const tenant = new Tenant();
        tenant.name = createTenantDto.name;
        tenant.domain = createTenantDto.domain;

        // Let DB generate ID
        let newTenant;
        try {
            newTenant = await this.tenantsRepository.create(tenant);
        } catch (error) {
            throw error;
        }

        const tenantId = newTenant.id;
        let keycloakUser;

        try {
            // 3. Keycloak: Create User with tenantId attribute = ObjectId
            keycloakUser = await this.keycloakAdminService.createUser(
                createTenantDto.adminEmail,
                tenantId,
                'admin', // Role name in Keycloak
            );

            try {
                await this.keycloakAdminService.resetPassword(keycloakUser.id);
            } catch (error) {
                console.warn('Failed to send password reset email to tenant admin', error);
            }

        } catch (error) {
            // Rollback: Delete Tenant
            console.error('Rollback: Deleting Tenant due to Keycloak failure', error);
            // We need to implement delete in Repository to support this rollback properly
            // await this.tenantsRepository.remove(tenantId);
            throw error;
        }

        try {
            // 4. DB: Create Shadow User
            const shadowUser = await this.usersService.create({
                email: createTenantDto.adminEmail,
                provider: AuthProvidersEnum.email,
                keycloakId: keycloakUser.id,
                firstName: null,
                lastName: null,
                role: { id: RoleEnum.admin } as any,
                tenants: [{ tenant: tenantId, roles: ['admin'], joinedAt: new Date() }],
            });

            // 5. Update Tenant with Owner
            try {
                newTenant.owner = shadowUser.id.toString();
                await this.tenantsRepository.update(tenantId, { owner: shadowUser.id.toString() });
            } catch (error) {
                console.error('Failed to assign owner to tenant', error);
                // Non-critical, we can continue
            }

        } catch (error) {
            // Rollback: Delete Keycloak User AND Tenant
            console.error('Rollback: Deleting Keycloak User and Tenant due to Shadow User failure', error);
            if (keycloakUser?.id) {
                await this.keycloakAdminService.deleteUser(keycloakUser.id);
            }
            // await this.tenantsRepository.remove(tenantId);
            throw error;
        }

        return newTenant;
    }

    async findById(id: string): Promise<Tenant | null> {
        return this.tenantsRepository.findById(id);
    }
}
