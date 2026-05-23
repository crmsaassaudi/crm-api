import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import type Redis from 'ioredis';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { OMNI_AUTO_RESOLVE_QUEUE } from '../queue/omni-auto-resolve-queue.constants';
import type { AutoResolveJobData } from '../queue/auto-resolve.processor';

/**
 * AutoResolveService — manages per-conversation auto-resolve delayed jobs.
 *
 * Instead of scanning the entire database every N minutes (cron approach),
 * each conversation gets its own delayed BullMQ job. This scales to millions
 * of conversations without any DB load.
 *
 * Key operations:
 *   - scheduleAutoResolve: create a delayed job when a conversation is created
 *   - rescheduleAutoResolve: reset the timer when a new message arrives
 *   - cancelAutoResolve: remove the job when a conversation is manually resolved
 *
 * Two-phase warning flow (if configured):
 *   1. After `autoResolveTimeoutHours - autoWarningBeforeResolveHours`:
 *      → Send "Are you still there?" warning
 *   2. After remaining `autoWarningBeforeResolveHours`:
 *      → Actually resolve the conversation
 */
@Injectable()
export class AutoResolveService {
  private readonly logger = new Logger(AutoResolveService.name);

  /** Redis key prefix for tracking warning state */
  private readonly WARN_KEY_PREFIX = 'omni:auto-warn';

  constructor(
    private readonly settingsService: CrmSettingsService,
    @InjectQueue(OMNI_AUTO_RESOLVE_QUEUE)
    private readonly autoResolveQueue: Queue<AutoResolveJobData>,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Schedule an auto-resolve delayed job for a conversation.
   * Called when a new conversation is created.
   *
   * If auto-warning is configured, the first job fires the warning
   * phase; otherwise it fires the resolve phase directly.
   */
  async scheduleAutoResolve(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    const config = await this.getLifecycleConfig(tenantId);

    if (!config.autoResolveEnabled) {
      return;
    }

    const timeoutHours = config.autoResolveTimeoutHours ?? 48;
    const warningHours = config.autoWarningBeforeResolveHours ?? 0;

    let delayMs: number;
    let phase: 'warning' | 'resolve';

    if (warningHours > 0 && warningHours < timeoutHours) {
      // Schedule warning first, then resolve later
      delayMs = (timeoutHours - warningHours) * 60 * 60 * 1000;
      phase = 'warning';
    } else {
      // No warning — schedule direct resolve
      delayMs = timeoutHours * 60 * 60 * 1000;
      phase = 'resolve';
    }

    const jobId = this.buildJobId(conversationId, phase);

    try {
      // Remove any existing job for this conversation (both phases)
      await this.removeExistingJobs(conversationId);

      await this.autoResolveQueue.add(
        'auto-resolve',
        { tenantId, conversationId, phase },
        { jobId, delay: delayMs },
      );

      this.logger.debug(
        `Scheduled auto-resolve [${phase}] for conversation ${conversationId} ` +
          `in ${(delayMs / (1000 * 60 * 60)).toFixed(1)}h`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to schedule auto-resolve for conversation ${conversationId}: ${err.message}`,
      );
    }
  }

  /**
   * Schedule the resolve-phase job after a warning has been sent.
   * Called by the auto-resolve processor after emitting the warning.
   */
  async scheduleResolveAfterWarning(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    const config = await this.getLifecycleConfig(tenantId);
    const warningHours = config.autoWarningBeforeResolveHours ?? 2;
    const delayMs = warningHours * 60 * 60 * 1000;

    const jobId = this.buildJobId(conversationId, 'resolve');

    try {
      await this.autoResolveQueue.add(
        'auto-resolve',
        { tenantId, conversationId, phase: 'resolve' },
        { jobId, delay: delayMs },
      );

      this.logger.debug(
        `Scheduled auto-resolve [resolve] for conversation ${conversationId} ` +
          `in ${warningHours}h (after warning)`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to schedule resolve-after-warning for ${conversationId}: ${err.message}`,
      );
    }
  }

  /**
   * Reschedule auto-resolve when a new message arrives.
   * Removes the old job and creates a new one with a fresh delay.
   *
   * Also clears any warning state — the customer has replied.
   */
  async rescheduleAutoResolve(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    // Clear warning state if any
    await this.redis.del(`${this.WARN_KEY_PREFIX}:${conversationId}`);

    // Re-schedule from scratch
    await this.scheduleAutoResolve(tenantId, conversationId);
  }

  /**
   * Cancel auto-resolve when a conversation is manually resolved/closed.
   */
  async cancelAutoResolve(conversationId: string): Promise<void> {
    try {
      await this.removeExistingJobs(conversationId);
      await this.redis.del(`${this.WARN_KEY_PREFIX}:${conversationId}`);
      this.logger.debug(
        `Cancelled auto-resolve jobs for conversation ${conversationId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to cancel auto-resolve for ${conversationId}: ${err.message}`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────

  private buildJobId(
    conversationId: string,
    phase: 'warning' | 'resolve',
  ): string {
    return `auto-resolve-${phase}-${conversationId}`;
  }

  /**
   * Remove all existing auto-resolve jobs for a conversation (both phases).
   */
  private async removeExistingJobs(conversationId: string): Promise<void> {
    for (const phase of ['warning', 'resolve'] as const) {
      const jobId = this.buildJobId(conversationId, phase);
      try {
        const job = await this.autoResolveQueue.getJob(jobId);
        if (job) {
          await job.remove();
        }
      } catch {
        // Job may not exist — safe to ignore
      }
    }
  }

  private async getLifecycleConfig(tenantId: string): Promise<{
    autoResolveEnabled: boolean;
    autoResolveTimeoutHours: number;
    autoWarningBeforeResolveHours: number;
    autoWarningMessage: string;
  }> {
    const defaults = {
      autoResolveEnabled: true,
      autoResolveTimeoutHours: 48,
      autoWarningBeforeResolveHours: 0,
      autoWarningMessage:
        'Are you still there? This conversation will be closed soon if there is no response.',
    };

    try {
      const config = await this.settingsService.getSetting(
        'omni_session_lifecycle',
        tenantId,
      );
      return config ? { ...defaults, ...config } : defaults;
    } catch {
      return defaults;
    }
  }
}
