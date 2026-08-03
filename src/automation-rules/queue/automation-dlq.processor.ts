import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';
import {
  BaseTenantConsumer,
  TenantJobData,
} from '../../queue/base-tenant.consumer';
import { AUTOMATION_ACTION_DLQ } from './automation-queue.constants';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

/**
 * Dead-letters from one node within the window before it counts as poison.
 * Exported so the manual-retry endpoint refuses a quarantined node using the
 * same threshold that set the flag.
 */
export const POISON_THRESHOLD = 25;
/** Rolling window for the poison counter (1 hour). */
const POISON_WINDOW_SECONDS = 3600;

/**
 * AutomationDlqProcessor — consumes dead-lettered automation jobs.
 *
 * When a job exhausts its retry limit and lands in the DLQ, this processor:
 * 1. Logs the failure details
 * 2. Marks the corresponding step as 'dlq' in the execution log
 *
 * Admins can then use the manual retry endpoint to re-dispatch these jobs.
 */
@Processor(AUTOMATION_ACTION_DLQ)
export class AutomationDlqProcessor extends BaseTenantConsumer<TenantJobData> {
  protected readonly logger = new Logger(AutomationDlqProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    private readonly executionLogRepo: AutomationExecutionLogRepository,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<TenantJobData>): Promise<void> {
    const data = job.data as any;

    this.logger.warn(
      `[DLQ Processor] Dead-lettered job: action=${data.actionType} workflow=${data.workflowId} node=${data.nodeId} reason=${data.failedReason}`,
    );

    // Increment per-tenant DLQ counter for alerting.
    // Operators can poll `dlq:counter:{tenantId}` to detect high-failure tenants.
    const counterKey = `dlq:counter:${data.tenantId}`;
    await this.redis
      .multi()
      .incr(counterKey)
      .expire(counterKey, 86400) // 24h TTL — auto-reset daily
      .exec()
      .catch((err) =>
        this.logger.warn(
          `[DLQ Processor] Failed to increment DLQ counter: ${err.message}`,
        ),
      );

    await this.trackPoisonNode(data);

    // Mark the step as 'dlq' in the execution log
    try {
      await this.executionLogRepo.markStepDlq(data.executionId, data.nodeId);
      this.logger.log(
        `[DLQ Processor] Marked step ${data.nodeId} as 'dlq' in execution ${data.executionId}`,
      );
    } catch (error: any) {
      this.logger.error(
        `[DLQ Processor] Failed to mark step as dlq: ${error.message}`,
      );
    }
  }

  /**
   * Count dead-letters per workflow node and quarantine a node that keeps
   * failing.
   *
   * The per-tenant counter answers "is this tenant unhealthy"; it cannot answer
   * "which node is poison". A single broken node — a webhook pointing at a host
   * that always 500s, a template referencing a field that no longer exists —
   * dead-letters once per triggering record, so on a busy object it produces
   * thousands of identical DLQ entries and buries everything else.
   *
   * Quarantine is advisory: the key is what the alerting path and the retry
   * endpoint can read to say "this node is broken, stop re-firing it and go fix
   * the config". It intentionally does not disable the workflow — that is the
   * tenant's decision, not the queue's.
   */
  private async trackPoisonNode(data: any): Promise<void> {
    if (!data.workflowId || !data.nodeId) return;

    const key = `automation:poison:${data.tenantId}:${data.workflowId}:${data.nodeId}`;
    try {
      const failures = await this.redis.incr(key);
      if (failures === 1) {
        await this.redis.expire(key, POISON_WINDOW_SECONDS);
      }

      if (failures === POISON_THRESHOLD) {
        // Log at error level exactly once, on the crossing, so the alerting
        // path fires once per window instead of per dead-lettered record.
        this.logger.error(
          `[DLQ Processor] POISON NODE quarantined: workflow=${data.workflowId} ` +
            `node=${data.nodeId} action=${data.actionType} reached ` +
            `${POISON_THRESHOLD} dead-letters in ${POISON_WINDOW_SECONDS}s. ` +
            'The node config is almost certainly broken — fix it rather than retrying.',
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `[DLQ Processor] Failed to track poison node: ${err.message}`,
      );
    }
  }
}
