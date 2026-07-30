import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { assertCrmBotInternalSecret } from './internal-secret.util';

/**
 * Authenticates crm-bot ↔ crm-api internal endpoints.
 *
 * A guard rather than a call inside each handler: guards run BEFORE pipes, so an
 * unauthenticated caller is rejected before the global ValidationPipe parses the
 * body. Checking inside the handler meant an anonymous request could probe the
 * DTO shape — POST {} answered 422 (validation) instead of 403 (auth).
 *
 * Fails closed when CRM_BOT_INTERNAL_SECRET is unset — see the util.
 */
@Injectable()
export class CrmBotInternalSecretGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-crm-internal-secret'];

    assertCrmBotInternalSecret(
      this.configService,
      Array.isArray(provided) ? provided[0] : provided,
    );

    return true;
  }
}
