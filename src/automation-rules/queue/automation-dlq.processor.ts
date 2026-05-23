import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  BaseTenantConsumer,
  TenantJobData,
} from '../../queue/base-tenant.consumer';
import { AUTOMATION_ACTION_DLQ } from './automation-queue.constants';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';

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
}
