import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AutomationEventPayload } from './automation-event.payload';
import { AutomationWorkflowRepository } from '../infrastructure/persistence/document/repositories/automation-workflow.repository';
import { WorkflowOrchestratorService } from '../engine/workflow-orchestrator.service';

/**
 * AutomationEventListenerService — listens for CRM object events
 * and finds matching active workflows.
 *
 * This is the entry point of the Automation Engine. When ContactsService
 * or TicketsService emit an event, this listener:
 *   1. Queries active workflows matching the event + object type
 *   2. Filters out self-triggered workflows (loop prevention Layer 0)
 *   3. Delegates to WorkflowOrchestratorService (Task 1.6) for execution
 *
 * @see docs/prd-visual-automation-builder.md — Task 1.2
 */
@Injectable()
export class AutomationEventListenerService {
  private readonly logger = new Logger(AutomationEventListenerService.name);

  constructor(
    private readonly workflowRepo: AutomationWorkflowRepository,
    private readonly orchestrator: WorkflowOrchestratorService,
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
      // Find all active workflows that match this event + object
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
        // field matches the configured trigger field
        if (
          event === 'field_updated' &&
          wf.triggerConfig.field &&
          payload.changedFields
        ) {
          return payload.changedFields.includes(wf.triggerConfig.field);
        }

        return true;
      });

      this.logger.log(
        `Found ${eligibleWorkflows.length} eligible workflow(s) for ${event}.${object} (record=${recordId})`,
      );

      // Delegate to WorkflowOrchestratorService for each eligible workflow
      for (const wf of eligibleWorkflows) {
        this.logger.log(
          `  → Triggering workflow "${wf.name}" (${wf._id}) [depth=${depth}]`,
        );
        // Execute each workflow independently — one failure doesn't block others
        try {
          await this.orchestrator.execute(wf, payload);
        } catch (wfError: any) {
          this.logger.error(
            `Workflow "${wf.name}" (${wf._id}) execution failed: ${wfError.message}`,
          );
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
