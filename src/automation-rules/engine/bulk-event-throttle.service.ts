import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { MetricsService } from '../../observability/metrics.service';

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
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.threshold = parseInt(
      process.env.AUTOMATION_RATE_LIMIT_PER_SECOND ?? '1000',
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
      // Atomic INCR + EXPIRE via Lua script to prevent key leaks
      // if the process crashes between the two Redis commands.
      // (Same proven pattern as LoopPreventionService.checkStrictLoop)
      const incrWithTtlScript = `
        local count = redis.call('incr', KEYS[1])
        if count == 1 then
          redis.call('expire', KEYS[1], ARGV[1])
        end
        return count
      `;
      const current = (await this.redis.eval(
        incrWithTtlScript,
        1,
        key,
        '1',
      )) as number;

      const throttled = current > this.threshold;

      if (throttled && current === this.threshold + 1) {
        // Log only once when crossing the threshold
        this.logger.warn(
          `[Throttle] Tenant ${tenantId} exceeded ${this.threshold} events/sec — routing to bulk queue`,
        );
        this.metrics?.incrementCounter(
          'crm_automation_throttle_engaged_total',
          {
            tenant: tenantId,
          },
        );
      }

      return { throttled, currentRate: current };
    } catch (error: any) {
      // Fail OPEN: a Redis outage must not stop automations from running. The
      // trade-off is that the bulk-queue safety valve is unavailable at exactly
      // the moment the system is already degraded, so this path is counted —
      // silently failing open is how a protection turns into a surprise.
      this.logger.error(
        `[Throttle] Redis error for tenant ${tenantId} — failing OPEN ` +
          `(no throttling applied): ${error.message}`,
      );
      this.metrics?.incrementCounter(
        'crm_automation_throttle_fail_open_total',
        {
          tenant: tenantId,
        },
      );
      return { throttled: false, currentRate: 0 };
    }
  }
}
