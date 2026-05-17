/**
 * All CRM modules supported by the Automation Engine.
 */
export type AutomationCrmModule =
  | 'Lead'
  | 'Contact'
  | 'Ticket'
  | 'Deal'
  | 'Account'
  | 'Task';

/**
 * Automation Event Payload — the contract between CRM Core services
 * and the Automation Engine's Event Listener.
 *
 * Emitted by ContactsService, TicketsService, DealsService, AccountsService,
 * TasksService, and LeadsService after successful DB writes.
 */
export interface AutomationEventPayload {
  /** Tenant that owns the record */
  tenantId: string;

  /** The event type that occurred */
  event: 'record_created' | 'field_updated';

  /** The CRM object type */
  object: AutomationCrmModule;

  /** The record's MongoDB _id */
  recordId: string;

  /** Full record data after the operation */
  data: Record<string, any>;

  /** Fields that changed (only for field_updated events) */
  changedFields?: string[];

  /**
   * Automation depth — tracks cross-automation chain depth.
   * Layer 2 of loop prevention: if this exceeds MAX_DEPTH, the
   * listener will refuse to evaluate further workflows.
   * Starts at 0 for user-initiated events.
   */
  automationDepth?: number;

  /**
   * Workflow IDs already visited in this automation chain.
   * Used to block A -> B -> A loops across workers/processes.
   */
  automationBreadcrumbs?: string[];

  /**
   * When true, this update was triggered by the Automation Engine itself.
   * The listener uses this to avoid re-triggering the *same* workflow
   * that caused the update (self-loop prevention).
   */
  _automationSourceWorkflowId?: string;
}

/**
 * Event name convention: automation.{event}.{object}
 * Examples:
 *   - automation.record_created.Contact
 *   - automation.field_updated.Ticket
 *   - automation.record_created.Deal
 */
export function buildAutomationEventName(
  event: 'record_created' | 'field_updated',
  object: AutomationCrmModule,
): string {
  return `automation.${event}.${object}`;
}
