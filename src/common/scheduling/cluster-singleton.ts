import { Logger } from '@nestjs/common';
import {
  RedisLockService,
  isLockContention,
} from '../../redis/redis-lock.service';

/**
 * Run a scheduled job on exactly one replica.
 *
 * `@Cron` fires in every process that loaded ScheduleModule, so without this
 * every replica runs the same scan on the same rows. For jobs whose writes are
 * individually guarded that only wastes work; for jobs that publish events or
 * hand work out it produces duplicates.
 *
 * Losing the race is the normal outcome and is logged at debug. A job that
 * actually threw is logged as an error — conflating the two is how a broken
 * nightly job can look like a quiet one.
 */
export async function runAsClusterSingleton(
  deps: { lockService: RedisLockService; logger: Logger },
  job: { name: string; lockTtlMs: number },
  run: () => Promise<unknown>,
): Promise<void> {
  await deps.lockService
    .acquire(`cron:${job.name}`, { ttl: job.lockTtlMs, maxRetries: 0 }, run)
    .catch((err) => {
      if (isLockContention(err)) {
        deps.logger.debug(
          `${job.name} skipped: another replica holds the lock`,
        );
        return;
      }
      deps.logger.error(
        `${job.name} FAILED: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    });
}
