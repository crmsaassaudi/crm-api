import { AutomationCrmModule } from '../events/automation-event.payload';

/**
 * Queue constants for the Automation Engine.
 *
 * Phase 4 Queue Architecture (5 queues):
 *   - automation-actions-email:     Email-specific, rate-limited for SendGrid
 *   - automation-actions-sms:       SMS-specific, rate-limited for Twilio (1/s)
 *   - automation-actions-internal:  UpdateField + RouteToTeam (fast, no external API)
 *   - automation-actions-webhook:   Webhook calls, rate-limited
 *   - automation-actions-dlq:       Dead Letter Queue (manual retry)
 *   - automation-actions-bulk:      Throttled events (low priority)
 *   - automation-delayed-resume:    Wait/Delay node hibernation
 */

// ── Per-Type Action Queues (separated for independent rate limiting) ─────
export const AUTOMATION_EMAIL_QUEUE = 'automation-actions-email';
export const AUTOMATION_SMS_QUEUE = 'automation-actions-sms';
export const AUTOMATION_INTERNAL_QUEUE = 'automation-actions-internal';
export const AUTOMATION_WEBHOOK_QUEUE = 'automation-actions-webhook';

// ── Legacy main queue (kept for backward compat, re-routes to typed queues) ─
export const AUTOMATION_ACTION_QUEUE = 'automation-actions';

// ── System Queues ─────────────────────────────────────────────────────────
export const AUTOMATION_ACTION_DLQ = 'automation-actions-dlq';
export const AUTOMATION_BULK_QUEUE = 'automation-actions-bulk';
export const AUTOMATION_DELAYED_QUEUE = 'automation-delayed-resume';

/**
 * Job names used within the automation action queues.
 */
export enum AutomationJobName {
  SEND_EMAIL = 'automation.send-email',
  SEND_SMS = 'automation.send-sms',
  UPDATE_FIELD = 'automation.update-field',
  ROUTE_TO_TEAM = 'automation.route-to-team',
  WEBHOOK = 'automation.webhook',
  DELAYED_RESUME = 'automation.delayed-resume',
}

/**
 * Payload dispatched to the automation action queues.
 */
export interface AutomationActionJobData {
  /** The execution log ID for this workflow run */
  executionId: string;

  /** The workflow that dispatched this action */
  workflowId: string;

  /** Tenant context */
  tenantId: string;

  /** The node that defines this action */
  nodeId: string;
  nodeName: string;

  /** The action type — maps to a specific executor */
  actionType:
    | 'send_email'
    | 'send_sms'
    | 'update_field'
    | 'route_to_team'
    | 'webhook';

  /** Action-specific config set by the admin in the Visual Builder */
  actionConfig: Record<string, any>;

  /** The record that triggered the workflow */
  recordId: string;
  recordType: 'Lead' | 'Contact' | 'Ticket' | 'Deal' | 'Account' | 'Task';
  recordData: Record<string, any>;

  /** Automation depth for loop prevention Layer 2 */
  automationDepth: number;

  /** Source workflow ID for self-loop prevention */
  sourceWorkflowId: string;
}

/**
 * Payload for the delayed resume queue.
 * Contains minimal data — record is re-fetched from DB on resume (decision #2).
 */
export interface AutomationDelayedJobData {
  /** Execution log ID — this execution is still "running" / "waiting" */
  executionId: string;

  /** Workflow ID (to load published nodes/edges) */
  workflowId: string;

  /** Tenant context */
  tenantId: string;

  /** The node ID to resume FROM (downstream of the wait node) */
  resumeFromNodeId: string;

  /**
   * Record identifiers for re-fetch.
   * We do NOT store record data — per decision #2, we re-query the DB
   * for the latest data to handle DNC flags, deleted records, etc.
   */
  recordId: string;
  recordType: AutomationCrmModule;

  /** Automation depth for loop prevention Layer 2 */
  automationDepth: number;

  /** Source workflow ID for self-loop prevention */
  sourceWorkflowId: string;

  /** Session ID for strict loop prevention Layer 1 */
  executionSessionId: string;
}

/**
 * Map action type → which typed queue to dispatch to.
 */
export function resolveQueueForAction(actionType: string): string {
  switch (actionType) {
    case 'send_email':
      return AUTOMATION_EMAIL_QUEUE;
    case 'send_sms':
      return AUTOMATION_SMS_QUEUE;
    case 'update_field':
    case 'route_to_team':
      return AUTOMATION_INTERNAL_QUEUE;
    case 'webhook':
      return AUTOMATION_WEBHOOK_QUEUE;
    default:
      return AUTOMATION_INTERNAL_QUEUE;
  }
}
