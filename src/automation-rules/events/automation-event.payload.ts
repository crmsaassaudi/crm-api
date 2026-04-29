/**
 * Automation Event Payload — the contract between CRM Core services
 * and the Automation Engine's Event Listener.
 *
 * Emitted by ContactsService, TicketsService (and future LeadsService)
 * after successful DB writes.
 */
export interface AutomationEventPayload {
  /** Tenant that owns the record */
  tenantId: string;

  /** The event type that occurred */
  event: 'record_created' | 'field_updated';

  /** The CRM object type */
  object: 'Lead' | 'Contact' | 'Ticket';

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
 */
export function buildAutomationEventName(
  event: 'record_created' | 'field_updated',
  object: 'Lead' | 'Contact' | 'Ticket',
): string {
  return `automation.${event}.${object}`;
}
