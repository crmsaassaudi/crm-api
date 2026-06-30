import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AutomationEventPayload } from './automation-event.payload';
import { AutomationWorkflowRepository } from '../infrastructure/persistence/document/repositories/automation-workflow.repository';
import { WorkflowOrchestratorService } from '../engine/workflow-orchestrator.service';
import { BulkEventThrottleService } from '../engine/bulk-event-throttle.service';
import { AutomationBulkProducer } from '../queue/automation-bulk.producer';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';

/**
 * AutomationEventListenerService — listens for CRM object events
 * and finds matching active workflows.
 *
 * This is the entry point of the Automation Engine. When ContactsService
 * or TicketsService emit an event, this listener:
 *   1. Queries active workflows matching the PUBLISHED event + object type
 *   2. Filters out self-triggered workflows (loop prevention Layer 0)
 *   3. Checks bulk event throttling (Phase 3)
 *   4. Delegates to WorkflowOrchestratorService for normal execution,
 *      or routes to bulk queue when rate limit exceeded
 */
@Injectable()
export class AutomationEventListenerService {
  private readonly logger = new Logger(AutomationEventListenerService.name);

  constructor(
    private readonly workflowRepo: AutomationWorkflowRepository,
    private readonly orchestrator: WorkflowOrchestratorService,
    private readonly throttle: BulkEventThrottleService,
    private readonly bulkProducer: AutomationBulkProducer,
    private readonly executionLogRepo: AutomationExecutionLogRepository,
  ) {}

  // ── Wildcard listener for all automation events ───────────────────────

  @OnEvent('automation.**')
  async handleAutomationEvent(payload: AutomationEventPayload): Promise<void> {
    const { tenantId, event, object, recordId } = payload;
    const depth = payload.automationDepth ?? 0;

    this.logger.log(
      `[Event] ${event}.${object} | tenant=${tenantId} record=${recordId} depth=${depth}`,
    );

    try {
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

      // Filter out self-triggered workflows (Layer 0: same-workflow prevention)
      const eligibleWorkflows = workflows.filter((wf) => {
        if (
          payload._automationSourceWorkflowId &&
          wf._id.toString() === payload._automationSourceWorkflowId
        ) {
          this.logger.debug(
            `Skipping workflow "${wf.name}" (${wf._id}) — self-trigger from automation`,
          );
          return false;
        }

        // For field_updated triggers with specific field, check if the changed
        // field matches the configured trigger field (using PUBLISHED config)
        if (
          event === 'field_updated' &&
          (wf as any).publishedTriggerConfig?.field &&
          payload.changedFields
        ) {
          return payload.changedFields.includes(
            (wf as any).publishedTriggerConfig.field,
          );
        }

        return true;
      });

      this.logger.log(
        `Found ${eligibleWorkflows.length} eligible workflow(s) for ${event}.${object} (record=${recordId})`,
      );

      // ── Bulk Event Throttling (Phase 3) ──────────────────────────────
      const { throttled } = await this.throttle.shouldThrottle(tenantId);

      // Delegate to WorkflowOrchestratorService for each eligible workflow
      for (const wf of eligibleWorkflows) {
        this.logger.log(
          `  → Triggering workflow "${wf.name}" (${wf._id}) [depth=${depth}] ${throttled ? '[THROTTLED → bulk queue]' : ''}`,
        );

        try {
          if (throttled) {
            // Over threshold: route to low-priority bulk queue
            await this.bulkProducer.dispatch({
              workflow: wf,
              payload,
            });
          } else {
            // Normal path: execute directly via orchestrator
            await this.orchestrator.execute(wf, payload);
          }
        } catch (wfError: any) {
          this.logger.error(
            `Workflow "${wf.name}" (${wf._id}) execution failed: ${wfError.message}`,
          );

          // Track the failure in execution log so admins can see it in the dashboard.
          // The orchestrator may have already created its own log entry, but if it
          // threw before that (e.g. EXECUTION_TIMEOUT), this is the only record.
          try {
            const execLog = await this.executionLogRepo.startExecution({
              tenantId,
              workflowId: wf._id.toString(),
              workflowName: wf.name,
              recordId,
              recordType: object,
              automationDepth: depth,
            });
            await this.executionLogRepo.failExecution(execLog._id.toString(), {
              code: 'LISTENER_ERROR',
              message: wfError.message,
            });
          } catch (logErr: any) {
            this.logger.error(
              `[Event] Failed to log listener error: ${logErr.message}`,
            );
          }
        }
      }
    } catch (error: any) {
      this.logger.error(
        `Error handling automation event ${event}.${object} for record ${recordId}: ${error.message}`,
        error.stack,
      );
    }
  }
}
