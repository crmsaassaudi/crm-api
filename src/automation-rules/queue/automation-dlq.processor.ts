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
import { AutomationMetricsService } from '../observability/automation-metrics.service';

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
    private readonly metrics: AutomationMetricsService,
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

    // Scrapeable series, so "which tenant and which action are dead-lettering"
    // is a dashboard question rather than a log-grep.
    this.metrics.recordDlq(data.actionType ?? 'unknown', data.tenantId);

    await this.trackPoisonNode(data);

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
   * Count dead-letters per workflow node and quarantine one that keeps failing.
   *
   * A single broken node — a webhook pointing at a host that always 500s, a
   * template naming a field that no longer exists — dead-letters once per
   * triggering record, so on a busy object it buries every other failure.
   *
   * Quarantine is advisory: the alerting path and the retry endpoint read the key
   * to say "fix the config instead of re-firing this". It does not disable the
   * workflow, which is the tenant's decision rather than the queue's.
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
