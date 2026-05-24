import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  BaseTenantConsumer,
  TenantJobData,
} from '../../queue/base-tenant.consumer';
import {
  AUTOMATION_DELAYED_QUEUE,
  AutomationDelayedJobData,
  AutomationDelayedQueueJobData,
} from './automation-queue.constants';
import { WorkflowOrchestratorService } from '../engine/workflow-orchestrator.service';
import { CrmRecordUpdateService } from '../engine/crm-record-update.service';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { AutomationWorkflowRepository } from '../infrastructure/persistence/document/repositories/automation-workflow.repository';
import { AutomationDelayedJobRepository } from '../infrastructure/persistence/document/repositories/automation-delayed-job.repository';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';

/**
 * Consumes hot resume jobs from Redis. The source of truth is MongoDB when
 * delayedJobId is present; payload-only jobs are supported for pre-migration
 * BullMQ delayed jobs that may still exist in Redis.
 */
@Processor(AUTOMATION_DELAYED_QUEUE)
export class AutomationDelayedProcessor extends BaseTenantConsumer<AutomationDelayedQueueJobData> {
  protected readonly logger = new Logger(AutomationDelayedProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    private readonly orchestrator: WorkflowOrchestratorService,
    private readonly crmUpdate: CrmRecordUpdateService,
    private readonly executionLogRepo: AutomationExecutionLogRepository,
    private readonly workflowRepo: AutomationWorkflowRepository,
    private readonly delayedJobRepo: AutomationDelayedJobRepository,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(
    job: Job<AutomationDelayedQueueJobData>,
  ): Promise<void> {
    const data = await this.resolveJobData(job.data);
    if (!data) return;

    try {
      // Audit trail: mark as automation flow execution
      this.cls.set('executionSource', 'A_F');
      this.cls.set('sourceContext', { flowId: data.workflowId });

      await this.resumeWorkflow(data);

      if (job.data.delayedJobId) {
        await this.delayedJobRepo.markCompleted(job.data.delayedJobId);
      }
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
  override onFailed(job: Job<AutomationDelayedQueueJobData>, error: Error) {
    super.onFailed(job, error);

    const attemptsRemaining = (job.opts?.attempts ?? 1) - job.attemptsMade;
    if (attemptsRemaining > 0 || !job.data.delayedJobId) return;

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

  private async resolveJobData(
    hotData: AutomationDelayedQueueJobData,
  ): Promise<AutomationDelayedJobData | null> {
    if (!hotData.delayedJobId) return hotData;

    const delayedJob = await this.delayedJobRepo.markProcessing(
      hotData.delayedJobId,
    );

    if (!delayedJob) {
      this.logger.warn(
        `[DelayedResume] Skipping hot job ${hotData.delayedJobId}; ` +
          'it is already terminal or not ready for processing',
      );
      return null;
    }

    return delayedJob.payload;
  }

  private async resumeWorkflow(data: AutomationDelayedJobData): Promise<void> {
    this.logger.log(
      `[DelayedResume] Resuming execution=${data.executionId} ` +
        `workflow=${data.workflowId} node=${data.resumeFromNodeId} ` +
        `record=${data.recordType}(${data.recordId})`,
    );

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
        nodeType: 'action',
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

      throw new Error(
        `RECORD_NOT_FOUND: ${data.recordType}(${data.recordId}) deleted during wait`,
      );
    }

    const workflow = await this.workflowRepo.findById(
      data.tenantId,
      data.workflowId,
    );

    if (!workflow) {
      this.logger.error(
        `[DelayedResume] Workflow ${data.workflowId} not found; cannot resume`,
      );
      await this.executionLogRepo.failExecution(data.executionId, {
        code: 'WORKFLOW_NOT_FOUND',
        message: `Workflow ${data.workflowId} was deleted during delay; cannot resume`,
      });
      throw new Error(`WORKFLOW_NOT_FOUND: ${data.workflowId}`);
    }

    const publishedNodes = (workflow as any).publishedNodes || [];
    const publishedEdges = (workflow as any).publishedEdges || [];

    if (publishedNodes.length === 0) {
      this.logger.warn(
        `[DelayedResume] Workflow ${data.workflowId} has no published nodes`,
      );
      await this.executionLogRepo.failExecution(data.executionId, {
        code: 'UNPUBLISHED_WORKFLOW',
        message: 'Workflow was unpublished during delay period',
      });
      throw new Error(`UNPUBLISHED_WORKFLOW: ${data.workflowId}`);
    }

    await this.orchestrator.resumeFromNode(
      data.resumeFromNodeId,
      publishedNodes,
      publishedEdges,
      {
        tenantId: data.tenantId,
        event: 'record_created',
        object: data.recordType,
        recordId: data.recordId,
        data: record,
        automationDepth: data.automationDepth,
        automationBreadcrumbs: data.automationBreadcrumbs,
        _automationSourceWorkflowId: data.sourceWorkflowId,
      },
      data.executionId,
      data.workflowId,
      data.tenantId,
      data.executionSessionId,
      data.automationDepth,
    );

    this.logger.log(
      `[DelayedResume] Resumed and completed execution=${data.executionId}`,
    );
  }
}
