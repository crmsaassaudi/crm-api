import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../../config/config.type';

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
  private kcAdminClient: any;
  private tokenProviderRegistered = false;

  constructor(private readonly configService: ConfigService<AllConfigType>) {}

  async onModuleInit() {
    await this.getClient();
    await this.authenticate();
  }

  private async getClient() {
    if (this.kcAdminClient) {
      return this.kcAdminClient;
    }

    const { default: KcAdminClient } = await import(
      '@keycloak/keycloak-admin-client'
    );

    this.kcAdminClient = new KcAdminClient({
      baseUrl: this.configService.getOrThrow('keycloak.authServerUrl', {
        infer: true,
      }),
      realmName: this.configService.getOrThrow('keycloak.realm', {
        infer: true,
      }),
    });

    if (!this.tokenProviderRegistered) {
      this.kcAdminClient.registerTokenProvider({
        getAccessToken: async () => {
          await this.authenticate();
          return this.kcAdminClient.accessToken;
        },
      });
      this.tokenProviderRegistered = true;
    }

    return this.kcAdminClient;
  }

  private async authenticate() {
    const client = await this.getClient();
    try {
      await client.auth({
        grantType: 'client_credentials',
        clientId: this.configService.getOrThrow('keycloak.adminClientId', {
          infer: true,
        }),
        clientSecret: this.configService.getOrThrow(
          'keycloak.adminClientSecret',
          {
            infer: true,
          },
        ),
      });
      this.logger.log('Successfully authenticated Keycloak Admin Client');
    } catch (error) {
      this.logger.error('Failed to authenticate Keycloak Admin Client', error);
      throw new UnauthorizedException(
        'Failed to authenticate with Keycloak Admin API',
      );
    }
  }

  // Client credentials grants do not return a refresh token. The registered
  // token provider above prevents the client from attempting refresh_token flow.
  private async ensureClient<T>(operation: () => Promise<T>): Promise<T> {
    await this.getClient();

    try {
      return await operation();
    } catch (error: any) {
      if (this.isAuthRetryableError(error)) {
        this.logger.warn('Keycloak admin token invalid, re-authenticating...');
        await this.authenticate();
        return await operation();
      }
      throw error;
    }
  }

  private isAuthRetryableError(error: any): boolean {
    const message = error?.message || '';
    return (
      error?.response?.status === 401 ||
      message.includes('Cannot refresh token') ||
      message.includes('missing refresh token')
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Organization management (Keycloak Organizations API)
  // ─────────────────────────────────────────────────────────────────────────────

  async createOrganization(
    name: string,
    alias: string,
  ): Promise<KeycloakOrganization> {
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

  async createUser(
    email: string,
    password: string,
    fullName: string,
  ): Promise<KeycloakUser> {
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

      let response: { id?: string };
      try {
        response = await this.kcAdminClient.users.create(userRepresentation);
      } catch (error: any) {
        const status = error?.response?.status;
        const message =
          error?.response?.data?.errorMessage ||
          error?.response?.data?.error ||
          error?.message ||
          'Failed to create Keycloak user';

        this.logger.error(
          `Failed to create Keycloak user ${email}: ${message}`,
          error?.stack || error,
        );

        if (status === 409) {
          throw new ConflictException(
            'Email already registered. Please login instead.',
          );
        }

        if (status === 400) {
          throw new BadRequestException(message);
        }

        throw error;
      }

      if (!response.id) {
        throw new BadRequestException(
          'Keycloak did not return a user id after creating the account.',
        );
      }

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

  async updateUser(
    userId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
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

  /**
   * Trigger Keycloak's "Execute Actions Email" for a user.
   *
   * Sends an email with a secure link that allows the user to perform the
   * specified actions (e.g. UPDATE_PASSWORD, VERIFY_EMAIL).
   *
   * @param userId      Keycloak user ID
   * @param actions     List of required actions (e.g. ['UPDATE_PASSWORD'])
   * @param redirectUri Where Keycloak redirects after the user completes the actions
   * @param clientId    Optional: override the client ID for the redirect
   */
  async executeActionsEmail(
    userId: string,
    actions: string[],
    redirectUri?: string,
    clientId?: string,
  ): Promise<void> {
    return this.ensureClient(async () => {
      const payload: Record<string, unknown> = {
        id: userId,
        actions,
      };

      if (redirectUri) {
        payload.redirectUri = redirectUri;
      }
      if (clientId) {
        payload.clientId = clientId;
      }

      await this.kcAdminClient.users.executeActionsEmail(payload);
      this.logger.log(
        `Execute actions email sent to user ${userId}: ${actions.join(', ')}`,
      );
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Identity Provider Links (Phase 1.2 SSO Support)
  // ─────────────────────────────────────────────────────────────────────────────

  async getIdentityProviderLinks(
    userId: string,
  ): Promise<IdentityProviderLink[]> {
    return this.ensureClient(async () => {
      const links = await this.kcAdminClient.users.listFederatedIdentities({
        id: userId,
      });
      return links.map((link) => ({
        identityProvider: link.identityProvider!,
        userId: link.userId!,
        userName: link.userName!,
      }));
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Group management
  // ─────────────────────────────────────────────────────────────────────────────

  async createGroup(
    name: string,
    attributes?: Record<string, unknown>,
  ): Promise<{ id: string; name: string }> {
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

  async findGroupByName(
    name: string,
  ): Promise<{ id: string; name: string } | null> {
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
