import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { MetricsService } from '../../observability/metrics.service';

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

  async shouldThrottle(
    tenantId: string,
  ): Promise<{ throttled: boolean; currentRate: number }> {
    const key = `automation:rate:${tenantId}`;

    try {
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
