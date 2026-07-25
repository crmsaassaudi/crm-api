import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  Inject,
  Logger,
} from '@nestjs/common';
import {
  AuthGuard,
  KeycloakConnectConfig,
  KeycloakMultiTenantService,
  KEYCLOAK_INSTANCE,
  KEYCLOAK_CONNECT_OPTIONS,
  KEYCLOAK_LOGGER,
} from 'nest-keycloak-connect';
import { SessionService } from '../services/session.service';
import { AuthService } from '../auth.service';
import { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { jwtDecode } from 'jwt-decode';

// Refresh the access token 30 seconds before it actually expires.
const REFRESH_BUFFER_MS = 30_000;

@Injectable()
export class HybridAuthGuard extends AuthGuard {
  private readonly guardLogger = new Logger(HybridAuthGuard.name);

  constructor(
    @Inject(KEYCLOAK_INSTANCE) singleTenant: any,
    @Inject(KEYCLOAK_CONNECT_OPTIONS) keycloakOpts: KeycloakConnectConfig,
    @Inject(KEYCLOAK_LOGGER) logger: Logger,
    multiTenant: KeycloakMultiTenantService,
    private readonly _reflector: Reflector,
    private readonly sessionService: SessionService,
    private readonly authService: AuthService,
  ) {
    super(singleTenant, keycloakOpts, logger, multiTenant, _reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isUnprotected = this._reflector.getAllAndOverride<boolean>(
      'unprotected',
      [context.getHandler(), context.getClass()],
    );

    if (isUnprotected) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const sid = this.getSid(request);

    if (sid) {
      try {
        if (await this.tryActivateSession(request, sid)) return true;
      } catch (e) {
        this.guardLogger.warn(
          `[canActivate] Session activation failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      throw new UnauthorizedException('Session invalid or expired');
    }

    return Promise.resolve(super.canActivate(context)).then(Boolean);
  }

  private async tryActivateSession(
    request: Request,
    sid: string,
  ): Promise<boolean> {
    let session = await this.sessionService.getSession(sid);
    if (!session) return false;

    if (session.expiresAt - REFRESH_BUFFER_MS <= Date.now()) {
      this.guardLogger.log(
        `[canActivate] Access token expired/expiring for sid=${sid}, auto-refreshing...`,
      );
      try {
        session = await this.authService.refreshTokens(sid);
      } catch (e) {
        this.guardLogger.warn(
          `[canActivate] Token refresh failed for sid=${sid}: ${(e as Error).message} — forcing re-authentication`,
        );
        return false;
      }
    }

    const sessionToken = session.idToken || session.accessToken;
    if (!sessionToken) {
      if (!this.isOnboardingSessionRoute(request)) {
        return false;
      }

      (request as any).user = {
        id: session.userId,
        sub: session.userId,
      };
      this.setSelectedSid(request, sid);
      return true;
    }

    const decodedToken = this.decodeJwt(sessionToken);
    if (!decodedToken) {
      return false;
    }

    (request as any).user = decodedToken;
    this.setSelectedSid(request, sid);
    return true;
  }

  private decodeJwt(token: string): any {
    try {
      return jwtDecode(token);
    } catch {
      return null;
    }
  }

  /**
   * Exactly one session cookie is accepted (H-01).
   *
   * This used to collect EVERY `sid` cookie from the raw header and try each
   * until one activated. Combined with a `.crmsaudi.dev`-scoped cookie, that was
   * a session-fixation primitive: any sibling subdomain — including the
   * third-party bot/chat apps — can set a `sid` on the parent domain, the
   * victim's browser sends both, and the guard would happily authenticate the
   * attacker's session instead. The victim then works inside it.
   *
   * With a single accepted value, a duplicate `sid` is an anomaly, not a menu:
   * the request is rejected and the user re-authenticates with a clean cookie.
   */
  private getSid(request: Request): string | undefined {
    const rawCookieHeader = request.headers.cookie;
    const rawCookie = Array.isArray(rawCookieHeader)
      ? rawCookieHeader.join(';')
      : rawCookieHeader;

    const values: string[] = [];
    if (rawCookie) {
      for (const part of rawCookie.split(';')) {
        const [rawName, ...rawValueParts] = part.trim().split('=');
        if (rawName !== 'sid') continue;
        const rawValue = rawValueParts.join('=');
        if (!rawValue) continue;
        try {
          values.push(decodeURIComponent(rawValue));
        } catch {
          values.push(rawValue);
        }
      }
    }

    const distinct = Array.from(new Set(values));

    if (distinct.length > 1) {
      this.guardLogger.warn(
        `[canActivate] Rejecting request carrying ${distinct.length} distinct sid cookies (possible cookie-tossing / session fixation attempt)`,
      );
      throw new UnauthorizedException(
        'Ambiguous session. Clear your cookies and sign in again.',
      );
    }

    if (distinct.length === 1) return distinct[0];

    // Fall back to the parsed cookie (cookie-parser) when no raw header exists.
    const parsedSid = request.cookies?.['sid'];
    return typeof parsedSid === 'string' && parsedSid ? parsedSid : undefined;
  }

  private setSelectedSid(request: Request, sid: string): void {
    (request as any).cookies = {
      ...(request as any).cookies,
      sid,
    };
  }

  private isOnboardingSessionRoute(request: Request): boolean {
    const path = request.originalUrl || request.url || '';
    return (
      path.includes('/onboarding/context') ||
      path.includes('/onboarding/complete') ||
      path.includes('/onboarding/status/')
    );
  }
}
