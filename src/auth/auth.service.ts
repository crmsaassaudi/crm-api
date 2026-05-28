import {
  HttpStatus,
  Injectable,
  Inject,
  forwardRef,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ulid } from 'ulid';
import { isValidObjectId } from 'mongoose';
import { TenantsService } from '../tenants/tenants.service';
import { AuthUpdateDto } from './dto/auth-update.dto';
import { NullableType } from '../utils/types/nullable.type';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { AllConfigType } from '../config/config.type';
import { User } from '../users/domain/user';
import { AuthProvidersEnum } from './auth-providers.enum';
import { PlatformRoleEnum } from '../roles/platform-role.enum';
import { StatusEnum } from '../statuses/statuses.enum';
import { RedisService } from '../redis/redis.service';
import { SessionService, SessionData } from './services/session.service';
import { Tenant } from '../tenants/domain/tenant';

const STATE_PREFIX = 'oauth:state:';
const STATE_TTL_SECONDS = 300; // 5 minutes

type OAuthStatePayload = {
  nonce: string;
  returnTo?: string;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly refreshInflight = new Map<string, Promise<SessionData>>();

  constructor(
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    @Inject(forwardRef(() => TenantsService))
    private tenantsService: TenantsService,
    private configService: ConfigService<AllConfigType>,
    private httpService: HttpService,
    private redisService: RedisService,
    private sessionService: SessionService,
  ) {}

  // ─── Step 1: Build login URL with CSRF state ──────────────────────────────

  async buildLoginUrl(
    returnTo?: string,
  ): Promise<{ url: string; state: string }> {
    const authServerUrl = this.configService.getOrThrow(
      'keycloak.authServerUrl',
      { infer: true },
    );
    const realm = this.configService.getOrThrow('keycloak.realm', {
      infer: true,
    });
    const clientId = this.configService.getOrThrow('keycloak.clientId', {
      infer: true,
    });
    const callbackUrl = this.configService.getOrThrow('keycloak.callbackUrl', {
      infer: true,
    });

    const state = ulid();
    const nonce = ulid();
    const safeReturnTo = this.sanitizeReturnTo(returnTo);
    const statePayload: OAuthStatePayload = {
      nonce,
      ...(safeReturnTo ? { returnTo: safeReturnTo } : {}),
    };

    // Use raw ioredis client (not cache-manager) to avoid key-prefix/TTL interference
    const redisClient = this.redisService.getClient();
    await redisClient.set(
      `${STATE_PREFIX}${state}`,
      JSON.stringify(statePayload),
      'EX',
      STATE_TTL_SECONDS,
    );
    this.logger.log(
      `[buildLoginUrl] State saved to Redis: oauth:state:${state} (TTL=${STATE_TTL_SECONDS}s)`,
    );

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: callbackUrl,
      scope: 'openid profile email',
      state,
      nonce,
    });

    const url = `${authServerUrl}/realms/${realm}/protocol/openid-connect/auth?${params}`;
    return { url, state };
  }

  // ─── Step 2: Validate state and exchange code ─────────────────────────────

  private async validateStateAndExchange(
    code: string,
    state: string,
  ): Promise<{ tokens: any; returnTo?: string }> {
    const redisKey = `${STATE_PREFIX}${state}`;
    this.logger.log(`[validateState] Checking Redis key: ${redisKey}`);

    // Use raw ioredis client — same as buildLoginUrl
    const redisClient = this.redisService.getClient();
    const stored = await redisClient.get(redisKey);
    this.logger.log(
      `[validateState] Redis result: ${stored ? 'FOUND' : 'NOT FOUND'}`,
    );

    if (!stored) {
      throw new UnauthorizedException(
        'Invalid or expired state — possible CSRF attack',
      );
    }
    const parsedState = this.parseOAuthState(stored);

    // One-time use: delete immediately after validation
    await redisClient.del(redisKey);
    this.logger.log(
      '[validateState] State validated and deleted from Redis. Proceeding to code exchange.',
    );

    const tokens = await this.exchangeCode(code);
    return { tokens, returnTo: parsedState.returnTo };
  }

  private async exchangeCode(code: string): Promise<any> {
    const authServerUrl = this.configService.getOrThrow(
      'keycloak.authServerUrl',
      { infer: true },
    );
    const realm = this.configService.getOrThrow('keycloak.realm', {
      infer: true,
    });
    const clientId = this.configService.getOrThrow('keycloak.clientId', {
      infer: true,
    });
    const clientSecret = this.configService.getOrThrow(
      'keycloak.clientSecret',
      { infer: true },
    );
    const callbackUrl = this.configService.getOrThrow('keycloak.callbackUrl', {
      infer: true,
    });

    const tokenUrl = `${authServerUrl}/realms/${realm}/protocol/openid-connect/token`;
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl,
    });

    try {
      const response = await firstValueFrom(
        this.httpService.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      return response.data;
    } catch (error) {
      this.logger.error('Token exchange failed', (error as Error).message);
      throw new UnauthorizedException('Failed to exchange code for token');
    }
  }

  // ─── Step 3: Full callback orchestration ─────────────────────────────────

  async handleCallback(
    code: string,
    state: string,
  ): Promise<{ sid: string; redirectUrl: string }> {
    this.logger.log(
      `[handleCallback] Step 1: Received code=<present> state=<present>`,
    );

    // 1. Validate CSRF state + exchange code
    let tokens: any;
    let returnTo: string | undefined;
    try {
      const exchangeResult = await this.validateStateAndExchange(code, state);
      tokens = exchangeResult.tokens;
      returnTo = exchangeResult.returnTo;
      this.logger.log(
        `[handleCallback] Step 2: Tokens received. expires_in=${tokens?.expires_in}`,
      );
    } catch (e) {
      this.logger.error(
        `[handleCallback] Step 2 FAILED (state/exchange): ${(e as Error).message}`,
      );
      throw e;
    }

    // 2. Decode id_token
    let idTokenPayload: any;
    try {
      idTokenPayload = this.decodeJwt(tokens.id_token);
      const maskedEmail = idTokenPayload?.email
        ? idTokenPayload.email.replace(/^(.{3}).*@/, '$1***@')
        : 'N/A';
      this.logger.log(
        `[handleCallback] Step 3: id_token decoded. sub=${idTokenPayload?.sub} email=${maskedEmail}`,
      );
    } catch (e) {
      this.logger.error(
        `[handleCallback] Step 3 FAILED (decode id_token): ${(e as Error).message}`,
      );
      throw e;
    }

    // 3. JIT provisioning / sync
    let user: any;
    try {
      user = await this.jitProvision(idTokenPayload);
      this.logger.log(
        `[handleCallback] Step 4: JIT provisioning done. userId=${user?.id} tenants=${user?.tenants?.length}`,
      );
    } catch (e) {
      this.logger.error(
        `[handleCallback] Step 4 FAILED (JIT provisioning): ${(e as Error).message}`,
        (e as Error).stack,
      );
      throw e;
    }

    if (!user) {
      throw new UnprocessableEntityException('Failed to provision user');
    }

    // 4. Create session in Redis
    let sid: string;
    try {
      sid = await this.sessionService.createSession(tokens, user.id as string);
      this.logger.log(`[handleCallback] Step 5: Session created. sid=${sid}`);
    } catch (e) {
      this.logger.error(
        `[handleCallback] Step 5 FAILED (create session): ${(e as Error).message}`,
      );
      throw e;
    }

    // 5. Tenant routing
    const redirectUrl = await this.resolveTenantRedirect(user, returnTo);
    this.logger.log(
      `[handleCallback] Step 6: Redirect URL resolved: ${redirectUrl}`,
    );

    return { sid, redirectUrl };
  }

  // ─── Step 4: Token refresh ────────────────────────────────────────────────

  async refreshTokens(sid: string): Promise<SessionData> {
    const inflight = this.refreshInflight.get(sid);
    if (inflight) {
      return inflight;
    }

    const refreshPromise = this.refreshTokensOnce(sid).finally(() => {
      this.refreshInflight.delete(sid);
    });
    this.refreshInflight.set(sid, refreshPromise);

    // Safety net: even if .finally never runs (e.g. promise never settles
    // because Keycloak hangs and the awaiter is GC'd), forcibly clear the
    // entry after 60s so we don't grow this Map unbounded under flaky upstreams.
    setTimeout(() => {
      if (this.refreshInflight.get(sid) === refreshPromise) {
        this.refreshInflight.delete(sid);
      }
    }, 60_000).unref();

    return refreshPromise;
  }

  private async refreshTokensOnce(sid: string): Promise<SessionData> {
    const redisClient = this.redisService.getClient();
    const lockKey = `lock:auth:refresh:${sid}`;
    const lockToken = ulid();
    const acquired = await redisClient.set(
      lockKey,
      lockToken,
      'PX',
      10_000,
      'NX',
    );

    if (!acquired) {
      return this.waitForRefreshedSession(sid);
    }

    try {
      return await this.performTokenRefresh(sid);
    } finally {
      try {
        const currentToken = await redisClient.get(lockKey);
        if (currentToken === lockToken) {
          await redisClient.del(lockKey);
        }
      } catch {
        // Lock cleanup failure is non-fatal; Redis TTL will release it.
      }
    }
  }

  private async performTokenRefresh(sid: string): Promise<SessionData> {
    const session = await this.sessionService.getSessionFresh(sid);
    if (!session) {
      throw new UnauthorizedException('Session not found');
    }

    const authServerUrl = this.configService.getOrThrow(
      'keycloak.authServerUrl',
      { infer: true },
    );
    const realm = this.configService.getOrThrow('keycloak.realm', {
      infer: true,
    });
    const clientId = this.configService.getOrThrow('keycloak.clientId', {
      infer: true,
    });
    const clientSecret = this.configService.getOrThrow(
      'keycloak.clientSecret',
      { infer: true },
    );

    const tokenUrl = `${authServerUrl}/realms/${realm}/protocol/openid-connect/token`;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: session.refreshToken,
    });

    try {
      const response = await firstValueFrom(
        this.httpService.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      const newTokens = response.data;
      const newExpiresAt = Date.now() + newTokens.expires_in * 1000;

      const updatedSession: SessionData = {
        ...session,
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token ?? session.refreshToken,
        idToken: newTokens.id_token ?? session.idToken,
        expiresAt: newExpiresAt,
      };

      await this.sessionService.updateSession(
        sid,
        updatedSession,
        86_400, // 24h — session stays alive for many refresh cycles
      );
      return updatedSession;
    } catch (error: any) {
      // refresh_token expired or revoked → force re-login
      const errorCode = error?.response?.data?.error;
      this.logger.warn(`Token refresh failed for sid=${sid}: ${errorCode}`);
      await this.sessionService.deleteSession(sid);
      throw new UnauthorizedException('Session expired — please log in again');
    }
  }

  private async waitForRefreshedSession(sid: string): Promise<SessionData> {
    const deadline = Date.now() + 10_000;
    let lastSession: SessionData | null = null;

    while (Date.now() < deadline) {
      lastSession = await this.sessionService.getSessionFresh(sid);
      if (!lastSession) {
        throw new UnauthorizedException('Session not found');
      }

      if (lastSession.expiresAt > Date.now() + 30_000) {
        return lastSession;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (lastSession) {
      return lastSession;
    }

    throw new UnauthorizedException('Session refresh timeout');
  }

  // ─── Step 5: Logout ───────────────────────────────────────────────────────

  async logout(sid: string): Promise<void> {
    const session = await this.sessionService.getSession(sid);
    await this.sessionService.deleteSession(sid);

    if (session?.idToken) {
      // Federated logout from Keycloak IdP
      const authServerUrl = this.configService.getOrThrow(
        'keycloak.authServerUrl',
        { infer: true },
      );
      const realm = this.configService.getOrThrow('keycloak.realm', {
        infer: true,
      });
      const logoutUrl = `${authServerUrl}/realms/${realm}/protocol/openid-connect/logout`;

      try {
        await firstValueFrom(
          this.httpService.post(
            logoutUrl,
            new URLSearchParams({
              id_token_hint: session.idToken,
            }).toString(),
            {
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            },
          ),
        );
      } catch (e) {
        // Non-fatal: session is already deleted locally
        this.logger.warn(
          'Keycloak federated logout failed (non-fatal)',
          (e as Error).message,
        );
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private decodeJwt(token: string): any {
    const base64 = token.split('.')[1];
    const json = Buffer.from(base64, 'base64url').toString('utf-8');
    return JSON.parse(json);
  }

  private parseOAuthState(stored: string): OAuthStatePayload {
    try {
      const parsed = JSON.parse(stored) as OAuthStatePayload;
      return {
        nonce: parsed.nonce,
        returnTo: this.sanitizeReturnTo(parsed.returnTo),
      };
    } catch {
      // Backward compatibility for states created before JSON payloads.
      return { nonce: stored };
    }
  }

  private sanitizeReturnTo(returnTo?: string): string | undefined {
    if (!returnTo) return undefined;

    try {
      const url = new URL(returnTo);
      const rootDomain = (
        this.configService.get('app.rootDomain', { infer: true }) ||
        'crmsaudi.dev'
      ).toLowerCase();
      const hostname = url.hostname.toLowerCase();
      const isProd =
        this.configService.get('app.nodeEnv', { infer: true }) === 'production';
      const isLocalhost =
        !isProd && (hostname === 'localhost' || hostname === '127.0.0.1');
      const isRootDomain = hostname === rootDomain;
      const subdomain = hostname.endsWith(`.${rootDomain}`)
        ? hostname.slice(0, hostname.length - rootDomain.length - 1)
        : '';
      const isTenantDomain =
        !!subdomain &&
        !subdomain.includes('.') &&
        !['api', 'auth', 'admin', 'www', 'mail'].includes(subdomain);

      if (!isLocalhost && !isRootDomain && !isTenantDomain) {
        this.logger.warn(`[sanitizeReturnTo] Rejected host: ${hostname}`);
        return undefined;
      }

      if (isProd && url.protocol !== 'https:') {
        this.logger.warn(
          `[sanitizeReturnTo] Rejected protocol: ${url.protocol}`,
        );
        return undefined;
      }

      return url.toString();
    } catch {
      this.logger.warn('[sanitizeReturnTo] Rejected invalid returnTo URL');
      return undefined;
    }
  }

  private async resolveTenantRedirect(
    user: User,
    preferredRedirectUrl?: string,
  ): Promise<string> {
    const frontend = this.configService.getOrThrow('keycloak.frontendUrl', {
      infer: true,
    });
    const tenants = user.tenants ?? [];

    if (tenants.length === 0) {
      return `${frontend}/onboarding`;
    } else if (preferredRedirectUrl) {
      return preferredRedirectUrl;
    } else if (tenants.length === 1) {
      const tenantId = tenants[0].tenantId as string;
      try {
        const tenant = await this.tenantsService.findById(tenantId);
        if (tenant && tenant.alias) {
          const rootDomain =
            this.configService.get('app.rootDomain', { infer: true }) ||
            'crmsaudi.dev';
          const url = new URL(frontend);

          if (process.env.NODE_ENV === 'development') {
            url.hostname = `${tenant.alias}.${rootDomain}`;
            return `${url.origin}/`;
          } else {
            return `https://${tenant.alias}.${rootDomain}/`;
          }
        }
      } catch (e) {
        this.logger.error(`Failed to resolve tenant alias for redirect`, e);
      }
      return `${frontend}`;
    } else {
      return `${frontend}/select-tenant`;
    }
  }

  // ─── JIT Provisioning (called from callback) ──────────────────────────────

  async jitProvision(keycloakPayload: any): Promise<NullableType<User>> {
    const keycloakId = keycloakPayload.sub;
    const email = keycloakPayload.email;
    const lockKey = `lock:auth:sync:${keycloakId}`;
    const redisClient = this.redisService.getClient();

    const acquired = await redisClient.set(lockKey, 'locked', 'PX', 5000, 'NX');

    try {
      if (!acquired) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return this.usersService.findByKeycloakIdAndProvider({
          keycloakId,
          provider: AuthProvidersEnum.email,
        });
      }

      // Keycloak may send tenant-related claims (e.g. group IDs or realm roles) as UUIDs.
      // These are NOT MongoDB ObjectIds and must be validated before referencing tenant documents.
      // Tenant membership in this system is established through the onboarding flow, not raw JWT claims.
      const rawKeycloakTenantIds: string[] =
        keycloakPayload.tenants || keycloakPayload.tenant_ids || [];
      const keycloakTenantIds: string[] = rawKeycloakTenantIds.filter((tid) => {
        const valid = isValidObjectId(tid);
        if (!valid) {
          this.logger.warn(
            `[jitProvision] Skipping non-ObjectId tenant claim from Keycloak token: "${tid}"`,
          );
        }
        return valid;
      });

      let user = await this.usersService.findByKeycloakIdAndProvider({
        keycloakId,
        provider: AuthProvidersEnum.email,
      });

      if (!user && email) {
        user = await this.usersService.findByEmail(email);
        if (user) {
          user.keycloakId = keycloakId;
        }
      }

      if (!user) {
        user = await this.usersService.create({
          email,
          firstName: keycloakPayload.given_name,
          lastName: keycloakPayload.family_name,
          keycloakId,
          provider: AuthProvidersEnum.email,
          platformRole: { id: PlatformRoleEnum.USER },
          status: { id: StatusEnum.active },
          // Only add tenants we can actually reference by valid ObjectId.
          // A fresh user will have an empty array and go through onboarding.
          tenants: keycloakTenantIds.map((tid) => ({
            tenantId: tid,
            roles: [],
            joinedAt: new Date(),
          })),
        });
      } else {
        const existingTenantIds = user.tenants.map((t) => t.tenantId);
        const newTenantIds = keycloakTenantIds.filter(
          (tid) => !existingTenantIds.includes(tid),
        );
        const tenantsToRemove =
          keycloakTenantIds.length > 0
            ? existingTenantIds.filter(
                (tid) => !keycloakTenantIds.includes(tid),
              )
            : []; // if Keycloak sends no valid tenant claims, don't remove existing memberships
        let hasChanges = false;

        if (tenantsToRemove.length > 0) {
          user.tenants = user.tenants.filter(
            (t) => !tenantsToRemove.includes(t.tenantId),
          );
          hasChanges = true;
        }
        if (newTenantIds.length > 0) {
          user.tenants = [
            ...user.tenants,
            ...newTenantIds.map((tid) => ({
              tenantId: tid,
              roles: [],
              joinedAt: new Date(),
            })),
          ];
          hasChanges = true;
        }
        if (hasChanges || user.keycloakId !== keycloakId) {
          user.keycloakId = keycloakId;
          await this.usersService.update(user.id, user);
        }
      }

      return user;
    } finally {
      if (acquired) await redisClient.del(lockKey);
    }
  }

  // ─── Existing methods kept for /auth/me and /auth/patch ──────────────────

  async me(keycloakPayload: any): Promise<NullableType<User>> {
    return this.jitProvision(keycloakPayload);
  }

  async update(
    keycloakPayload: any,
    userDto: AuthUpdateDto,
  ): Promise<NullableType<User>> {
    const user = await this.me(keycloakPayload);
    if (!user) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: { user: 'userNotFound' },
      });
    }

    if (userDto.oldPassword || userDto.password) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: { password: 'cannotChangePasswordHere' },
      });
    }

    await this.usersService.update(user.id, userDto);
    return this.usersService.findById(user.id);
  }

  async softDelete(keycloakPayload: any): Promise<void> {
    const user = await this.me(keycloakPayload);
    if (user) {
      await this.usersService.remove(user.id);
    }
  }

  async myTenants(keycloakPayload: any): Promise<Tenant[]> {
    const user = await this.me(keycloakPayload);
    if (!user?.tenants?.length) {
      return [];
    }

    const tenantIds = Array.from(
      new Set(
        user.tenants.map((membership) => membership.tenantId?.toString()),
      ),
    ).filter(Boolean) as string[];

    return this.tenantsService.findByIds(tenantIds);
  }
}
