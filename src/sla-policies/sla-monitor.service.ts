import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SLA_BREACH_QUEUE } from './queue/sla-queue.constants';
import type { SlaBreachJobData } from './queue/sla-breach.processor';

/**
 * SlaMonitorService — manages per-conversation SLA breach-check delayed jobs.
 *
 * Instead of scanning the entire database every minute (cron approach),
 * each conversation gets its own delayed BullMQ job scheduled for exactly
 * the SLA deadline duration. This scales to millions of conversations
 * without any DB load.
 *
 * Key operations:
 *   - scheduleSlaBreachCheck: create a delayed job when SLA deadline is set
 *   - cancelSlaBreachCheck: remove the job when agent responds in time
 *   - rescheduleSlaBreachCheck: reset the timer (for next_response SLA)
 */
@Injectable()
export class SlaMonitorService {
  private readonly logger = new Logger(SlaMonitorService.name);

  constructor(
    @InjectQueue(SLA_BREACH_QUEUE)
    private readonly slaBreachQueue: Queue<SlaBreachJobData>,
  ) {}

  /**
   * Schedule an SLA breach-check delayed job for a conversation.
   *
   * Called by SlaTriggerListener when a new conversation is created
   * and an SLA policy applies. The job fires exactly at the deadline.
   *
   * @param tenantId   - tenant owning the conversation
   * @param conversationId - the conversation to monitor
   * @param slaPolicyId    - the SLA policy that applies
   * @param delayMs        - milliseconds until the SLA deadline
   */
  async scheduleSlaBreachCheck(
    tenantId: string,
    conversationId: string,
    slaPolicyId: string,
    delayMs: number,
  ): Promise<void> {
    const jobId = this.buildJobId(conversationId);

    try {
      // Remove any existing job for this conversation first
      await this.removeExistingJob(conversationId);

      await this.slaBreachQueue.add(
        'sla-breach-check',
        { tenantId, conversationId, slaPolicyId },
        { jobId, delay: delayMs },
      );

      this.logger.debug(
        `Scheduled SLA breach check for conversation ${conversationId} ` +
          `in ${(delayMs / (1000 * 60)).toFixed(1)} minutes ` +
          `(policy: ${slaPolicyId})`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to schedule SLA breach check for conversation ${conversationId}: ${err.message}`,
      );
    }
  }

  /**
   * Cancel the SLA breach-check job when an agent responds before the deadline.
   *
   * Called by SlaCancellationListener when an outbound message is sent
   * or when the conversation is resolved/closed.
   */
  async cancelSlaBreachCheck(conversationId: string): Promise<void> {
    try {
      await this.removeExistingJob(conversationId);
      this.logger.debug(
        `Cancelled SLA breach check for conversation ${conversationId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to cancel SLA breach check for ${conversationId}: ${err.message}`,
      );
    }
  }

  /**
   * Reschedule the SLA breach-check job with a new delay.
   *
   * Useful for `next_response` SLA type where each agent reply
   * resets the clock for the next customer message.
   */
  async rescheduleSlaBreachCheck(
    tenantId: string,
    conversationId: string,
    slaPolicyId: string,
    delayMs: number,
  ): Promise<void> {
    await this.scheduleSlaBreachCheck(
      tenantId,
      conversationId,
      slaPolicyId,
      delayMs,
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────

  private buildJobId(conversationId: string): string {
    return `sla-breach:${conversationId}`;
  }

  /**
   * Remove the existing SLA breach-check job for a conversation (if any).
   */
  private async removeExistingJob(conversationId: string): Promise<void> {
    const jobId = this.buildJobId(conversationId);
    try {
      const job = await this.slaBreachQueue.getJob(jobId);
      if (job) {
        await job.remove();
      }
    } catch {
      // Job may not exist — safe to ignore
    }
  }
}
