import { Injectable, Logger } from '@nestjs/common';
import { AutomationEventPayload } from '../events/automation-event.payload';
import { AutomationWorkflowRepository } from '../infrastructure/persistence/document/repositories/automation-workflow.repository';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { WorkflowOrchestratorService } from './workflow-orchestrator.service';
import { BulkEventThrottleService } from './bulk-event-throttle.service';
import { AutomationQuotaService } from './automation-quota.service';
import { AutomationBulkProducer } from '../queue/automation-bulk.producer';

/**
 * TriggerEvaluatorService — matches one CRM event to workflows and runs them.
 *
 * Runs in a queue worker (`AutomationTriggerProcessor`); the event listener only
 * persists to the outbox. It used to run inline and un-awaited on whichever
 * process emitted the event — normally the API handling a user's request.
 */
@Injectable()
export class TriggerEvaluatorService {
  private readonly logger = new Logger(TriggerEvaluatorService.name);

  constructor(
    private readonly workflowRepo: AutomationWorkflowRepository,
    private readonly orchestrator: WorkflowOrchestratorService,
    private readonly throttle: BulkEventThrottleService,
    private readonly bulkProducer: AutomationBulkProducer,
    private readonly executionLogRepo: AutomationExecutionLogRepository,
    private readonly quota: AutomationQuotaService,
  ) {}

  async evaluate(payload: AutomationEventPayload): Promise<void> {
    const { tenantId, event, object, recordId } = payload;
    const depth = payload.automationDepth ?? 0;

    // Find all active workflows that match this event + object (using PUBLISHED config)
    const workflows = await this.workflowRepo.findActiveByTrigger(
      tenantId,
      event,
      object,
    );

    if (workflows.length === 0) {
      this.logger.debug(
        `No active workflows match ${event}.${object} for tenant ${tenantId}`,
      );
      return;
    }

    const eligibleWorkflows = workflows.filter((wf) =>
      this.isEligible(wf, payload),
    );

    if (eligibleWorkflows.length === 0) return;

    this.logger.log(
      `Found ${eligibleWorkflows.length} eligible workflow(s) for ${event}.${object} (record=${recordId})`,
    );

    const { throttled } = await this.throttle.shouldThrottle(tenantId);

    for (const wf of eligibleWorkflows) {
      // Charge the tenant's daily execution allowance before anything runs, so a
      // runaway workflow is stopped at the cheapest possible point rather than
      // after it has already dispatched its actions.
      const quotaDecision = await this.quota.consumeExecution(tenantId);
      if (!quotaDecision.allowed) {
        this.logger.warn(
          `Workflow "${wf.name}" (${wf._id}) not started: ${quotaDecision.reason}`,
        );
        await this.recordTerminalLog(wf, payload, {
          code: quotaDecision.kind?.toUpperCase() ?? 'QUOTA_EXCEEDED',
          message: quotaDecision.reason!,
        });
        continue;
      }

      this.logger.log(
        `  → Triggering workflow "${wf.name}" (${wf._id}) [depth=${depth}]` +
          `${throttled ? ' [THROTTLED → bulk queue]' : ''}`,
      );

      try {
        if (throttled) {
          // Over threshold: route to low-priority bulk queue. Only the id
          // travels — the processor re-reads the published snapshot.
          await this.bulkProducer.dispatch({
            workflowId: wf._id.toString(),
            payload,
          });
        } else {
          await this.orchestrator.execute(wf, payload);
        }
      } catch (wfError: any) {
        this.logger.error(
          `Workflow "${wf.name}" (${wf._id}) execution failed: ${wfError.message}`,
        );
        await this.recordTerminalLog(wf, payload, {
          code: 'TRIGGER_EVALUATION_ERROR',
          message: wfError.message,
        });
      }
    }
  }

  /**
   * Layer 0 loop prevention plus the `field_updated` field filter.
   */
  private isEligible(wf: any, payload: AutomationEventPayload): boolean {
    if (
      payload._automationSourceWorkflowId &&
      wf._id.toString() === payload._automationSourceWorkflowId
    ) {
      this.logger.debug(
        `Skipping workflow "${wf.name}" (${wf._id}) — self-trigger from automation`,
      );
      return false;
    }

    // For field_updated triggers with a specific field, only fire when that
    // field actually changed (using PUBLISHED config).
    if (
      payload.event === 'field_updated' &&
      wf.publishedTriggerConfig?.field &&
      payload.changedFields
    ) {
      return payload.changedFields.includes(wf.publishedTriggerConfig.field);
    }

    return true;
  }

  /**
   * Record a failure that happened before or instead of an execution.
   *
   * Without this the workflow simply would not have run, with nothing in the
   * dashboard saying why — the shape of defect where the product is confidently
   * silent.
   */
  private async recordTerminalLog(
    wf: any,
    payload: AutomationEventPayload,
    error: { code: string; message: string },
  ): Promise<void> {
    try {
      const execLog = await this.executionLogRepo.startExecution({
        tenantId: payload.tenantId,
        workflowId: wf._id.toString(),
        workflowName: wf.name,
        recordId: payload.recordId,
        recordType: payload.object,
        automationDepth: payload.automationDepth ?? 0,
        workflowVersion: wf.version ?? null,
      });
      await this.executionLogRepo.failExecution(execLog._id.toString(), error);
    } catch (logErr: any) {
      this.logger.error(
        `[TriggerEvaluator] Failed to log evaluation error: ${logErr.message}`,
      );
    }
  }
}
