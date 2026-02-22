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
import { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { jwtDecode } from 'jwt-decode';

@Injectable()
export class HybridAuthGuard extends AuthGuard {
  constructor(
    @Inject(KEYCLOAK_INSTANCE) singleTenant: any, // Keycloak library type
    @Inject(KEYCLOAK_CONNECT_OPTIONS) keycloakOpts: KeycloakConnectConfig,
    @Inject(KEYCLOAK_LOGGER) logger: Logger,
    multiTenant: KeycloakMultiTenantService,
    reflector: Reflector,
    private readonly sessionService: SessionService,
  ) {
    super(singleTenant, keycloakOpts, logger, multiTenant, reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // 1. Prioritize BFF Session Cookie
    const sid = request.cookies?.['sid'];

    if (sid) {
      try {
        const session = await this.sessionService.getSession(sid);
        if (!session) {
          throw new UnauthorizedException('Session invalid or expired');
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
