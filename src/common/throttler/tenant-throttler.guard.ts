import { Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { ClsService } from 'nestjs-cls';

/**
 * Throttle by tenantId + userId rather than IP. The default IP-based
 * tracker is wrong for our shape:
 *   - Many real users share an egress IP (corporate NAT).
 *   - One tenant abusing exports/bulk-tag should not block another.
 *
 * Falls back to IP when no tenant context is available — that path covers
 * webhook endpoints and unauthenticated health probes.
 */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    @Optional() private readonly cls?: ClsService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    try {
      const tenantId = this.cls?.get<string>('tenantId');
      const userId = this.cls?.get<string>('userId');
      if (tenantId) {
        const userSuffix = userId ? `:${userId}` : '';
        return `tenant:${tenantId}${userSuffix}`;
      }
    } catch {
      /* CLS not active for this request */
    }
    return super.getTracker(req);
  }
}

/**
 * Convenience throttler configs for explicit `@Throttle()` annotations on
 * heavy endpoints.
 */
export const TenantThrottle = {
  export: { default: { limit: 5, ttl: 60_000 } },
  bulk: { default: { limit: 20, ttl: 60_000 } },
  send: { default: { limit: 60, ttl: 60_000 } },
};
