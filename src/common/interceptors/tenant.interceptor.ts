import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { ClsService } from 'nestjs-cls';
import { Request } from 'express';
import { isValidObjectId } from 'mongoose';
import {
  SessionService,
  SessionData,
} from '../../auth/services/session.service';
import { ModuleRef } from '@nestjs/core';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import { TenantsRepository } from '../../tenants/infrastructure/persistence/document/repositories/tenant.repository';
import { RedisService } from '../../redis/redis.service';

const TENANT_ALIAS_CACHE_TTL = 300; // 5 minutes
const TENANT_I18N_CACHE_TTL = 300;
const USER_KEYCLOAK_CACHE_TTL = 300;

/**
 * TenantInterceptor — Resolves multitenant context for every request.
 *
 * After this interceptor runs, the CLS store is guaranteed to contain:
 *   - tenantId      : MongoDB ObjectId string of the active tenant
 *   - activeTenantId: alias for tenantId (used by tenant-filter plugin)
 *   - userId        : MongoDB ObjectId string of the authenticated user
 *   - email         : user's email address
 *
 * Resolution order (first match wins for each field):
 *
 *   tenantId:
 *     1. Subdomain alias  (daitoan.crmsaudi.dev -> lookup -> ObjectId)
 *     2. x-tenant-id header (DEV/TEST only)
 *     3. BFF session JWT claim (tenantId)
 *     4. Bearer JWT claim (tenantId)
 *     5. Missing tenant context is rejected for tenant-scoped operations
 *
 *   userId / email:
 *     1. BFF session cookie (sid → SessionData.userId)
 *     2. Bearer JWT (req.user.sub / req.user.email)
 *     — If userId is a Keycloak UUID, it's resolved to MongoDB ObjectId.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantInterceptor.name);

  constructor(
    private readonly cls: ClsService,
    private readonly sessionService: SessionService,
    private readonly moduleRef: ModuleRef,
    private readonly redisService: RedisService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    return from(this.resolveContext(request)).pipe(
      switchMap(() => next.handle()),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Main resolution pipeline
  // ──────────────────────────────────────────────────────────────────────────

  private async resolveContext(request: Request): Promise<void> {
    // ── Step 1: Collect raw identifiers from all sources ──
    const raw = this.collectRawIdentifiers(request);

    // ── Step 2: Resolve identity (userId → MongoDB ObjectId) ──
    await this.resolveIdentity(raw);

    // ── Step 3: Resolve tenantId (alias/UUID → MongoDB ObjectId) ──
    await this.resolveTenant(raw);

    // ── Step 4: Reject ambiguous tenant context for tenant-scoped requests ──
    if (!this.cls.get('tenantId')) {
      this.rejectMissingTenantContext(request);
    }

    // ── Step 5: Sync activeTenantId for downstream compatibility ──
    const tenantId = this.cls.get('tenantId');
    if (tenantId) {
      this.cls.set('activeTenantId', tenantId);
    }

    // ── Step 6: Inject tenant i18n settings into CLS ──
    if (tenantId) {
      await this.resolveI18nContext(tenantId);
    }

    this.logger.debug(
      `Context resolved → tenantId=${this.cls.get('tenantId')}, userId=${this.cls.get('userId')}, locale=${this.cls.get('tenantLocale') ?? 'en'}, tz=${this.cls.get('tenantTimezone') ?? 'UTC'}`,
    );
  }

  /**
   * Fetch tenant i18n settings and user overrides, then set into CLS.
   * Resolution: user preference > tenant default > system default.
   */
  private async resolveI18nContext(tenantId: string): Promise<void> {
    try {
      // Check Redis cache for tenant i18n settings
      const tenantI18nKey = `tenant:i18n:${tenantId}`;
      let locale = 'en';
      let timezone = 'UTC';

      try {
        const cachedI18n = await this.redisService.get<{ locale: string; timezone: string }>(tenantI18nKey);
        if (cachedI18n) {
          locale = cachedI18n.locale;
          timezone = cachedI18n.timezone;
        } else {
          const tenantRepo = this.moduleRef.get(TenantsRepository, { strict: false });
          const tenant = await tenantRepo.findById(tenantId);
          locale = tenant?.i18nSettings?.locale ?? 'en';
          timezone = tenant?.i18nSettings?.timezone ?? 'UTC';
          await this.redisService
            .set(tenantI18nKey, { locale, timezone }, TENANT_I18N_CACHE_TTL)
            .catch(() => {/* non-fatal */});
        }
      } catch {
        // Cache/DB failure — use defaults
      }

      // User-level override
      const userId = this.cls.get('userId');
      if (userId) {
        try {
          const userI18nKey = `user:i18n:${userId}`;
          const cachedUser = await this.redisService
            .get<{ locale?: string; timezone?: string }>(userI18nKey)
            .catch(() => null);

          if (cachedUser) {
            if (cachedUser.locale) locale = cachedUser.locale;
            if (cachedUser.timezone) timezone = cachedUser.timezone;
          } else {
            const userRepo = this.moduleRef.get(UserRepository, { strict: false });
            let user: any = null;
            if (isValidObjectId(userId)) {
              user = await userRepo.findById(userId);
            } else if (userId.includes('-')) {
              user = await userRepo.findByKeycloakIdAndProvider({
                keycloakId: userId,
                provider: 'email',
              });
            }
            const userPrefs = {
              locale: user?.i18nPreferences?.locale ?? null,
              timezone: user?.i18nPreferences?.timezone ?? null,
            };
            await this.redisService
              .set(userI18nKey, userPrefs, USER_KEYCLOAK_CACHE_TTL)
              .catch(() => {/* non-fatal */});
            if (userPrefs.locale) locale = userPrefs.locale;
            if (userPrefs.timezone) timezone = userPrefs.timezone;
          }
        } catch {
          // User lookup failed — use tenant defaults
        }
      }

      this.cls.set('tenantLocale', locale);
      this.cls.set('tenantTimezone', timezone);
    } catch {
      this.cls.set('tenantLocale', 'en');
      this.cls.set('tenantTimezone', 'UTC');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1 — Collect raw identifiers from request sources
  // ──────────────────────────────────────────────────────────────────────────

  private collectRawIdentifiers(request: Request): {
    tenantHints: string[];
    userId?: string;
    email?: string;
    sessionData?: SessionData;
  } {
    const tenantHints: string[] = [];
    let userId: string | undefined;
    let email: string | undefined;
    let sessionData: SessionData | undefined;

    // Source 1: Subdomain alias (HIGHEST PRIORITY for tenant)
    const alias = (request as any).tenantAlias;
    if (alias) {
      tenantHints.push(alias);
    }

    // Source 2: x-tenant-id header (DEV/TEST only)
    if (process.env.NODE_ENV !== 'production') {
      const headerVal = this.extractHeader(request, 'x-tenant-id');
      if (headerVal) {
        tenantHints.push(headerVal);
      }
    }

    // Source 3: BFF session cookie
    const sid = (request as any).cookies?.['sid'];
    if (sid) {
      this.cls.set('sid', sid);
    }

    // Source 4: Bearer JWT (nest-keycloak-connect)
    const user = (request as any).user;
    if (user) {
      this.cls.set('user', user);
      if (!userId) userId = user.sub;
      if (!email) email = user.email;
      if (user.tenantId) tenantHints.push(user.tenantId);
    }

    return { tenantHints, userId, email, sessionData };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2 — Resolve identity (BFF session → userId → MongoDB ObjectId)
  // ──────────────────────────────────────────────────────────────────────────

  private async resolveIdentity(raw: {
    tenantHints: string[];
    userId?: string;
    email?: string;
  }): Promise<void> {
    // Try BFF session first (has MongoDB userId already)
    const sid = this.cls.get('sid');
    if (sid) {
      try {
        const session = await this.sessionService.getSession(sid);
        if (session) {
          // session.userId is already a MongoDB ObjectId string
          this.cls.set('userId', session.userId);

          const payload = this.decodeJwt(session.accessToken);
          if (payload?.email) this.cls.set('email', payload.email);
          if (payload?.tenantId) raw.tenantHints.push(payload.tenantId);
        }
      } catch (e) {
        this.logger.warn(
          `BFF session resolution failed: ${(e as Error).message}`,
        );
      }
    }

    // Fallback to Bearer JWT identity
    if (!this.cls.get('userId') && raw.userId) {
      this.cls.set('userId', raw.userId);
    }
    if (!this.cls.get('email') && raw.email) {
      this.cls.set('email', raw.email);
    }

    // If userId is a Keycloak UUID (contains '-'), resolve to MongoDB ObjectId
    const currentUserId = this.cls.get('userId');
    if (currentUserId && currentUserId.includes('-')) {
      // Check cache before hitting the DB
      const kcCacheKey = `user:keycloak:${currentUserId}`;
      try {
        const cachedMongoId = await this.redisService.get<string>(kcCacheKey);
        if (cachedMongoId) {
          this.cls.set('userId', cachedMongoId);
          this.logger.debug(`Resolved Keycloak UUID → MongoDB userId (cache): ${cachedMongoId}`);
          return;
        }
      } catch {
        // Cache miss — fall through to DB
      }
      try {
        const userRepo = this.moduleRef.get(UserRepository, {
          strict: false,
        });
        const dbUser = await userRepo.findByKeycloakIdAndProvider({
          keycloakId: currentUserId,
          provider: 'email',
        });
        if (dbUser) {
          const mongoId = dbUser.id.toString();
          this.cls.set('userId', mongoId);
          await this.redisService
            .set(kcCacheKey, mongoId, USER_KEYCLOAK_CACHE_TTL)
            .catch(() => {/* non-fatal */});
          this.logger.debug(
            `Resolved Keycloak UUID → MongoDB userId: ${mongoId}`,
          );

          // Do not infer tenant from membership. Tenant context must come from
          // request routing/header/session/JWT, never from tenants[0].
        }
      } catch (e) {
        this.logger.error(
          `Error resolving Keycloak user: ${(e as Error).message}`,
        );
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3 — Resolve tenantId (try each hint until one resolves to ObjectId)
  // ──────────────────────────────────────────────────────────────────────────

  private async resolveTenant(raw: { tenantHints: string[] }): Promise<void> {
    for (const hint of raw.tenantHints) {
      if (!hint) continue;

      // Already a valid MongoDB ObjectId — use directly
      if (/^[0-9a-fA-F]{24}$/.test(hint)) {
        this.cls.set('tenantId', hint);
        this.logger.debug(`Tenant resolved (ObjectId): ${hint}`);
        return;
      }

      // Check Redis cache for alias/orgId → ObjectId mapping
      const cacheKey = `tenant:alias:${hint}`;
      try {
        const cached = await this.redisService.get<string>(cacheKey);
        if (cached) {
          this.cls.set('tenantId', cached);
          this.logger.debug(`Tenant resolved (cache hit "${hint}"): ${cached}`);
          return;
        }
      } catch {
        // Cache miss — fall through to DB lookup
      }

      // Resolve alias or Keycloak org ID → ObjectId via DB
      try {
        const tenantRepo = this.moduleRef.get(TenantsRepository, {
          strict: false,
        });
        const tenant =
          (await tenantRepo.findByAlias(hint)) ??
          (await tenantRepo.findByKeycloakOrgId(hint));

        if (tenant) {
          const tenantId = tenant.id.toString();
          this.cls.set('tenantId', tenantId);
          this.logger.debug(
            `Tenant resolved (alias/orgId "${hint}"): ${tenantId}`,
          );
          // Cache the mapping to avoid repeated DB lookups
          await this.redisService
            .set(cacheKey, tenantId, TENANT_ALIAS_CACHE_TTL)
            .catch(() => {/* non-fatal */});
          return;
        }
      } catch (e) {
        this.logger.error(
          `Error resolving tenant hint "${hint}": ${(e as Error).message}`,
        );
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4 — Missing tenant context policy
  // ──────────────────────────────────────────────────────────────────────────

  private rejectMissingTenantContext(request: Request): void {
    const userId = this.cls.get('userId');
    if (!userId) return;

    if (this.isTenantContextOptionalRoute(request)) {
      return;
    }

    throw new BadRequestException(
      'Tenant context is required. Provide a valid tenant subdomain, X-Tenant-Id header in non-production, or tenantId claim.',
    );
  }

  private isTenantContextOptionalRoute(request: Request): boolean {
    const path = request.path || request.originalUrl || '';
    return ['/', '/docs', '/queues', '/api/v1/auth', '/api/v1/onboarding'].some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Utility methods
  // ──────────────────────────────────────────────────────────────────────────

  private extractHeader(req: Request, name: string): string | undefined {
    const value = req.headers[name];
    if (Array.isArray(value)) return value[0];
    return value;
  }

  private decodeJwt(token: string): any {
    try {
      const base64 = token.split('.')[1];
      return JSON.parse(Buffer.from(base64, 'base64url').toString('utf-8'));
    } catch {
      return null;
    }
  }
}
