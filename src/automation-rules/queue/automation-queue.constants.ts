import { ExecutionPrincipal } from '../domain/execution-principal';
import { AutomationCrmModule } from '../events/automation-event.payload';

/**
 * Queue constants for the Automation Engine.
 *
 * Phase 4 Queue Architecture (5 queues):
 *   - automation-actions-email:     Email-specific, rate-limited for SendGrid
 *   - automation-actions-sms:       SMS-specific, rate-limited for Twilio (1/s)
 *   - automation-actions-internal:  UpdateField + RouteToGroup (fast, no external API)
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

/**
 * Trigger-evaluation queue.
 *
 * Trigger matching and DAG traversal used to run inline, un-awaited, on the
 * emitting process — so a `PATCH /contacts/:id` paid for the workflow lookup,
 * the loop-prevention Redis round-trips, the condition evaluation and the
 * execution-log writes of every matching workflow on its own event loop, after
 * the response had gone out. The 30s `Promise.race` bounded the promise, not the
 * CPU, and if the process died between the DB commit and the action dispatch the
 * automation was simply lost with nothing recording that it should have run.
 *
 * @see docs/audit/WORKFLOW_AUTOMATION_SECURITY_AUDIT.md — finding M5
 */
export const AUTOMATION_TRIGGER_QUEUE = 'automation-triggers';
export const AUTOMATION_DELAYED_QUEUE = 'automation-delayed-resume';

/**
 * Job names used within the automation action queues.
 * Each action type has a distinct name for observability in BullMQ dashboards.
 */
export enum AutomationJobName {
  SEND_EMAIL = 'automation.send-email',
  SEND_SMS = 'automation.send-sms',
  UPDATE_FIELD = 'automation.update-field',
  ROUTE_TO_TEAM = 'automation.route-to-team',
  WEBHOOK = 'automation.webhook',
  CREATE_TASK = 'automation.create-task',
  CREATE_TICKET = 'automation.create-ticket',
  ADD_TAG = 'automation.add-tag',
  REMOVE_TAG = 'automation.remove-tag',
  ADD_NOTE = 'automation.add-note',
  CREATE_RECORD = 'automation.create-record',
  HTTP_REQUEST = 'automation.http-request',
  SEND_WHATSAPP = 'automation.send-whatsapp',
  SEND_ZNS = 'automation.send-zns',
  SEND_LIVECHAT = 'automation.send-livechat',
  INTERNAL_NOTIFICATION = 'automation.internal-notification',
  DELAYED_RESUME = 'automation.delayed-resume',
}

/**
 * Canonical mapping from actionType → AutomationJobName.
 * Single source of truth — used by AutomationActionProducer.
 */
export function resolveJobNameForAction(actionType: string): AutomationJobName {
  const mapping: Record<string, AutomationJobName> = {
    send_email: AutomationJobName.SEND_EMAIL,
    send_sms: AutomationJobName.SEND_SMS,
    update_field: AutomationJobName.UPDATE_FIELD,
    route_to_group: AutomationJobName.ROUTE_TO_TEAM,
    webhook: AutomationJobName.WEBHOOK,
    create_task: AutomationJobName.CREATE_TASK,
    create_ticket: AutomationJobName.CREATE_TICKET,
    add_tag: AutomationJobName.ADD_TAG,
    remove_tag: AutomationJobName.REMOVE_TAG,
    add_note: AutomationJobName.ADD_NOTE,
    create_record: AutomationJobName.CREATE_RECORD,
    http_request: AutomationJobName.HTTP_REQUEST,
    send_whatsapp: AutomationJobName.SEND_WHATSAPP,
    send_zns: AutomationJobName.SEND_ZNS,
    send_livechat: AutomationJobName.SEND_LIVECHAT,
    internal_notification: AutomationJobName.INTERNAL_NOTIFICATION,
  };
  return mapping[actionType] ?? AutomationJobName.UPDATE_FIELD;
}

/**
 * One CRM event awaiting trigger evaluation.
 *
 * Carries the event, not a workflow: which workflows match is decided by the
 * worker, against the state of the world when it runs.
 */
export interface AutomationTriggerJobData {
  eventId?: string;
  tenantId: string;
  event: 'record_created' | 'field_updated';
  object: string;
  recordId: string;
  data: Record<string, any>;
  changedFields?: string[];
  automationDepth?: number;
  automationBreadcrumbs?: string[];
  _automationSourceWorkflowId?: string;
  triggerUserId?: string | null;
}

/**
 * Payload dispatched to the low-priority bulk queue when a tenant exceeds the
 * event-rate threshold.
 *
 * `tenantId` is at the TOP LEVEL deliberately: BaseTenantConsumer reads it from
 * `job.data.tenantId` to establish CLS before `handle()` runs and throws when it
 * is absent. The original payload nested the tenant inside `payload`, so every
 * bulk job failed its three attempts and died — silently losing all automation
 * for exactly the high-volume import this queue exists to absorb.
 *
 * `workflowId` is carried instead of the whole workflow document so the
 * processor re-reads the current published snapshot rather than executing a
 * definition that has been sitting in Redis.
 */
export interface AutomationBulkJobData {
  tenantId: string;
  workflowId: string;
  payload: {
    tenantId: string;
    event: string;
    object: string;
    recordId: string;
    [key: string]: any;
  };
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
    | 'route_to_group'
    | 'webhook'
    | 'create_task'
    | 'create_ticket'
    | 'add_tag'
    | 'remove_tag'
    | 'add_note'
    | 'create_record'
    | 'http_request'
    | 'send_whatsapp'
    | 'send_zns'
    | 'send_livechat'
    | 'internal_notification';

  /** Action-specific config set by the admin in the Visual Builder */
  actionConfig: Record<string, any>;

  /**
   * Who this action executes as.
   *
   * Optional so jobs enqueued before the principal existed still process (they
   * fall back to the system principal, which is what they were already doing).
   */
  principal?: ExecutionPrincipal;

  /** The record that triggered the workflow */
  recordId: string;
  recordType:
    | 'Lead'
    | 'Contact'
    | 'Ticket'
    | 'Deal'
    | 'Account'
    | 'Task'
    | 'Conversation'
    | 'Message';
  recordData: Record<string, any>;

  /** Automation depth for loop prevention Layer 2 */
  automationDepth: number;

  /** Workflow IDs already visited in this automation chain */
  automationBreadcrumbs?: string[];

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

  /** Workflow IDs already visited in this automation chain */
  automationBreadcrumbs?: string[];

  /** Source workflow ID for self-loop prevention */
  sourceWorkflowId: string;

  /** Session ID for strict loop prevention Layer 1 */
  executionSessionId: string;

  /** Principal the resumed actions execute as. See ExecutionPrincipal. */
  principal?: ExecutionPrincipal;

  /**
   * The workflow version this execution started on, and the graph it started on.
   *
   * Both are pinned here because `publish()` overwrites `publishedNodes` in
   * place. A wait node can hibernate for up to 90 days, and resume re-read the
   * CURRENT published snapshot — so a workflow edited during the wait resumed a
   * half-finished execution into a different graph, at a node id that might mean
   * something else or not exist. Carrying the graph lets an in-flight execution
   * finish on the version it began on, which is the whole point of publishing a
   * snapshot in the first place.
   *
   * Optional so delayed jobs written before this field existed still resume
   * (falling back to the live snapshot, with a warning).
   */
  workflowVersion?: number;
  publishedNodes?: any[];
  publishedEdges?: any[];
}

/**
 * Hot Redis queue payload for due delayed jobs.
 *
 * `delayedJobId` is present for the Mongo cold-storage implementation.
 * It is optional so legacy BullMQ delayed jobs created before the migration
 * continue to resume safely.
 */
export interface AutomationDelayedQueueJobData
  extends AutomationDelayedJobData {
  delayedJobId?: string;
}

/**
 * Map action type → which typed queue to dispatch to.
 */
export function resolveQueueForAction(actionType: string): string {
  switch (actionType) {
    case 'send_email':
      return AUTOMATION_EMAIL_QUEUE;
    case 'send_sms':
    case 'send_whatsapp':
    case 'send_zns':
    case 'send_livechat':
      return AUTOMATION_SMS_QUEUE;
    case 'update_field':
    case 'route_to_group':
    case 'create_task':
    case 'create_ticket':
    case 'add_tag':
    case 'remove_tag':
    case 'add_note':
    case 'create_record':
    case 'internal_notification':
      return AUTOMATION_INTERNAL_QUEUE;
    case 'webhook':
    case 'http_request':
      return AUTOMATION_WEBHOOK_QUEUE;
    default:
      return AUTOMATION_INTERNAL_QUEUE;
  }
}
