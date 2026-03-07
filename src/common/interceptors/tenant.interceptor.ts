import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
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
import { UsersDocumentRepository } from '../../users/infrastructure/persistence/document/repositories/user.repository';
import { TenantsRepository } from '../../tenants/infrastructure/persistence/document/repositories/tenant.repository';

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
 *     1. Subdomain alias  (daitoan.crm.com → lookup → ObjectId)
 *     2. x-tenant-id header (DEV/TEST only)
 *     3. BFF session JWT claim (tenantId)
 *     4. Bearer JWT claim (tenantId)
 *     5. User's first tenant membership (fallback)
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

    // ── Step 4: Final fallback — user's first tenant membership ──
    if (!this.cls.get('tenantId')) {
      await this.fallbackTenantFromUser();
    }

    // ── Step 5: Sync activeTenantId for downstream compatibility ──
    const tenantId = this.cls.get('tenantId');
    if (tenantId) {
      this.cls.set('activeTenantId', tenantId);
    }

    this.logger.debug(
      `Context resolved → tenantId=${this.cls.get('tenantId')}, userId=${this.cls.get('userId')}, email=${this.cls.get('email')}`,
    );
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
      try {
        const userRepo = this.moduleRef.get(UsersDocumentRepository, {
          strict: false,
        });
        const dbUser = await userRepo.findByKeycloakIdAndProvider({
          keycloakId: currentUserId,
          provider: 'email',
        });
        if (dbUser) {
          this.cls.set('userId', dbUser.id.toString());
          this.logger.debug(
            `Resolved Keycloak UUID → MongoDB userId: ${dbUser.id}`,
          );

          // Also collect tenant from user if available
          if (dbUser.tenants?.length > 0) {
            raw.tenantHints.push(dbUser.tenants[0].tenant);
          }
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

      // Already a valid MongoDB ObjectId
      if (/^[0-9a-fA-F]{24}$/.test(hint)) {
        this.cls.set('tenantId', hint);
        this.logger.debug(`Tenant resolved (ObjectId): ${hint}`);
        return;
      }

      // Resolve alias or Keycloak org ID → ObjectId
      try {
        const tenantRepo = this.moduleRef.get(TenantsRepository, {
          strict: false,
        });
        const tenant =
          (await tenantRepo.findByAlias(hint)) ??
          (await tenantRepo.findByKeycloakOrgId(hint));

        if (tenant) {
          this.cls.set('tenantId', tenant.id.toString());
          this.logger.debug(
            `Tenant resolved (alias/orgId "${hint}"): ${tenant.id}`,
          );
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
  // Step 4 — Fallback: use the user's first tenant membership
  // ──────────────────────────────────────────────────────────────────────────

  private async fallbackTenantFromUser(): Promise<void> {
    const userId = this.cls.get('userId');
    if (!userId) return;

    try {
      const userRepo = this.moduleRef.get(UsersDocumentRepository, {
        strict: false,
      });
      let dbUser = isValidObjectId(userId)
        ? await userRepo.findById(userId)
        : null;

      if (!dbUser) {
        dbUser = await userRepo.findByKeycloakIdAndProvider({
          keycloakId: userId,
          provider: 'email',
        });
      }

      if (dbUser?.tenants?.length) {
        const tenantId = dbUser.tenants[0].tenant.toString();
        this.cls.set('tenantId', tenantId);
        this.logger.debug(`Tenant fallback from user membership: ${tenantId}`);
      } else {
        this.logger.warn(`No tenant found for user: ${userId}`);
      }
    } catch (e) {
      this.logger.error(`Tenant fallback error: ${(e as Error).message}`);
    }
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
