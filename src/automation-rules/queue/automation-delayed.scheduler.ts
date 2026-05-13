import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutomationDelayedProducer } from './automation-delayed.producer';

@Injectable()
export class AutomationDelayedScheduler {
  private readonly logger = new Logger(AutomationDelayedScheduler.name);
  private isPromoting = false;

  constructor(private readonly delayedProducer: AutomationDelayedProducer) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async promoteDueDelayedJobs(): Promise<void> {
    if (this.isPromoting) return;
    this.isPromoting = true;

    try {
      await this.delayedProducer.promoteDueJobs();
    } catch (error: any) {
      this.logger.error(
        `[DelayedScheduler] Failed to promote due delayed jobs: ${error.message}`,
        error.stack,
      );
    } finally {
      this.isPromoting = false;
    }
  }
}
