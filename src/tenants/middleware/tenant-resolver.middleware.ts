import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../../config/config.type';

/**
 * TenantResolverMiddleware
 *
 * Extracts the tenant alias from the request's Host header.
 * For a host of "toancorp.crm.com", the alias is "toancorp".
 *
 * The resolved alias is attached to the request object as `req['tenantAlias']`
 * and can be read downstream (guards, interceptors, CLS setup).
 *
 * Hosts that don't carry a subdomain (e.g. "crm.com", "localhost", "api.crm.com")
 * are left with undfined tenantAlias.
 */
@Injectable()
export class TenantResolverMiddleware implements NestMiddleware {
  /**
   * The root domain configured in the environment (e.g. "crm.com").
   * We use this to determine which part of the host is the subdomain.
   */
  private readonly rootDomain: string;

  constructor(configService: ConfigService<AllConfigType>) {
    // Read from config; fall back to "crm.com" for local dev
    this.rootDomain =
      configService.get('app.rootDomain', { infer: true }) ?? 'crm.com';
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    const host = req.hostname; // e.g. "toancorp.crm.com" (strips port)

    if (host && host.endsWith(`.${this.rootDomain}`)) {
      // Extract the leading subdomain segment
      const subdomain = host.slice(0, host.length - this.rootDomain.length - 1);

      // Only treat single-level subdomains as tenant aliases.
      // "app.toancorp.crm.com" would have subdomain = "app.toancorp" — skip those.
      if (subdomain && !subdomain.includes('.')) {
        (req as any).tenantAlias = subdomain;
      }
    }

    next();
  }
}
