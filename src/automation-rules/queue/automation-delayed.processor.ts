import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import {
  AUTOMATION_DELAYED_QUEUE,
  AutomationDelayedJobData,
  AutomationDelayedQueueJobData,
} from './automation-queue.constants';
import {
  WorkflowOrchestratorService,
  ResumeContext,
} from '../engine/workflow-orchestrator.service';
import { CrmRecordUpdateService } from '../engine/crm-record-update.service';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { AutomationDelayedJobRepository } from '../infrastructure/persistence/document/repositories/automation-delayed-job.repository';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { ExecutionContextService } from '../engine/execution-context.service';

/**
 * Resumes a workflow whose wait node has expired.
 *
 * MongoDB is the source of truth: Redis only holds near-due jobs, and the
 * payload is re-read from `automation_delayed_jobs` before anything runs.
 */
@Processor(AUTOMATION_DELAYED_QUEUE, {
  concurrency: parseInt(process.env.AUTOMATION_DELAYED_CONCURRENCY ?? '10', 10),
})
export class AutomationDelayedProcessor extends BaseTenantConsumer<AutomationDelayedQueueJobData> {
  protected readonly logger = new Logger(AutomationDelayedProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    private readonly orchestrator: WorkflowOrchestratorService,
    private readonly crmUpdate: CrmRecordUpdateService,
    private readonly executionLogRepo: AutomationExecutionLogRepository,
    private readonly delayedJobRepo: AutomationDelayedJobRepository,
    private readonly executionContext: ExecutionContextService,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(
    job: Job<AutomationDelayedQueueJobData>,
  ): Promise<void> {
    const delayedJob = await this.delayedJobRepo.markProcessing(
      job.data.delayedJobId,
    );
    if (!delayedJob) {
      this.logger.warn(
        `[DelayedResume] Skipping hot job ${job.data.delayedJobId}; ` +
          'it is already terminal or not ready for processing',
      );
      return;
    }

    const data = delayedJob.payload;

    try {
      // Resume under the principal pinned when the execution started — not
      // whatever the workflow declares now, and not unscoped.
      await this.executionContext.runAs(data.principal, data.workflowId, () =>
        this.resumeWorkflow(data),
      );
      await this.delayedJobRepo.markCompleted(job.data.delayedJobId);
    } catch (error: any) {
      this.logger.error(
        `[DelayedResume] Failed execution=${data.executionId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * onFailed override: uses runWithTenantContext because this runs
   * OUTSIDE the process() CLS context (BullMQ event callback).
   */
  @OnWorkerEvent('failed')
  override async onFailed(
    job: Job<AutomationDelayedQueueJobData>,
    error: Error,
  ) {
    await super.onFailed(job, error);

    const attemptsRemaining = (job.opts?.attempts ?? 1) - job.attemptsMade;
    if (attemptsRemaining > 0) return;

    const delayedJobId = job.data.delayedJobId;
    runWithTenantContext(this.cls, job.data.tenantId, () => {
      this.delayedJobRepo
        .markFailed(delayedJobId, error.message)
        .catch((repoError) =>
          this.logger.error(
            `[DelayedResume] Failed to mark delayed job as failed: ${repoError.message}`,
            repoError.stack,
          ),
        );
    });
  }

  private async resumeWorkflow(data: AutomationDelayedJobData): Promise<void> {
    this.logger.log(
      `[DelayedResume] Resuming execution=${data.executionId} ` +
        `workflow=${data.workflowId} node=${data.resumeFromNodeId} ` +
        `record=${data.recordType}(${data.recordId})`,
    );

    // Re-read rather than carry the record: the whole point of a wait is that the
    // world may have changed, and a workflow must not act on a stale snapshot of
    // a person who has since unsubscribed or been deleted.
    const record = await this.crmUpdate.fetchRecord(
      data.recordType,
      data.recordId,
    );

    if (!record) {
      this.logger.warn(
        `[DelayedResume] Record ${data.recordType}(${data.recordId}) not found; ` +
          'it may have been deleted during the wait period',
      );

      const stepStart = new Date();
      await this.executionLogRepo.logStep(data.executionId, {
        nodeId: data.resumeFromNodeId,
        nodeName: 'Resume (after wait)',
        nodeType: 'wait',
        status: 'failed',
        input: { resumeFromNodeId: data.resumeFromNodeId },
        error: {
          code: 'RECORD_NOT_FOUND',
          message: `Record ${data.recordType}(${data.recordId}) was deleted during wait period`,
        },
        startedAt: stepStart,
        completedAt: new Date(),
        duration: 0,
      });

      await this.executionLogRepo.failExecution(data.executionId, {
        code: 'RECORD_NOT_FOUND',
        message: 'Record deleted during delay; cannot resume workflow',
        nodeId: data.resumeFromNodeId,
      });

      // Deleted record is a terminal outcome, not a fault: retrying cannot make
      // the record exist. Return so the delayed job is marked completed instead
      // of retried three times and then dead-lettered.
      return;
    }

    const resumeCtx: ResumeContext = {
      publishedNodes: data.publishedNodes,
      publishedEdges: data.publishedEdges,
      workflowVersion: data.workflowVersion,
      principal: data.principal,
      payload: {
        tenantId: data.tenantId,
        event: 'record_created',
        object: data.recordType,
        recordId: data.recordId,
        data: record,
        automationDepth: data.automationDepth,
        automationBreadcrumbs: data.automationBreadcrumbs,
        _automationSourceWorkflowId: data.sourceWorkflowId,
      },
      executionId: data.executionId,
      workflowId: data.workflowId,
      tenantId: data.tenantId,
      executionSessionId: data.executionSessionId,
      depth: data.automationDepth,
    };
    await this.orchestrator.resumeFromNode(data.resumeFromNodeId, resumeCtx);
  }
}
