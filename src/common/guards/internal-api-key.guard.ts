import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import * as crypto from 'crypto';

/**
 * Guards endpoints that should only be called by internal services
 * (e.g. crm-manager-api → crm-api). Validates the X-Internal-Api-Key header.
 *
 * Fails CLOSED when INTERNAL_API_KEY is unset — matching
 * `CrmBotInternalSecretGuard`, the other internal-trust boundary in this
 * codebase. It previously skipped validation whenever NODE_ENV was not exactly
 * `production`, which made an unset NODE_ENV (the default under a bare
 * `node dist/main`) enough to expose tenant provisioning and
 * `feature-permissions/grant` — a tenant's RBAC ceiling — to anonymous callers.
 * A missing secret is a misconfiguration, and a misconfiguration must not open
 * a door.
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly cls: ClsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const expectedKey = this.configService.get<string>('INTERNAL_API_KEY', {
      infer: true,
    });

    if (!expectedKey) {
      throw new UnauthorizedException(
        'INTERNAL_API_KEY is not configured on this server',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-internal-api-key'];
    const key = Array.isArray(provided) ? provided[0] : provided;

    // Constant-time comparison, so a wrong key cannot be recovered by timing.
    // A plain `!==` leaks key material byte-by-byte via response latency.
    if (
      !key ||
      key.length !== expectedKey.length ||
      !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expectedKey))
    ) {
      throw new UnauthorizedException('Invalid or missing internal API key');
    }

    // Audit trail: mark this request as API-key-initiated
    this.cls.set('executionSource', 'A');
    this.cls.set('sourceContext', { keyId: 'INTERNAL_API_KEY' });

    return true;
  }
}
