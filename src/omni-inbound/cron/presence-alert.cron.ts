import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { PresenceAlertService } from '../services/presence-alert.service';

/**
 * PresenceAlertCron — runs every 60 seconds to evaluate agent presence
 * against alert thresholds defined in tenant settings.
 *
 * Discovers active tenants by scanning Redis for `omni:presence:*` hash keys
 * (each tenant with active agents has one). This avoids needing a tenant registry.
 */
@Injectable()
export class PresenceAlertCron {
  private readonly logger = new Logger(PresenceAlertCron.name);

  constructor(
    private readonly alertService: PresenceAlertService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    try {
      const tenantIds = await this.getActiveTenantIds();

      for (const tenantId of tenantIds) {
        try {
          await this.alertService.evaluateAll(tenantId);
        } catch (err: any) {
          this.logger.error(
            `Alert evaluation failed for tenant ${tenantId}: ${err.message}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.error(`PresenceAlertCron failed: ${err.message}`);
    }
  }

  /**
   * Discover active tenants by scanning Redis for `omni:presence:*` hash keys.
   * Each tenant with online agents has a hash at this key.
   */
  private async getActiveTenantIds(): Promise<string[]> {
    const tenantIds: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        'omni:presence:*',
        'COUNT',
        100,
      );
      cursor = nextCursor;
      for (const key of keys) {
        // key = "omni:presence:{tenantId}"
        const parts = key.split(':');
        if (parts.length >= 3) {
          tenantIds.push(parts.slice(2).join(':'));
        }
      }
    } while (cursor !== '0');
    return [...new Set(tenantIds)];
  }
}
