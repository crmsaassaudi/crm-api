import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { BaseConsumer } from '../../queue/base.consumer';
import {
  AUTOMATION_DELAYED_QUEUE,
  AutomationDelayedJobData,
} from './automation-queue.constants';
import { WorkflowOrchestratorService } from '../engine/workflow-orchestrator.service';
import { CrmRecordUpdateService } from '../engine/crm-record-update.service';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { AutomationWorkflowRepository } from '../infrastructure/persistence/document/repositories/automation-workflow.repository';

/**
 * AutomationDelayedProcessor — resumes workflow execution after a Wait/Delay node.
 *
 * When the delay timer expires, this processor:
 *   1. Re-fetches the record from DB (decision #2: always use latest data)
 *   2. Loads the published workflow snapshot (published nodes/edges)
 *   3. Calls orchestrator.resumeFromNode() to continue DAG traversal
 *
 * Handles edge cases:
 *   - Record deleted during wait → RECORD_NOT_FOUND → DLQ
 *   - Workflow deactivated during wait → log warning, still execute (honor commitment)
 */
@Processor(AUTOMATION_DELAYED_QUEUE)
export class AutomationDelayedProcessor extends BaseConsumer {
  protected readonly logger = new Logger(AutomationDelayedProcessor.name);

  constructor(
    private readonly orchestrator: WorkflowOrchestratorService,
    private readonly crmUpdate: CrmRecordUpdateService,
    private readonly executionLogRepo: AutomationExecutionLogRepository,
    private readonly workflowRepo: AutomationWorkflowRepository,
  ) {
    super();
  }

  async process(job: Job<AutomationDelayedJobData>): Promise<void> {
    const data = job.data;

    this.logger.log(
      `[DelayedResume] Resuming execution=${data.executionId} ` +
        `workflow=${data.workflowId} node=${data.resumeFromNodeId} ` +
        `record=${data.recordType}(${data.recordId})`,
    );

    // ── Step 1: Re-fetch record data (latest from DB) ──────────────────
    const record = await this.crmUpdate.fetchRecord(
      data.recordType,
      data.recordId,
    );

    if (!record) {
      this.logger.warn(
        `[DelayedResume] Record ${data.recordType}(${data.recordId}) not found — ` +
          `may have been deleted during wait period`,
      );

      // Mark the step as failed and the execution as failed
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
        message: `Record deleted during delay — cannot resume workflow`,
        nodeId: data.resumeFromNodeId,
      });

      throw new Error(
        `RECORD_NOT_FOUND: ${data.recordType}(${data.recordId}) deleted during wait`,
      );
    }

    // ── Step 2: Load published workflow snapshot ────────────────────────
    const workflow = await this.workflowRepo.findById(
      data.tenantId,
      data.workflowId,
    );

    if (!workflow) {
      this.logger.error(
        `[DelayedResume] Workflow ${data.workflowId} not found — cannot resume`,
      );
      await this.executionLogRepo.failExecution(data.executionId, {
        code: 'WORKFLOW_NOT_FOUND',
        message: `Workflow ${data.workflowId} was deleted during delay — cannot resume`,
      });
      throw new Error(`WORKFLOW_NOT_FOUND: ${data.workflowId}`);
    }

    const publishedNodes = (workflow as any).publishedNodes || [];
    const publishedEdges = (workflow as any).publishedEdges || [];

    if (publishedNodes.length === 0) {
      this.logger.warn(
        `[DelayedResume] Workflow ${data.workflowId} has no published nodes — was it unpublished during wait?`,
      );
      await this.executionLogRepo.failExecution(data.executionId, {
        code: 'UNPUBLISHED_WORKFLOW',
        message: 'Workflow was unpublished during delay period',
      });
      throw new Error(`UNPUBLISHED_WORKFLOW: ${data.workflowId}`);
    }

    // ── Step 3: Resume DAG traversal ────────────────────────────────────
    await this.orchestrator.resumeFromNode(
      data.resumeFromNodeId,
      publishedNodes,
      publishedEdges,
      {
        tenantId: data.tenantId,
        event: 'record_created', // Synthetic — not used during resume
        object: data.recordType,
        recordId: data.recordId,
        data: record,
        automationDepth: data.automationDepth,
        _automationSourceWorkflowId: data.sourceWorkflowId,
      },
      data.executionId,
      data.workflowId,
      data.tenantId,
      data.executionSessionId,
      data.automationDepth,
    );

    this.logger.log(
      `[DelayedResume] ✅ Resumed and completed execution=${data.executionId}`,
    );
  }
}
