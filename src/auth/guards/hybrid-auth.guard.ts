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
    const sidCandidates = this.getSidCandidates(request);

    for (const sid of sidCandidates) {
      try {
        const activated = await this.tryActivateSession(request, sid);
        if (activated) return true;
      } catch (e) {
        this.guardLogger.warn(
          `[canActivate] Ignoring invalid sid candidate: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    if (sidCandidates.length > 0) {
      throw new UnauthorizedException('Session invalid or expired');
    }

    return super.canActivate(context) as Promise<boolean>;
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
      session = await this.authService.refreshTokens(sid);
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

  private getSidCandidates(request: Request): string[] {
    const candidates: string[] = [];
    const parsedSid = request.cookies?.['sid'];
    if (typeof parsedSid === 'string' && parsedSid) {
      candidates.push(parsedSid);
    }

    const rawCookieHeader = request.headers.cookie;
    const rawCookie = Array.isArray(rawCookieHeader)
      ? rawCookieHeader.join(';')
      : rawCookieHeader;

    if (rawCookie) {
      for (const part of rawCookie.split(';')) {
        const [rawName, ...rawValueParts] = part.trim().split('=');
        if (rawName !== 'sid') continue;

        const rawValue = rawValueParts.join('=');
        if (!rawValue) continue;

        try {
          candidates.push(decodeURIComponent(rawValue));
        } catch {
          candidates.push(rawValue);
        }
      }
    }

    return Array.from(new Set(candidates));
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
