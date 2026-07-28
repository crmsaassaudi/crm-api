import { Injectable, Logger } from '@nestjs/common';
import { AutomationEventPayload } from '../events/automation-event.payload';
import { AutomationWorkflowRepository } from '../infrastructure/persistence/document/repositories/automation-workflow.repository';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { WorkflowOrchestratorService } from './workflow-orchestrator.service';
import { BulkEventThrottleService } from './bulk-event-throttle.service';
import { AutomationBulkProducer } from '../queue/automation-bulk.producer';

/**
 * TriggerEvaluatorService — matches one CRM event to workflows and runs them.
 *
 * This logic used to live in `AutomationEventListenerService`, which meant it ran
 * inline and un-awaited on whichever process emitted the event — normally the API
 * handling a user's request. It now runs in a queue worker
 * (`AutomationTriggerProcessor`); the listener only enqueues.
 *
 * Separating it also makes the matching rules testable without an event bus.
 *
 * @see docs/audit/WORKFLOW_AUTOMATION_SECURITY_AUDIT.md — finding M5
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

    this.logger.log(
      `Found ${eligibleWorkflows.length} eligible workflow(s) for ${event}.${object} (record=${recordId})`,
    );

    // ── Bulk Event Throttling (Phase 3) ──────────────────────────────
    const { throttled } = await this.throttle.shouldThrottle(tenantId);

    for (const wf of eligibleWorkflows) {
      this.logger.log(
        `  → Triggering workflow "${wf.name}" (${wf._id}) [depth=${depth}] ${throttled ? '[THROTTLED → bulk queue]' : ''}`,
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
        await this.recordFailure(wf, payload, wfError);
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
   * Track the failure in the execution log so admins see it in the dashboard.
   * The orchestrator may have already created its own entry, but if it threw
   * before that (e.g. EXECUTION_TIMEOUT) this is the only record.
   */
  private async recordFailure(
    wf: any,
    payload: AutomationEventPayload,
    error: Error,
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
      await this.executionLogRepo.failExecution(execLog._id.toString(), {
        code: 'TRIGGER_EVALUATION_ERROR',
        message: error.message,
      });
    } catch (logErr: any) {
      this.logger.error(
        `[TriggerEvaluator] Failed to log evaluation error: ${logErr.message}`,
      );
    }
  }
}
