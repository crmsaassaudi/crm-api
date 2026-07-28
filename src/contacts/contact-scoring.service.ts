import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import { RedisLockService } from '../redis/redis-lock.service';

@Injectable()
export class ContactScoringService {
  private readonly logger = new Logger(ContactScoringService.name);

  constructor(
    private readonly repository: ContactRepository,
    private readonly lockService: RedisLockService,
  ) {}

  /**
   * Cluster-singleton: `@Cron` fires in every process that loaded
   * ScheduleModule, so without the lock N replicas run the same all-tenant
   * rescoring pass concurrently against the same documents.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runNightlyScoreRefresh(): Promise<void> {
    await this.lockService
      .acquire(
        'cron:contacts:nightly-scoring',
        { ttl: 30 * 60 * 1000, maxRetries: 0 },
        async () => {
          const result =
            await this.repository.recomputeScoresForAllTenants(5_000);
          this.logger.log(
            `Contact scoring refreshed: scanned=${result.scanned}, updated=${result.updated}`,
          );
        },
      )
      .catch((err) =>
        this.logger.debug(`Contact scoring skipped: ${(err as Error).message}`),
      );
  }
}
