import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { ClsService } from 'nestjs-cls';

/**
 * Guards endpoints that should only be called by internal services
 * (e.g. crm-manager-api → crm-api). Validates the X-Internal-Api-Key header.
 *
 * Set INTERNAL_API_KEY in env. If unset in development the guard skips validation
 * so local dev doesn't break, but in production the key is required.
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
      if (process.env.NODE_ENV === 'production') {
        throw new UnauthorizedException(
          'INTERNAL_API_KEY is not configured on this server',
        );
      }
      // Dev/test: allow through with a warning logged once at startup
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-internal-api-key'];
    const key = Array.isArray(provided) ? provided[0] : provided;

    if (!key || key !== expectedKey) {
      throw new UnauthorizedException('Invalid or missing internal API key');
    }

    // Audit trail: mark this request as API-key-initiated
    this.cls.set('executionSource', 'A');
    this.cls.set('sourceContext', { keyId: 'INTERNAL_API_KEY' });

    return true;
  }
}
