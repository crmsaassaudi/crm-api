import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TaskRepository } from './infrastructure/persistence/document/repositories/task.repository';
import {
  RedisLockService,
  isLockContention,
} from '../redis/redis-lock.service';
import {
  RetentionPurgeRunner,
  resolveRetentionDays,
} from '../common/references/retention-purge.runner';
import { TASK_REFERENCES } from './task-references.registry';

/** Days a soft-deleted task stays restorable. Matches the other domains. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * The only path that hard-deletes a task.
 *
 * Completes the recycle bin: without it a soft-deleted task is restorable for as long as
 * the database exists, which is the accumulation half of what soft delete introduced. The
 * cascade policies live in `task-references.registry.ts` — read that to find out what happens to a
 * record when its task is purged; the loop itself is `RetentionPurgeRunner`.
 */
@Injectable()
export class TaskPurgeService {
  private readonly logger = new Logger(TaskPurgeService.name);

  constructor(
    private readonly repository: TaskRepository,
    private readonly lockService: RedisLockService,
    private readonly runner: RetentionPurgeRunner,
  ) {}

  private get retentionDays(): number {
    return resolveRetentionDays(
      'TASK_PURGE_RETENTION_DAYS',
      DEFAULT_RETENTION_DAYS,
    );
  }

  /**
   * 04:20, LAST and after the rollup. Every other purge detaches tasks (`relatedTo` unset), so a task that is itself expired should be seen in its final state rather than mid-detach.
   *
   * Cluster-singleton: `@Cron` fires in every process that loaded ScheduleModule, and N
   * replicas racing to purge the same records would each run the cascade.
   */
  @Cron('20 4 * * *')
  async runRetentionPurge(): Promise<void> {
    await this.lockService
      .acquire(
        'cron:tasks:retention-purge',
        { ttl: 30 * 60 * 1000, maxRetries: 0 },
        async () => {
          const result = await this.purgeExpired();
          if (result.purged > 0 || result.cascaded > 0) {
            this.logger.log(
              `Task purge: ${result.purged} task(s) removed after ` +
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
            'Task purge skipped: another replica holds the lock',
          );
        } else {
          this.logger.error(
            `Task purge FAILED: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      });
  }

  /** One pass. Exposed so an operator script or a test can drive it. */
  async purgeExpired(): Promise<{ purged: number; cascaded: number }> {
    return this.runner.run({
      entity: 'task',
      references: TASK_REFERENCES,
      repository: this.repository,
      retentionDays: this.retentionDays,
    });
  }
}
