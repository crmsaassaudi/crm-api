import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import {
  AUTOMATION_BULK_QUEUE,
  AutomationBulkJobData,
} from './automation-queue.constants';
import { WorkflowOrchestratorService } from '../engine/workflow-orchestrator.service';
import { AutomationWorkflowRepository } from '../infrastructure/persistence/document/repositories/automation-workflow.repository';

/**
 * AutomationBulkProcessor - consumes throttled automation events from the bulk queue.
 *
 * Processes events at a controlled concurrency to prevent Redis/CPU starvation
 * during high-volume operations like CSV imports.
 *
 * Concurrency is configured via BULK_QUEUE_CONCURRENCY env var (default: 5).
 */
@Processor(AUTOMATION_BULK_QUEUE, {
  concurrency: parseInt(process.env.BULK_QUEUE_CONCURRENCY ?? '5', 10),
})
export class AutomationBulkProcessor extends BaseTenantConsumer<AutomationBulkJobData> {
  protected readonly logger = new Logger(AutomationBulkProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    private readonly orchestrator: WorkflowOrchestratorService,
    private readonly workflowRepo: AutomationWorkflowRepository,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<AutomationBulkJobData>): Promise<void> {
    const { tenantId, workflowId, payload } = job.data;

    // Re-read the workflow instead of executing a definition carried in the
    // queue payload. A bulk job can sit in Redis while the workflow is edited,
    // unpublished or paused, and the tenant-scoped read also means a payload
    // cannot point the orchestrator at another tenant's workflow.
    const workflow = await this.workflowRepo.findById(tenantId, workflowId);
    if (!workflow) {
      this.logger.warn(
        `[Bulk Processor] Workflow ${workflowId} no longer exists for tenant ${tenantId}; dropping job ${job.id}`,
      );
      return;
    }
    if (workflow.status !== 'active') {
      this.logger.log(
        `[Bulk Processor] Workflow ${workflowId} is "${workflow.status}"; dropping job ${job.id}`,
      );
      return;
    }

    this.logger.log(
      `[Bulk Processor] Processing throttled event: job=${job.id} workflow=${workflowId} record=${payload.recordId}`,
    );

    await this.orchestrator.execute(workflow, payload as any);

    this.logger.log(
      `[Bulk Processor] Completed throttled event: job=${job.id}`,
    );
  }
}
