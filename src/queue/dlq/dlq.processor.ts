import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CRM_DLQ_QUEUE } from './dlq.constants';
import { DlqJobData } from './dlq.service';

/**
 * DLQ Processor — logs and persists permanently failed jobs.
 *
 * In production, this processor can be extended to:
 *   - Send Slack/PagerDuty alerts
 *   - Write to a MongoDB collection for admin dashboard visibility
 *   - Trigger auto-retry workflows for transient failures
 */
@Processor(CRM_DLQ_QUEUE)
export class DlqProcessor extends WorkerHost {
  private readonly logger = new Logger(DlqProcessor.name);

  async process(job: Job<DlqJobData>): Promise<void> {
    const { sourceQueue, jobId, jobName, error, attemptsMade, failedAt } =
      job.data;

    this.logger.error(
      `[DLQ] Permanently failed job recorded:\n` +
        `  Source Queue : ${sourceQueue}\n` +
        `  Job ID       : ${jobId}\n` +
        `  Job Name     : ${jobName}\n` +
        `  Attempts     : ${attemptsMade}\n` +
        `  Failed At    : ${failedAt}\n` +
        `  Error        : ${error}`,
    );

    // Future: persist to MongoDB audit collection, send alert, etc.
    return Promise.resolve();
  }
}
