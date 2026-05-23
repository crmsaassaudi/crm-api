import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SLA_BREACH_QUEUE } from './queue/sla-queue.constants';
import type {
  SlaBreachJobData,
  SlaBreachType,
} from './queue/sla-breach.processor';

/**
 * SlaMonitorService — manages per-conversation SLA breach-check delayed jobs.
 *
 * Supports two independent SLA types that run in parallel:
 *   - FRT (First Response Time): cancelled when agent sends first reply
 *   - Resolution: cancelled when conversation is resolved/closed
 *
 * Each gets its own BullMQ delayed job with a unique job ID:
 *   - `sla-breach:frt:{conversationId}`
 *   - `sla-breach:resolution:{conversationId}`
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
   * @param tenantId       - tenant owning the conversation
   * @param conversationId - the conversation to monitor
   * @param slaPolicyId    - the SLA policy that applies
   * @param delayMs        - milliseconds until the SLA deadline
   * @param breachType     - 'frt' or 'resolution'
   */
  async scheduleSlaBreachCheck(
    tenantId: string,
    conversationId: string,
    slaPolicyId: string,
    delayMs: number,
    breachType: SlaBreachType,
  ): Promise<void> {
    const jobId = this.buildJobId(conversationId, breachType);

    try {
      // Remove any existing job of same type for this conversation
      await this.removeExistingJob(conversationId, breachType);

      await this.slaBreachQueue.add(
        'sla-breach-check',
        {
          tenantId,
          conversationId,
          slaPolicyId,
          breachType,
          timeoutMs: 30_000,
        },
        {
          jobId,
          delay: delayMs,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
        },
      );

      this.logger.debug(
        `Scheduled SLA [${breachType}] breach check for conversation ${conversationId} ` +
          `in ${(delayMs / (1000 * 60)).toFixed(1)} minutes`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to schedule SLA [${breachType}] for conversation ${conversationId}: ${err.message}`,
      );
    }
  }

  /**
   * Cancel the FRT breach-check job when an agent responds.
   */
  async cancelFrtBreachCheck(conversationId: string): Promise<void> {
    await this.cancelBreachCheck(conversationId, 'frt');
  }

  /**
   * Cancel the Resolution breach-check job when conversation is resolved.
   */
  async cancelResolutionBreachCheck(conversationId: string): Promise<void> {
    await this.cancelBreachCheck(conversationId, 'resolution');
  }

  /**
   * Cancel ALL SLA breach-check jobs for a conversation (both FRT and Resolution).
   */
  async cancelAllBreachChecks(conversationId: string): Promise<void> {
    await Promise.all([
      this.cancelBreachCheck(conversationId, 'frt'),
      this.cancelBreachCheck(conversationId, 'resolution'),
    ]);
  }

  // ────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────

  private async cancelBreachCheck(
    conversationId: string,
    breachType: SlaBreachType,
  ): Promise<void> {
    try {
      await this.removeExistingJob(conversationId, breachType);
      this.logger.debug(
        `Cancelled SLA [${breachType}] breach check for conversation ${conversationId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to cancel SLA [${breachType}] for ${conversationId}: ${err.message}`,
      );
    }
  }

  private buildJobId(
    conversationId: string,
    breachType: SlaBreachType,
  ): string {
    return `sla-breach-${breachType}-${conversationId}`;
  }

  private async removeExistingJob(
    conversationId: string,
    breachType: SlaBreachType,
  ): Promise<void> {
    const jobId = this.buildJobId(conversationId, breachType);
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
