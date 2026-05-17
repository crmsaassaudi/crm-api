import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../../config/config.type';

/**
 * TenantResolverMiddleware
 *
 * Extracts the tenant alias from the request's Host header.
 * For a host of "toancorp.crmsaudi.dev", the alias is "toancorp".
 *
 * The resolved alias is attached to the request object as `req['tenantAlias']`
 * and can be read downstream (guards, interceptors, CLS setup).
 *
 * Hosts that don't carry a tenant subdomain (e.g. "crmsaudi.dev", "localhost", "api.crmsaudi.dev")
 * are left with undfined tenantAlias.
 */
@Injectable()
export class TenantResolverMiddleware implements NestMiddleware {
  /**
   * The root domain configured in the environment (e.g. "crmsaudi.dev").
   * We use this to determine which part of the host is the subdomain.
   */
  private readonly rootDomain: string;

  constructor(configService: ConfigService<AllConfigType>) {
    // Read from config; fall back to the production root domain.
    this.rootDomain = this.normalizeHost(
      configService.get('app.rootDomain', { infer: true }) ?? 'crmsaudi.dev',
    );
  }

  private readonly SYSTEM_SUBDOMAINS = ['api', 'admin', 'auth', 'www', 'mail'];

  use(req: Request, _res: Response, next: NextFunction): void {
    const host = this.normalizeHost(req.hostname); // e.g. "toancorp.crmsaudi.dev" (strips port)

    if (host && host.endsWith(`.${this.rootDomain}`)) {
      // Extract the leading subdomain segment
      const subdomain = host.slice(0, host.length - this.rootDomain.length - 1);

      // Only treat single-level subdomains as tenant aliases.
      // Exclude known system subdomains.
      if (
        subdomain &&
        !subdomain.includes('.') &&
        !this.SYSTEM_SUBDOMAINS.includes(subdomain.toLowerCase())
      ) {
        (req as any).tenantAlias = subdomain;
      }
    }

    next();
  }

  private normalizeHost(host?: string): string {
    return (host ?? '').toLowerCase().replace(/\.$/, '');
  }
}
