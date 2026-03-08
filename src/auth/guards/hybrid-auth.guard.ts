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

// Refresh the access token 30 seconds before it actually expires
const REFRESH_BUFFER_MS = 30_000;

@Injectable()
export class HybridAuthGuard extends AuthGuard {
  private readonly guardLogger = new Logger(HybridAuthGuard.name);

  constructor(
    @Inject(KEYCLOAK_INSTANCE) singleTenant: any, // Keycloak library type
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
    // 0. Check for @Unprotected() metadata
    const isUnprotected = this._reflector.getAllAndOverride<boolean>(
      'unprotected',
      [context.getHandler(), context.getClass()],
    );

    if (isUnprotected) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    // 1. Prioritize BFF Session Cookie
    const sid = request.cookies?.['sid'];

    if (sid) {
      try {
        let session = await this.sessionService.getSession(sid);
        if (!session) {
          throw new UnauthorizedException('Session invalid or expired');
        }

        // Auto-refresh if access token is expired or about to expire
        if (session.expiresAt - REFRESH_BUFFER_MS <= Date.now()) {
          this.guardLogger.log(
            `[canActivate] Access token expired/expiring for sid=${sid}, auto-refreshing…`,
          );
          try {
            session = await this.authService.refreshTokens(sid);
          } catch {
            throw new UnauthorizedException(
              'Session expired — please log in again',
            );
          }
        }

        // Verify/Assign payload to request
        const decodedToken = this.decodeJwt(
          session.idToken || session.accessToken,
        );
        if (!decodedToken) {
          throw new UnauthorizedException('Malformed token in session');
        }

        // Assign to req.user exactly like nest-keycloak-connect does
        (request as any).user = decodedToken;

        return true;
      } catch (e) {
        if (e instanceof UnauthorizedException) throw e;
        throw new UnauthorizedException('Session validation failed');
      }
    }

    // 2. Fallback to Bearer Token (Keycloak AuthGuard)
    return super.canActivate(context) as Promise<boolean>;
  }

  private decodeJwt(token: string): any {
    try {
      return jwtDecode(token);
    } catch {
      return null;
    }
  }
}
