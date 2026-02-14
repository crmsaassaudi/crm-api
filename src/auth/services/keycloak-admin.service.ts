import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AllConfigType } from '../../config/config.type';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class KeycloakAdminService {
    private readonly logger = new Logger(KeycloakAdminService.name);
    private accessToken: string | null = null;
    private tokenExpiresAt: number = 0;

    constructor(
        private readonly configService: ConfigService<AllConfigType>,
        private readonly httpService: HttpService,
    ) { }

    private get baseUrl(): string {
        return this.configService.getOrThrow('keycloak.authServerUrl', { infer: true });
    }

    private get realm(): string {
        return this.configService.getOrThrow('keycloak.realm', { infer: true });
    }

    private get clientId(): string {
        return this.configService.getOrThrow('keycloak.clientId', { infer: true });
    }

    private get clientSecret(): string {
        return this.configService.getOrThrow('keycloak.clientSecret', { infer: true });
    }

    private async getAdminAccessToken(): Promise<string> {
        if (this.accessToken && Date.now() < this.tokenExpiresAt) {
            return this.accessToken;
        }

        const tokenUrl = `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`;
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', this.clientId);
        params.append('client_secret', this.clientSecret);

        try {
            const response = await firstValueFrom(this.httpService.post(tokenUrl, params.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            }));

            this.accessToken = response.data.access_token;
            // Set expiry slightly before actual expiry (e.g., 60s buffer)
            this.tokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
            return this.accessToken!;
        } catch (error) {
            this.logger.error('Failed to authenticate with Keycloak', error);
            throw new UnauthorizedException('Failed to authenticate with Keycloak Admin API');
        }
    }

    private async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', endpoint: string, data?: any): Promise<any> {
        const token = await this.getAdminAccessToken();
        const url = `${this.baseUrl}/admin/realms/${this.realm}${endpoint}`;

        try {
            const response = await firstValueFrom(this.httpService.request({
                method,
                url,
                data,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 3000,
            }));

            if (method === 'POST' && response.headers.location) {
                // Return location header for POST requests if available (to extract ID)
                return { ...response.data, location: response.headers.location };
            }

            return response.data;
        } catch (error: any) {
            if (error.response?.status === 404) {
                return null; // Handle 404 gracefully for find operations
            }
            this.logger.error(`Failed request ${method} ${url}`, error.response?.data || error.message);
            throw error;
        }
    }

    async createUser(email: string, tenantId: string, firstName: string, lastName: string, roleName?: string) {
        // 1. Create User
        const response = await this.request('POST', '/users', {
            email,
            username: email,
            firstName,
            lastName,
            enabled: true,
            emailVerified: true,
            attributes: {
                tenantId: [tenantId],
            },
        });

        // 2. Extract ID from Location header or fetch
        let userId = '';
        if (response?.location) {
            const parts = response.location.split('/');
            userId = parts[parts.length - 1];
        } else {
            const user = await this.findUserByEmail(email);
            if (!user) throw new Error(`Failed to retrieve created user ${email}`);
            userId = user.id;
        }

        const user = { id: userId, email, firstName, lastName };

        // 3. Assign Role (if provided)
        if (roleName) {
            const role = await this.findRoleByName(roleName);
            if (role) {
                await this.request('POST', `/users/${user.id}/role-mappings/realm`, [
                    {
                        id: role.id,
                        name: role.name,
                    },
                ]);
            } else {
                this.logger.warn(`Role ${roleName} not found, skipping assignment.`);
            }
        }

        return user;
    }

    async findUserByEmail(email: string) {
        const users = await this.request('GET', `/users?email=${encodeURIComponent(email)}&exact=true`);
        return users && users.length > 0 ? users[0] : null;
    }

    async findRoleByName(roleName: string) {
        // Keycloak uses the role name as ID for some endpoints, but let's look it up properly
        const role = await this.request('GET', `/roles/${encodeURIComponent(roleName)}`);
        return role;
    }

    async resetPassword(userId: string) {
        await this.request('PUT', `/users/${userId}/execute-actions-email`, ['UPDATE_PASSWORD']);
    }

    async deleteUser(userId: string) {
        await this.request('DELETE', `/users/${userId}`);
    }

    async updateUserStatus(userId: string, enabled: boolean) {
        await this.request('PUT', `/users/${userId}`, { enabled });
    }

    async updateUser(userId: string, data: any) {
        await this.request('PUT', `/users/${userId}`, data);
    }

    // --- Group Management ---

    async createGroup(name: string, attributes?: Record<string, any>) {
        const groupPayload = {
            name,
            attributes,
        };
        const response = await this.request('POST', '/groups', groupPayload);

        // Fetch to get ID
        let groupId = '';
        if (response?.location) {
            const parts = response.location.split('/');
            groupId = parts[parts.length - 1];
        } else {
            const group = await this.findGroupByName(name);
            if (!group) throw new Error(`Failed to retrieve created group ${name}`);
            groupId = group.id;
        }

        return { id: groupId, name, attributes };
    }

    async deleteGroup(groupId: string) {
        await this.request('DELETE', `/groups/${groupId}`);
    }

    async addUserToGroup(userId: string, groupId: string) {
        await this.request('PUT', `/users/${userId}/groups/${groupId}`);
    }

    async findGroupByName(name: string) {
        const groups = await this.request('GET', `/groups?search=${encodeURIComponent(name)}`);
        // Filter exact match because search is fuzzy
        return groups ? groups.find((g: any) => g.name === name) : null;
    }
}
