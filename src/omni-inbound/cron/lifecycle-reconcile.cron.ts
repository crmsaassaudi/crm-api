import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { RedisLockService } from '../../redis/redis-lock.service';
import { runAsClusterSingleton } from '../../common/scheduling/cluster-singleton';
import { ConversationRepository } from '../repositories/conversation.repository';
import { AutoResolveService } from '../services/auto-resolve.service';
import { ConversationLifecycleService } from '../services/conversation-lifecycle.service';

/** How far past its deadline a conversation must be before we re-arm it. */
const OVERDUE_GRACE_MS = 15 * 60_000;

const BATCH_SIZE = 200;

/**
 * Catches conversations whose auto-resolve timer no longer exists.
 *
 * Timers live only as BullMQ delayed jobs, which is the right trade for scale —
 * no periodic scan over every conversation — but it makes the schedule exactly
 * as durable as Redis. After a flush or a restore from an older snapshot, the
 * affected conversations would stay open forever with nothing to detect it.
 *
 * The scan is cheap because it only looks at conversations already past their
 * deadline: in a healthy system that set is empty.
 */
@Injectable()
export class LifecycleReconcileCron {
  private readonly logger = new Logger(LifecycleReconcileCron.name);

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly autoResolve: AutoResolveService,
    private readonly lifecycle: ConversationLifecycleService,
    private readonly lockService: RedisLockService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reArmMissingTimers(): Promise<void> {
    await runAsClusterSingleton(
      { lockService: this.lockService, logger: this.logger },
      { name: 'omni:lifecycle:re-arm-timers', lockTtlMs: 9 * 60_000 },
      () => this.run(),
    );
  }

  private async run(): Promise<void> {
    const config = await this.lifecycle.getSessionLifecycleConfig();
    if (!config.autoResolveEnabled) return;

    const timeoutMs = (config.autoResolveTimeoutHours ?? 48) * 3_600_000;
    const overdueBefore = new Date(Date.now() - timeoutMs - OVERDUE_GRACE_MS);

    const overdue = await this.conversations.findOverdueForAutoResolve(
      overdueBefore,
      BATCH_SIZE,
    );
    if (overdue.length === 0) return;

    const rescheduled = await this.autoResolve.reconcileMissingTimers(overdue);
    if (rescheduled > 0) {
      this.logger.warn(
        `Re-armed ${rescheduled}/${overdue.length} overdue conversation(s)`,
      );
    }
  }
}
