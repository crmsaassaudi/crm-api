import {
    Injectable,
    Logger,
    UnauthorizedException,
    InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AllConfigType } from '../../config/config.type';
import { firstValueFrom } from 'rxjs';

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

@Injectable()
export class KeycloakAdminService {
    private readonly logger = new Logger(KeycloakAdminService.name);
    private accessToken: string | null = null;
    private tokenExpiresAt: number = 0;

    constructor(
        private readonly configService: ConfigService<AllConfigType>,
        private readonly httpService: HttpService,
    ) { }

    // ─────────────────────────────────────────────────────────────────────────────
    // Config helpers
    // ─────────────────────────────────────────────────────────────────────────────

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

    // ─────────────────────────────────────────────────────────────────────────────
    // Admin token management (cached, client_credentials flow)
    // ─────────────────────────────────────────────────────────────────────────────

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
            const response = await firstValueFrom(
                this.httpService.post(tokenUrl, params.toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                }),
            );

            this.accessToken = response.data.access_token as string;
            // Expire 60 s before actual TTL to avoid stale-token races
            this.tokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
            return this.accessToken!;
        } catch (error) {
            this.logger.error('Failed to obtain Keycloak admin token', error);
            throw new UnauthorizedException('Failed to authenticate with Keycloak Admin API');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Generic HTTP helper
    // ─────────────────────────────────────────────────────────────────────────────

    private async request<T = any>(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        endpoint: string,
        data?: unknown,
        _retry = false,
    ): Promise<{ data: T; location?: string }> {
        const token = await this.getAdminAccessToken();
        const url = `${this.baseUrl}/admin/realms/${this.realm}${endpoint}`;

        try {
            const response = await firstValueFrom(
                this.httpService.request<T>({
                    method,
                    url,
                    data,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 10000,
                }),
            );

            const location = response.headers?.location as string | undefined;
            return { data: response.data, location };
        } catch (error: any) {
            const status = error?.response?.status;

            // 404 → return null (resource not found is not an error)
            if (status === 404) {
                return { data: null as unknown as T };
            }

            // 401 / 403 on first attempt → token may be stale, bust cache and retry once
            if ((status === 401 || status === 403) && !_retry) {
                this.logger.warn(
                    `[KC] HTTP ${status} on ${method} ${endpoint} — busting token cache and retrying`,
                );
                this.accessToken = null;
                this.tokenExpiresAt = 0;
                return this.request<T>(method, endpoint, data, true);
            }

            this.logger.error(
                `Keycloak request failed: ${method} ${url}`,
                error?.response?.data ?? error?.message,
            );
            throw error;
        }
    }

    /**
     * Extract the resource ID from a Keycloak Location header.
     * Location format: .../admin/realms/{realm}/resource/{uuid}
     */
    private extractIdFromLocation(location: string): string {
        const parts = location.split('/');
        return parts[parts.length - 1];
    }

    /**
     * Generic helper for endpoints that require text/plain body (e.g. KC Organizations members).
     */
    private async requestText(
        method: 'POST' | 'PUT',
        endpoint: string,
        body: string,
    ): Promise<void> {
        const token = await this.getAdminAccessToken();
        const url = `${this.baseUrl}/admin/realms/${this.realm}${endpoint}`;
        try {
            await firstValueFrom(
                this.httpService.request({
                    method,
                    url,
                    data: body,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'text/plain',
                    },
                    timeout: 10000,
                }),
            );
        } catch (error: any) {
            this.logger.error(
                `Keycloak text/plain request failed: ${method} ${url}`,
                error?.response?.data ?? error?.message,
            );
            throw error;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Organization management (Keycloak Organizations API — KC 26+)
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Creates a Keycloak Organization with the given name and alias.
     * The alias is used as the canonical subdomain identifier.
     *
     * @returns The created organization's ID.
     */
    async createOrganization(
        name: string,
        alias: string,
    ): Promise<KeycloakOrganization> {
        const { location } = await this.request('POST', '/organizations', {
            name,
            alias,
            enabled: true,
            domains: [{ name: alias, verified: false }],
        });

        if (!location) {
            throw new InternalServerErrorException(
                'Keycloak did not return a Location header after creating organization',
            );
        }

        const id = this.extractIdFromLocation(location);
        return { id, name, alias };
    }

    /**
     * Deletes a Keycloak Organization. Used during Saga rollback.
     */
    async deleteOrganization(orgId: string): Promise<void> {
        await this.request('DELETE', `/organizations/${orgId}`);
        this.logger.log(`Deleted Keycloak organization: ${orgId}`);
    }

    /**
     * Adds a user to a Keycloak Organization as a member.
     * KC 26 Organizations API: POST /organizations/{id}/members
     * Body: plain text userId (Content-Type: text/plain)
     */
    async addUserToOrganization(orgId: string, userId: string): Promise<void> {
        await this.request('POST', `/organizations/${orgId}/members`, userId);
    }

    /**
     * Assigns the built-in 'org-admin' role to a user within an organization.
     *
     * Keycloak Organizations have a built-in "org-admin" role. We fetch the role
     * representation from the org and then assign it to the member.
     */
    async assignOrgAdminRole(orgId: string, userId: string): Promise<void> {
        const { data: roles } = await this.request<any[]>(
            'GET',
            `/organizations/${orgId}/roles`,
        );

        console.log('roles', roles);

        const orgAdminRole = roles?.find((r: any) => r.name === 'org-admin');
        if (!orgAdminRole) {
            throw new InternalServerErrorException(
                `Could not find 'org-admin' role in Keycloak organization ${orgId}`,
            );
        }

        await this.request(
            'POST',
            `/organizations/${orgId}/members/${userId}/roles`,
            [{ id: orgAdminRole.id, name: orgAdminRole.name }],
        );
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // User management
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Finds a user by email in the Keycloak realm.
     * Returns null if not found.
     */
    async findUserByEmail(email: string): Promise<KeycloakUser | null> {
        const { data } = await this.request<KeycloakUser[]>(
            'GET',
            `/users?email=${encodeURIComponent(email)}&exact=true`,
        );
        return data && data.length > 0 ? data[0] : null;
    }

    /**
     * Creates a user with a permanent password credential (no email verification needed for onboarding).
     * fullName is split on the first space: "Đại Toàn" → firstName="Đại" lastName="Toàn".
     *
     * @returns The new user's Keycloak ID.
     */
    async createUser(
        email: string,
        password: string,
        fullName: string,
    ): Promise<KeycloakUser> {
        const spaceIdx = fullName.indexOf(' ');
        const firstName = spaceIdx > -1 ? fullName.slice(0, spaceIdx) : fullName;
        const lastName = spaceIdx > -1 ? fullName.slice(spaceIdx + 1) : '';

        const { location } = await this.request('POST', '/users', {
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
        });

        let userId: string;

        if (location) {
            userId = this.extractIdFromLocation(location);
        } else {
            // Fallback: query by email (some KC versions omit Location on user create)
            const existingUser = await this.findUserByEmail(email);
            if (!existingUser) {
                throw new InternalServerErrorException(
                    `Failed to retrieve newly created Keycloak user for email: ${email}`,
                );
            }
            userId = existingUser.id;
        }

        return { id: userId, email, firstName, lastName };
    }

    /**
     * Deletes a user from Keycloak. Used during Saga rollback.
     */
    async deleteUser(userId: string): Promise<void> {
        await this.request('DELETE', `/users/${userId}`);
        this.logger.log(`Deleted Keycloak user: ${userId}`);
    }

    async updateUserStatus(userId: string, enabled: boolean): Promise<void> {
        await this.request('PUT', `/users/${userId}`, { enabled });
    }

    async updateUser(userId: string, data: Record<string, unknown>): Promise<void> {
        await this.request('PUT', `/users/${userId}`, data);
    }

    async resetPassword(userId: string): Promise<void> {
        await this.request('PUT', `/users/${userId}/execute-actions-email`, [
            'UPDATE_PASSWORD',
        ]);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Group management — kept for backward compatibility with existing auth flows
    // ─────────────────────────────────────────────────────────────────────────────

    async createGroup(
        name: string,
        attributes?: Record<string, unknown>,
    ): Promise<{ id: string; name: string }> {
        const { location } = await this.request('POST', '/groups', {
            name,
            attributes,
        });

        let groupId: string;
        if (location) {
            groupId = this.extractIdFromLocation(location);
        } else {
            const group = await this.findGroupByName(name);
            if (!group) {
                throw new InternalServerErrorException(
                    `Failed to retrieve created group: ${name}`,
                );
            }
            groupId = group.id;
        }

        return { id: groupId, name };
    }

    async deleteGroup(groupId: string): Promise<void> {
        await this.request('DELETE', `/groups/${groupId}`);
    }

    async addUserToGroup(userId: string, groupId: string): Promise<void> {
        await this.request('PUT', `/users/${userId}/groups/${groupId}`);
    }

    async findGroupByName(name: string): Promise<{ id: string; name: string } | null> {
        const { data } = await this.request<any[]>(
            'GET',
            `/groups?search=${encodeURIComponent(name)}`,
        );
        if (!data) return null;
        return data.find((g: any) => g.name === name) ?? null;
    }

    async findRoleByName(roleName: string): Promise<any> {
        const { data } = await this.request('GET', `/roles/${encodeURIComponent(roleName)}`);
        return data;
    }
}
