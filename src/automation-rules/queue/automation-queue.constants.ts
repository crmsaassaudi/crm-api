/**
 * Queue constants for the Automation Engine.
 * Separate queue for automation actions to isolate from other system queues.
 */
export const AUTOMATION_ACTION_QUEUE = 'automation-actions';

/**
 * Job names used within the automation action queue.
 */
export enum AutomationJobName {
  SEND_EMAIL = 'automation.send-email',
  SEND_SMS = 'automation.send-sms',
  UPDATE_FIELD = 'automation.update-field',
  ROUTE_TO_TEAM = 'automation.route-to-team',
}

/**
 * Payload dispatched to the automation action queue.
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
  actionType: 'send_email' | 'send_sms' | 'update_field' | 'route_to_team';

  /** Action-specific config set by the admin in the Visual Builder */
  actionConfig: Record<string, any>;

  /** The record that triggered the workflow */
  recordId: string;
  recordType: 'Lead' | 'Contact' | 'Ticket';
  recordData: Record<string, any>;

  /** Automation depth for loop prevention Layer 2 */
  automationDepth: number;

  /** Source workflow ID for self-loop prevention */
  sourceWorkflowId: string;
}
