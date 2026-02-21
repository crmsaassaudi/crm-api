import {
    Injectable,
    Logger,
    UnauthorizedException,
    InternalServerErrorException,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../../config/config.type';
import KcAdminClient from '@keycloak/keycloak-admin-client';

interface KeycloakUser {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    username?: string;
}

interface KeycloakOrganization {
    id: string;
    name: string;
    alias: string;
}

interface IdentityProviderLink {
    identityProvider: string;
    userId: string;
    userName: string;
}

@Injectable()
export class KeycloakAdminService implements OnModuleInit {
    private readonly logger = new Logger(KeycloakAdminService.name);
    private kcAdminClient: KcAdminClient;

    constructor(private readonly configService: ConfigService<AllConfigType>) {
        this.kcAdminClient = new KcAdminClient({
            baseUrl: this.configService.getOrThrow('keycloak.authServerUrl', { infer: true }),
            realmName: this.configService.getOrThrow('keycloak.realm', { infer: true }),
        });
    }

    async onModuleInit() {
        await this.authenticate();
    }

    private async authenticate() {
        try {
            await this.kcAdminClient.auth({
                grantType: 'client_credentials',
                clientId: this.configService.getOrThrow('keycloak.clientId', { infer: true }),
                clientSecret: this.configService.getOrThrow('keycloak.clientSecret', { infer: true }),
            });
            this.logger.log('Successfully authenticated Keycloak Admin Client');
        } catch (error) {
            this.logger.error('Failed to authenticate Keycloak Admin Client', error);
            console.log("error", error);
            throw new UnauthorizedException('Failed to authenticate with Keycloak Admin API');
        }
    }

    // Helper to ensure token is valid before calls. The library handles token refresh automatically
    // internally when using client_credentials, but we wrap calls to standardise error handling if needed.
    private async ensureClient<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error: any) {
            if (error?.response?.status === 401) {
                this.logger.warn('Keycloak token expired, re-authenticating...');
                await this.authenticate();
                return await operation();
            }
            throw error;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Organization management (Keycloak Organizations API)
    // ─────────────────────────────────────────────────────────────────────────────

    async createOrganization(name: string, alias: string): Promise<KeycloakOrganization> {
        return this.ensureClient(async () => {
            const orgData = {
                name,
                alias,
                enabled: true,
                domains: [{ name: alias, verified: false }],
            };

            const response = await this.kcAdminClient.organizations.create(orgData);
            return {
                id: response.id!,
                name: name,
                alias: alias,
            };
        });
    }

    async deleteOrganization(orgId: string): Promise<void> {
        return this.ensureClient(async () => {
            await this.kcAdminClient.organizations.delById({ id: orgId });
            this.logger.log(`Deleted Keycloak organization: ${orgId}`);
        });
    }

    async addUserToOrganization(orgId: string, userId: string): Promise<void> {
        return this.ensureClient(async () => {
            await this.kcAdminClient.organizations.addMember({ orgId, userId });
            this.logger.log(`Added user ${userId} to organization ${orgId}`);
        });
    }

    async assignOrgAdminRole(orgId: string, userId: string): Promise<void> {
        // The organizations API in @keycloak/keycloak-admin-client might not directly expose 'roles' yet,
        // or it might be mapped differently. 
        // For now, if natively unsupported by the SDK, we log a warning or use an alternative mapping.
        this.logger.warn('assignOrgAdminRole using @keycloak/keycloak-admin-client might require manual HTTP if the new API is missing from the SDK typings.');

        // In Keycloak 26, org roles are typically just Realm / Client roles scoped, 
        // but if we were using custom HTTP before, we might still need a custom call if the SDK doesn't support org member roles yet.
        // Let's attempt standard realm role mapping as a fallback or throw a descriptive error if strict SDK usage is needed.

        // Assuming we can map regular realm roles to the user, or we use HttpService just for this *one* call if the SDK misses it.
        // Since the goal is 100% SDK, we will use the standard group/role mapping if possible.
        throw new InternalServerErrorException('assignOrgAdminRole needs to be adapted to SDK capabilities or mapped via standard roles');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // User management
    // ─────────────────────────────────────────────────────────────────────────────

    async findUserByEmail(email: string): Promise<KeycloakUser | null> {
        return this.ensureClient(async () => {
            const users = await this.kcAdminClient.users.find({ email, exact: true });
            if (users && users.length > 0) {
                const u = users[0];
                return {
                    id: u.id!,
                    email: u.email!,
                    firstName: u.firstName,
                    lastName: u.lastName,
                    username: u.username,
                };
            }
            return null;
        });
    }

    async createUser(email: string, password: string, fullName: string): Promise<KeycloakUser> {
        return this.ensureClient(async () => {
            const spaceIdx = fullName.indexOf(' ');
            const firstName = spaceIdx > -1 ? fullName.slice(0, spaceIdx) : fullName;
            const lastName = spaceIdx > -1 ? fullName.slice(spaceIdx + 1) : '';

            const userRepresentation = {
                email,
                username: email,
                firstName,
                lastName,
                enabled: true,
                emailVerified: true,
                credentials: [
                    {
                        type: 'password',
                        value: password,
                        temporary: false,
                    },
                ],
            };

            const response = await this.kcAdminClient.users.create(userRepresentation);
            return {
                id: response.id,
                email,
                firstName,
                lastName,
                username: email,
            };
        });
    }

    async deleteUser(userId: string): Promise<void> {
        return this.ensureClient(async () => {
            await this.kcAdminClient.users.del({ id: userId });
            this.logger.log(`Deleted Keycloak user: ${userId}`);
        });
    }

    async updateUserStatus(userId: string, enabled: boolean): Promise<void> {
        return this.ensureClient(async () => {
            await this.kcAdminClient.users.update({ id: userId }, { enabled });
        });
    }

    async updateUser(userId: string, data: Record<string, unknown>): Promise<void> {
        return this.ensureClient(async () => {
            await this.kcAdminClient.users.update({ id: userId }, data);
        });
    }

    async resetPassword(userId: string): Promise<void> {
        return this.ensureClient(async () => {
            await this.kcAdminClient.users.executeActionsEmail({
                id: userId,
                actions: ['UPDATE_PASSWORD'],
            });
        });
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Identity Provider Links (Phase 1.2 SSO Support)
    // ─────────────────────────────────────────────────────────────────────────────

    async getIdentityProviderLinks(userId: string): Promise<IdentityProviderLink[]> {
        return this.ensureClient(async () => {
            const links = await this.kcAdminClient.users.listFederatedIdentities({ id: userId });
            return links.map(link => ({
                identityProvider: link.identityProvider!,
                userId: link.userId!,
                userName: link.userName!,
            }));
        });
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Group management
    // ─────────────────────────────────────────────────────────────────────────────

    async createGroup(name: string, attributes?: Record<string, unknown>): Promise<{ id: string; name: string }> {
        return this.ensureClient(async () => {
            const groupData = {
                name,
                attributes: attributes as Record<string, string[]>,
            };
            const response = await this.kcAdminClient.groups.create(groupData);
            return { id: response.id!, name: name };
        });
    }

    async deleteGroup(groupId: string): Promise<void> {
        return this.ensureClient(async () => {
            await this.kcAdminClient.groups.del({ id: groupId });
        });
    }

    async addUserToGroup(userId: string, groupId: string): Promise<void> {
        return this.ensureClient(async () => {
            await this.kcAdminClient.users.addToGroup({ id: userId, groupId });
        });
    }

    async findGroupByName(name: string): Promise<{ id: string; name: string } | null> {
        return this.ensureClient(async () => {
            const groups = await this.kcAdminClient.groups.find({ search: name });
            const group = groups.find((g) => g.name === name);
            if (group) {
                return { id: group.id!, name: group.name! };
            }
            return null;
        });
    }

    async findRoleByName(roleName: string): Promise<any> {
        return this.ensureClient(async () => {
            return await this.kcAdminClient.roles.findOneByName({ name: roleName });
        });
    }
}
