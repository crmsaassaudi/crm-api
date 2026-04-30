import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { BaseConsumer } from '../../queue/base.consumer';
import { AUTOMATION_BULK_QUEUE } from './automation-queue.constants';
import { WorkflowOrchestratorService } from '../engine/workflow-orchestrator.service';

/**
 * AutomationBulkProcessor — consumes throttled automation events from the bulk queue.
 *
 * Processes events at a controlled concurrency to prevent Redis/CPU starvation
 * during high-volume operations like CSV imports.
 *
 * Concurrency is configured via BULK_QUEUE_CONCURRENCY env var (default: 5).
 */
@Processor(AUTOMATION_BULK_QUEUE, {
  concurrency: parseInt(process.env.BULK_QUEUE_CONCURRENCY || '5', 10),
})
export class AutomationBulkProcessor extends BaseConsumer {
  protected readonly logger = new Logger(AutomationBulkProcessor.name);

  constructor(private readonly orchestrator: WorkflowOrchestratorService) {
    super();
  }

  async process(job: Job): Promise<void> {
    const { workflow, payload } = job.data;

    this.logger.log(
      `[Bulk Processor] Processing throttled event: job=${job.id} workflow=${workflow._id || workflow.name} record=${payload.recordId}`,
    );

    await this.orchestrator.execute(workflow, payload);

    this.logger.log(
      `[Bulk Processor] ✅ Completed throttled event: job=${job.id}`,
    );
  }
}
