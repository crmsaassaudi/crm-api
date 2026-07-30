import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DealRepository } from './infrastructure/persistence/document/repositories/deal.repository';
import {
  RedisLockService,
  isLockContention,
} from '../redis/redis-lock.service';
import {
  RetentionPurgeRunner,
  resolveRetentionDays,
} from '../common/references/retention-purge.runner';
import { DEAL_REFERENCES } from './deal-references.registry';

/** Days a soft-deleted deal stays restorable. Matches the other domains. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * The only path that hard-deletes a deal.
 *
 * Completes the recycle bin: without it a soft-deleted deal is restorable for as long as
 * the database exists, which is the accumulation half of what soft delete introduced. The
 * cascade policies live in `deal-references.registry.ts` — read that to find out what happens to a
 * record when its deal is purged; the loop itself is `RetentionPurgeRunner`.
 */
@Injectable()
export class DealPurgeService {
  private readonly logger = new Logger(DealPurgeService.name);

  constructor(
    private readonly repository: DealRepository,
    private readonly lockService: RedisLockService,
    private readonly runner: RetentionPurgeRunner,
  ) {}

  private get retentionDays(): number {
    return resolveRetentionDays(
      'DEAL_PURGE_RETENTION_DAYS',
      DEFAULT_RETENTION_DAYS,
    );
  }

  /**
   * 03:40, after contacts (03:00) and accounts (03:30) and before the 04:00 metrics rollup. Staggered rather than concurrent: these passes `updateMany` overlapping sets of tickets and tasks, and none of the work is urgent enough to contend for the same documents.
   *
   * Cluster-singleton: `@Cron` fires in every process that loaded ScheduleModule, and N
   * replicas racing to purge the same records would each run the cascade.
   */
  @Cron('40 3 * * *')
  async runRetentionPurge(): Promise<void> {
    await this.lockService
      .acquire(
        'cron:deals:retention-purge',
        { ttl: 30 * 60 * 1000, maxRetries: 0 },
        async () => {
          const result = await this.purgeExpired();
          if (result.purged > 0 || result.cascaded > 0) {
            this.logger.log(
              `Deal purge: ${result.purged} deal(s) removed after ` +
                `${this.retentionDays}d retention, ${result.cascaded} related row(s) handled`,
            );
          }
        },
      )
      .catch((err) => {
        // Contention is normal — N replicas tick, one wins. A job that THREW is not, and
        // must not be reported as "skipped" at debug level.
        if (isLockContention(err)) {
          this.logger.debug(
            'Deal purge skipped: another replica holds the lock',
          );
        } else {
          this.logger.error(
            `Deal purge FAILED: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      });
  }

  /** One pass. Exposed so an operator script or a test can drive it. */
  async purgeExpired(): Promise<{ purged: number; cascaded: number }> {
    return this.runner.run({
      entity: 'deal',
      references: DEAL_REFERENCES,
      repository: this.repository,
      retentionDays: this.retentionDays,
    });
  }
}
