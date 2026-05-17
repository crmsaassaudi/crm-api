import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutomationDelayedProducer } from './automation-delayed.producer';
import { RedisLockService } from '../../redis/redis-lock.service';

@Injectable()
export class AutomationDelayedScheduler {
  private readonly logger = new Logger(AutomationDelayedScheduler.name);
  private isPromoting = false;

  constructor(
    private readonly delayedProducer: AutomationDelayedProducer,
    private readonly lockService: RedisLockService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async promoteDueDelayedJobs(): Promise<void> {
    if (this.isPromoting) return;
    this.isPromoting = true;

    try {
      await this.lockService.acquire(
        'cron:automation-delayed:promote-due',
        55_000,
        () => this.delayedProducer.promoteDueJobs(),
        0,
        1,
      );
    } catch (error: any) {
      if (error?.message?.includes('Could not acquire lock')) {
        this.logger.debug(
          '[DelayedScheduler] Skipped; another worker owns this tick',
        );
        return;
      }
      this.logger.error(
        `[DelayedScheduler] Failed to promote due delayed jobs: ${error.message}`,
        error.stack,
      );
    } finally {
      this.isPromoting = false;
    }
  }
}
