import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ChannelConfigRepository } from '../infrastructure/persistence/document/repositories/channel-config.repository';
import { CRYPTO_SERVICE_TOKEN, ICryptoService } from '../domain/crypto.service';
import { ChannelConfig } from '../domain/channel-config';

export type OAuth2Provider = 'google_workspace' | 'microsoft_entra';

export interface OAuth2AuthUrlOptions {
  provider: OAuth2Provider;
  redirectUri?: string;
  state?: string;
  loginHint?: string;
  scopes?: string[];
}

export interface OAuth2CallbackOptions {
  provider: OAuth2Provider;
  code: string;
  redirectUri?: string;
  configId?: string;
  name?: string;
  emailAddress?: string;
  publicSettings?: Record<string, any>;
  isDefault?: boolean;
}

interface OAuth2ProviderConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  redirectUri?: string;
  defaultScopes: string[];
  defaultPublicSettings: Record<string, any>;
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

type OAuth2ConfigLike = Pick<
  ChannelConfig,
  | 'id'
  | 'tenantId'
  | 'name'
  | 'authType'
  | 'accessToken'
  | 'refreshToken'
  | 'tokenExpiresAt'
  | 'publicSettings'
  | 'encryptedCredentials'
>;

const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

@Injectable()
export class OAuth2TokenManager {
  private readonly logger = new Logger(OAuth2TokenManager.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly repository: ChannelConfigRepository,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto: ICryptoService,
  ) {}

  generateAuthUrl(options: OAuth2AuthUrlOptions): {
    url: string;
    state: string;
  } {
    const providerConfig = this.getProviderConfig(options.provider);
    const state = options.state || this.generateState();
    const redirectUri = options.redirectUri || providerConfig.redirectUri;

    if (!redirectUri) {
      throw new BadRequestException(
        `Missing OAuth2 redirect URI for ${options.provider}`,
      );
    }

    const url = new URL(providerConfig.authUrl);
    url.searchParams.set('client_id', providerConfig.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set(
      'scope',
      (options.scopes?.length ? options.scopes : providerConfig.defaultScopes)
        .filter(Boolean)
        .join(' '),
    );
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');

    if (options.provider === 'microsoft_entra') {
      url.searchParams.set('response_mode', 'query');
    }
    if (options.loginHint) {
      url.searchParams.set('login_hint', options.loginHint);
    }

    return { url: url.toString(), state };
  }

  async exchangeCodeAndSave(
    options: OAuth2CallbackOptions,
  ): Promise<ChannelConfig> {
    const tenantId = this.getTenantId();
    const providerConfig = this.getProviderConfig(options.provider);
    const redirectUri = options.redirectUri || providerConfig.redirectUri;

    if (!redirectUri) {
      throw new BadRequestException(
        `Missing OAuth2 redirect URI for ${options.provider}`,
      );
    }

    const tokenSet = await this.exchangeCode(
      providerConfig,
      options.code,
      redirectUri,
    );
    if (!tokenSet.access_token) {
      throw new BadRequestException(
        'OAuth2 provider did not return an access token',
      );
    }

    const existing = options.configId
      ? await this.repository.findByIdWithCredentials(
          tenantId,
          options.configId,
        )
      : null;

    if (options.configId && !existing) {
      throw new NotFoundException('Email integration not found');
    }

    const existingCredentials = existing?.encryptedCredentials
      ? JSON.parse(await this.crypto.decrypt(existing.encryptedCredentials))
      : {};
    const emailAddress =
      options.emailAddress ||
      this.extractEmailFromIdToken(tokenSet.id_token) ||
      existingCredentials.user;

    if (!emailAddress) {
      throw new BadRequestException(
        'Unable to determine mailbox email address from OAuth2 response. Provide emailAddress explicitly.',
      );
    }

    const encryptedCredentials = await this.crypto.encrypt(
      JSON.stringify({ ...existingCredentials, user: emailAddress }),
    );
    const encryptedAccessToken = await this.crypto.encrypt(
      tokenSet.access_token,
    );
    const encryptedRefreshToken = tokenSet.refresh_token
      ? await this.crypto.encrypt(tokenSet.refresh_token)
      : null;
    const tokenExpiresAt = this.calculateExpiry(tokenSet.expires_in);
    const publicSettings = {
      ...providerConfig.defaultPublicSettings,
      ...(existing?.publicSettings || {}),
      ...(options.publicSettings || {}),
      fromEmail:
        options.publicSettings?.fromEmail ||
        existing?.publicSettings?.fromEmail ||
        emailAddress,
      oauthProvider: options.provider,
    };

    const saved = existing
      ? await this.repository.updateOAuthTokens(existing.id, {
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          tokenExpiresAt,
          authType: 'oauth2',
          encryptedCredentials,
          publicSettings,
          status: 'active',
          lastVerifiedAt: new Date(),
          lastHealthError: null,
          consecutiveFailures: 0,
          healthState: 'healthy',
          nextHealthCheckAt: null,
        })
      : await this.repository.create({
          tenantId,
          providerType: 'smtp',
          name: options.name || `${emailAddress} OAuth2`,
          authType: 'oauth2',
          encryptedCredentials,
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          tokenExpiresAt,
          publicSettings,
          status: 'active',
          isDefault: options.isDefault || false,
          deletedAt: null,
          lastVerifiedAt: new Date(),
          lastHealthError: null,
          consecutiveFailures: 0,
        });

    if (!saved) {
      throw new BadRequestException('Unable to save OAuth2 mailbox tokens');
    }

    if (options.isDefault) {
      await this.repository.setDefault(tenantId, saved.id, 'smtp');
    }

    this.eventEmitter.emit('channel-config.updated', {
      configId: saved.id,
      configName: saved.name,
    });

    delete saved.encryptedCredentials;
    saved.accessToken = null;
    saved.refreshToken = null;
    return saved;
  }

  async getValidAccessToken(config: OAuth2ConfigLike): Promise<string> {
    if ((config.authType || 'app_password') !== 'oauth2') {
      throw new BadRequestException(
        `Channel config ${config.id} is not configured for OAuth2`,
      );
    }

    if (!config.accessToken) {
      throw new BadRequestException(
        `Channel config ${config.id} is missing an OAuth2 access token`,
      );
    }

    const expiresAt = config.tokenExpiresAt
      ? new Date(config.tokenExpiresAt).getTime()
      : 0;
    if (expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return this.decryptStoredToken(config.accessToken);
    }

    return this.refreshAccessToken(config);
  }

  async buildOAuth2Credentials(
    config: OAuth2ConfigLike,
    credentials: Record<string, any>,
  ): Promise<Record<string, any>> {
    if ((config.authType || 'app_password') !== 'oauth2') {
      return credentials;
    }

    return {
      ...credentials,
      authType: 'oauth2',
      accessToken: await this.getValidAccessToken(config),
    };
  }

  private async refreshAccessToken(config: OAuth2ConfigLike): Promise<string> {
    if (!config.refreshToken) {
      throw new BadRequestException(
        `Channel config ${config.id} is missing an OAuth2 refresh token`,
      );
    }

    const provider = this.resolveProvider(config);
    const providerConfig = this.getProviderConfig(provider);
    const refreshToken = await this.decryptStoredToken(config.refreshToken);

    const body = new URLSearchParams({
      client_id: providerConfig.clientId,
      client_secret: providerConfig.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const tokenSet = await this.postTokenRequest(providerConfig.tokenUrl, body);
    if (!tokenSet.access_token) {
      throw new BadRequestException(
        `OAuth2 refresh for config ${config.id} did not return an access token`,
      );
    }

    const encryptedAccessToken = await this.crypto.encrypt(
      tokenSet.access_token,
    );
    const encryptedRefreshToken = tokenSet.refresh_token
      ? await this.crypto.encrypt(tokenSet.refresh_token)
      : undefined;

    await this.repository.updateOAuthTokens(config.id, {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt: this.calculateExpiry(tokenSet.expires_in),
      authType: 'oauth2',
      lastVerifiedAt: new Date(),
      lastHealthError: null,
      consecutiveFailures: 0,
      healthState: 'healthy',
      nextHealthCheckAt: null,
    });

    this.eventEmitter.emit('channel-config.updated', {
      configId: config.id,
      configName: config.name,
    });
    this.logger.debug(
      `[OAuth2] Refreshed access token for config ${config.id}`,
    );
    return tokenSet.access_token;
  }

  private async exchangeCode(
    providerConfig: OAuth2ProviderConfig,
    code: string,
    redirectUri: string,
  ): Promise<TokenEndpointResponse> {
    const body = new URLSearchParams({
      client_id: providerConfig.clientId,
      client_secret: providerConfig.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    return this.postTokenRequest(providerConfig.tokenUrl, body);
  }

  private async postTokenRequest(
    tokenUrl: string,
    body: URLSearchParams,
  ): Promise<TokenEndpointResponse> {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = (await response
      .json()
      .catch(() => ({}))) as TokenEndpointResponse;

    if (!response.ok) {
      throw new BadRequestException(
        payload.error_description ||
          payload.error ||
          `OAuth2 token endpoint failed with HTTP ${response.status}`,
      );
    }

    return payload;
  }

  private getProviderConfig(provider: OAuth2Provider): OAuth2ProviderConfig {
    if (provider === 'google_workspace') {
      return {
        clientId: this.requireConfig([
          'GOOGLE_WORKSPACE_OAUTH_CLIENT_ID',
          'GOOGLE_CLIENT_ID',
        ]),
        clientSecret: this.requireConfig([
          'GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET',
          'GOOGLE_CLIENT_SECRET',
        ]),
        redirectUri: this.configService.get<string>(
          'GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI',
          { infer: true },
        ),
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: [
          'openid',
          'email',
          'profile',
          'https://mail.google.com/',
        ],
        defaultPublicSettings: {
          host: 'smtp.gmail.com',
          port: '587',
          imapHost: 'imap.gmail.com',
          imapPort: '993',
        },
      };
    }

    const tenant = this.configService.get<string>('MICROSOFT_ENTRA_TENANT_ID', {
      infer: true,
    });
    return {
      clientId: this.requireConfig(['MICROSOFT_ENTRA_OAUTH_CLIENT_ID']),
      clientSecret: this.requireConfig(['MICROSOFT_ENTRA_OAUTH_CLIENT_SECRET']),
      redirectUri: this.configService.get<string>(
        'MICROSOFT_ENTRA_OAUTH_REDIRECT_URI',
        { infer: true },
      ),
      authUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      defaultScopes: [
        'openid',
        'email',
        'profile',
        'offline_access',
        'https://outlook.office.com/IMAP.AccessAsUser.All',
        'https://outlook.office.com/SMTP.Send',
      ],
      defaultPublicSettings: {
        host: 'smtp.office365.com',
        port: '587',
        imapHost: 'outlook.office365.com',
        imapPort: '993',
      },
    };
  }

  private resolveProvider(config: OAuth2ConfigLike): OAuth2Provider {
    const provider = config.publicSettings?.oauthProvider;
    if (provider === 'google_workspace' || provider === 'microsoft_entra') {
      return provider;
    }

    const host = String(config.publicSettings?.host || '').toLowerCase();
    if (host.includes('office365') || host.includes('outlook')) {
      return 'microsoft_entra';
    }
    return 'google_workspace';
  }

  private requireConfig(keys: string[]): string {
    for (const key of keys) {
      const value = this.configService.get<string>(key, { infer: true });
      if (value) return value;
    }
    throw new BadRequestException(
      `Missing OAuth2 config: ${keys.join(' or ')}`,
    );
  }

  private calculateExpiry(expiresIn?: number): Date | null {
    if (!expiresIn) return null;
    return new Date(Date.now() + expiresIn * 1000);
  }

  private async decryptStoredToken(value: string): Promise<string> {
    try {
      return await this.crypto.decrypt(value);
    } catch {
      return value;
    }
  }

  private extractEmailFromIdToken(idToken?: string): string | null {
    if (!idToken) return null;
    const [, payload] = idToken.split('.');
    if (!payload) return null;

    try {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(
        normalized.length + ((4 - (normalized.length % 4)) % 4),
        '=',
      );
      const decoded = JSON.parse(
        Buffer.from(padded, 'base64').toString('utf8'),
      );
      return (
        decoded.email ||
        decoded.preferred_username ||
        decoded.upn ||
        decoded.unique_name ||
        null
      );
    } catch {
      return null;
    }
  }

  private generateState(): string {
    return Buffer.from(
      `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    ).toString('base64url');
  }

  private getTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new BadRequestException('Missing tenant context');
    return tenantId;
  }
}
