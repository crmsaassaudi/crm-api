import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

/**
 * BulkEventThrottleService — token-bucket rate limiter using Redis.
 *
 * Prevents Redis/CPU starvation when > 1000 events are emitted per second
 * for a single tenant (e.g., from a CSV Import of 50,000 records).
 *
 * Uses Redis INCR + EXPIRE(1s) for a sliding-window token bucket.
 *
 * @threshold configurable via AUTOMATION_RATE_LIMIT_PER_SECOND env (default: 1000)
 */
@Injectable()
export class BulkEventThrottleService {
  private readonly logger = new Logger(BulkEventThrottleService.name);
  private readonly threshold: number;

  constructor(
    @Inject(IOREDIS_CLIENT)
    private readonly redis: Redis,
  ) {
    this.threshold = parseInt(
      process.env.AUTOMATION_RATE_LIMIT_PER_SECOND || '1000',
      10,
    );
  }

  /**
   * Check if the current event rate for a tenant exceeds the threshold.
   * Returns { throttled, currentRate } — caller decides how to route.
   */
  async shouldThrottle(
    tenantId: string,
  ): Promise<{ throttled: boolean; currentRate: number }> {
    const key = `automation:rate:${tenantId}`;

    try {
      const current = await this.redis.incr(key);

      // Set expiry only on first increment (when key is created)
      if (current === 1) {
        await this.redis.expire(key, 1);
      }

      const throttled = current > this.threshold;

      if (throttled && current === this.threshold + 1) {
        // Log only once when crossing the threshold
        this.logger.warn(
          `[Throttle] Tenant ${tenantId} exceeded ${this.threshold} events/sec — routing to bulk queue`,
        );
      }

      return { throttled, currentRate: current };
    } catch (error: any) {
      // On Redis error, default to NOT throttling (fail-open)
      this.logger.error(
        `[Throttle] Redis error for tenant ${tenantId}: ${error.message}`,
      );
      return { throttled: false, currentRate: 0 };
    }
  }
}
